import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { buildTimeline, parseLineLog, postImage } from '../src/index.js';

// Recorded from angular/angular at ff0dbf1:
// git log -L38,48:packages/core/src/sanitization/url_sanitizer.ts --format=<LOG_FORMAT>
const fixture = readFileSync(new URL('./fixtures/url_sanitizer_38_48.log', import.meta.url), 'utf8');

describe('parseLineLog on the Angular URL sanitizer', () => {
  const commits = parseLineLog(fixture);

  test('finds every commit, newest first, with full metadata', () => {
    expect(commits).toHaveLength(19);
    expect(commits[0]!.commit).toMatchObject({
      sha: 'fc9b2d64e32bf48d9782e0a679060f36cc9a1dc2',
      date: '2026-09-30T00:15:20+00:00',
      author: 'Andrew Scott',
    });
    expect(commits[0]!.commit.message).toBe(
      'Revert "fix(core): block dangerous data: and vbscript: URLs in URL sanitizer"\n\n' +
        'This reverts commit e96936a57fe4f07f8155e5a500cec5adeb6341be.',
    );
    expect(commits.at(-1)!.commit.sha.slice(0, 7)).toBe('908a102');
  });

  test('keeps multi-paragraph commit messages intact', () => {
    const extend = commits.find((c) => c.commit.sha.startsWith('2b89a3b'))!;
    expect(extend.commit.message).toContain('This maintains the allowlist architecture');
    expect(extend.commit.message).not.toContain('diff --git');
  });

  test('post-image of the newest commit is the range at HEAD', () => {
    const { lines, added } = postImage(commits[0]!.hunks);
    expect(lines).toHaveLength(11);
    expect(lines[0]).toBe('const SAFE_URL_PATTERN = /^(?!javascript:)(?:[a-z0-9+.-]+:|[^&:\\/?#]*(?:[\\/?#]|$))/i;');
    expect(lines.at(-1)).toBe('}');
    expect(added).toEqual([1]);
    expect(commits[0]!.hunks[0]).toMatchObject({ oldStart: 47, oldCount: 12, newStart: 38, newCount: 11 });
  });

  test('marks the first commit as creating the file', () => {
    expect(commits.at(-1)!.created).toBe(true);
    expect(commits[0]!.created).toBe(false);
  });
});

describe('buildTimeline', () => {
  const timeline = buildTimeline(parseLineLog(fixture).reverse(), {
    file: 'packages/core/src/sanitization/url_sanitizer.ts',
    range: [38, 48],
    head: 'ff0dbf1cd4',
  });

  test('orders steps oldest first and skips the lint re-format', () => {
    expect(timeline.steps).toHaveLength(18);
    expect(timeline.skipped).toBe(1);
    expect(timeline.noise).toMatchObject([{ reason: 'whitespace' }]);
    expect(timeline.noise[0]!.commit.message).toMatch(/^style\(lint\): re-format/);
    expect(timeline.steps[0]!.commit.sha.slice(0, 7)).toBe('908a102');
    expect(timeline.steps.at(-1)!.commit.sha.slice(0, 7)).toBe('fc9b2d6');
  });

  test('the first step adds every line it shows', () => {
    const first = timeline.steps[0]!;
    const lineCount = first.snapshot.split('\n').length;
    expect(first.addedLines).toEqual(Array.from({ length: lineCount }, (_, i) => i + 1));
    expect(first.removedLines).toEqual([]);
  });

  test('a revert step records what it removed', () => {
    const revert = timeline.steps.at(-1)!;
    expect(revert.removedLines).toEqual([
      'const SAFE_URL_PATTERN =',
      '  /^(?!javascript:)(?!vbscript:)(?!data:(?!image\\/|video\\/|audio\\/))(?:[a-z0-9+.-]+:|[^&:\\/?#]*(?:[\\/?#]|$))/i;',
    ]);
    expect(revert.startLine).toBe(38);
    expect(revert.reviews).toEqual([]);
  });

  test('keepNoise keeps every commit', () => {
    const all = buildTimeline(parseLineLog(fixture).reverse(), {
      file: 'f',
      range: [38, 48],
      head: 'h',
      keepNoise: true,
    });
    expect(all.steps).toHaveLength(19);
    expect(all.skipped).toBe(0);
  });
});

describe('parseLineLog edge cases', () => {
  test('a removed line that looks like a file header stays a removed line', () => {
    const output =
      '\x1eARCH-COMMIT\nabc\n2024-01-01T00:00:00Z\nA\nmsg\x1f\n\n' +
      'diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -1,2 +1,2 @@\n--- not a header\n+new\n same\n';
    const [entry] = parseLineLog(output);
    expect(entry!.hunks[0]!.lines).toEqual([
      { kind: 'removed', text: '-- not a header' },
      { kind: 'added', text: 'new' },
      { kind: 'context', text: 'same' },
    ]);
  });

  test('a commit message containing diff-like text is not parsed as a diff', () => {
    const output =
      '\x1eARCH-COMMIT\nabc\n2024-01-01T00:00:00Z\nA\nfix: thing\n\n@@ -1 +1 @@\n-old\x1f\n\n' +
      'diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -3 +3 @@\n-x\n+y\n';
    const [entry] = parseLineLog(output);
    expect(entry!.commit.message).toBe('fix: thing\n\n@@ -1 +1 @@\n-old');
    expect(entry!.hunks).toHaveLength(1);
    expect(entry!.hunks[0]).toMatchObject({ oldStart: 3, oldCount: 1, newStart: 3, newCount: 1 });
  });
});
