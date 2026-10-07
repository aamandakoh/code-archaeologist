import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  addGitHubContext,
  buildStoryPrompt,
  buildTimeline,
  GitHubCache,
  linkedRefs,
  parseLineLog,
  prFromMessage,
  stripTemplate,
  type Timeline,
} from '../src/index.js';
import { angularRoutes, fakeGitHub } from './fixtures/github.js';

const fixture = readFileSync(new URL('./fixtures/url_sanitizer_38_48.log', import.meta.url), 'utf8');
const timeline: Timeline = {
  ...buildTimeline(parseLineLog(fixture).reverse(), {
    file: 'packages/core/src/sanitization/url_sanitizer.ts',
    range: [38, 48],
    head: 'ff0dbf1cd4',
  }),
  github: { owner: 'angular', repo: 'angular' },
};
const step = (t: Timeline, sha: string) => t.steps.find((s) => s.commit.sha.startsWith(sha))!;
const repo = { owner: 'angular', repo: 'angular' };

describe('prFromMessage', () => {
  test('reads the PR number merge tools write', () => {
    expect(prFromMessage('feat(core): x (#49659)\n\nbody')).toBe(49659);
    expect(prFromMessage('feat(core): x\n\nbody\n\nPR Close #49659')).toBe(49659);
    expect(prFromMessage('Merge pull request #12 from a/b')).toBe(12);
    expect(prFromMessage('fix: see #12 for context')).toBeUndefined();
  });
});

describe('linkedRefs', () => {
  test('finds fixed issues and reverted PRs', () => {
    expect(linkedRefs('Fixes #31462\nCloses angular/angular#7 and resolves https://github.com/angular/angular/issues/8', repo)).toEqual([
      { number: 31462, relation: 'fixes' },
      { number: 7, relation: 'fixes' },
      { number: 8, relation: 'fixes' },
    ]);
    expect(linkedRefs('Reverts angular/angular#67692', repo)).toEqual([{ number: 67692, relation: 'reverts' }]);
    expect(linkedRefs('This reverts commit e96936a57fe4f07f8155e5a500cec5adeb6341be.', repo, () => 67692)).toEqual([
      { number: 67692, relation: 'reverts' },
    ]);
    expect(linkedRefs('<!-- Fixes #1 -->\n- [ ] Fixes #2\nmentions #3\n\nPR Close #4', repo)).toEqual([]);
  });

  test('strips PR template noise', () => {
    expect(stripTemplate('<!-- hi -->\n## Checklist\n- [x] tests\n\nReal text')).toBe('## Checklist\n\nReal text');
  });
});

describe('addGitHubContext', () => {
  test('finds PRs from messages and from the commit endpoint, and the reason for the revert', async () => {
    const { fetch, calls } = fakeGitHub(angularRoutes);
    const out = await addGitHubContext(timeline, { fetch, token: 'tok' });

    // Messages with "PR Close #n" need no lookup; the 2026 commits have no number and do.
    expect(calls.some((c) => c.route.startsWith('/commits/b35fa73'))).toBe(false);
    expect(calls.some((c) => c.route.startsWith('/commits/e96936a'))).toBe(true);
    expect(calls.every((c) => c.auth === 'Bearer tok')).toBe(true);

    expect(step(out, 'b35fa73').pr?.number).toBe(49659);
    expect(step(out, 'e96936a').pr?.number).toBe(67692);
    expect(step(out, 'e96936a').pr?.body).not.toContain('PR Checklist\n- [x]');
    expect(step(out, 'e96936a').reviews.map((r) => r.author)).toEqual(['josephperrott', 'alan-agius4', 'alan-agius4', 'KevinZhao', 'atscott']);

    const revert = step(out, 'fc9b2d6');
    expect(revert.pr?.number).toBe(71064);
    expect(revert.issues).toEqual([expect.objectContaining({ number: 67692, kind: 'pr', relation: 'reverts' })]);
    expect(revert.reviews[0]).toMatchObject({ author: 'atscott', on: 67692 });
    expect(revert.reviews[0]!.body).toContain('test failures in g3');

    expect(step(out, 'fc5c34d').issues).toEqual([expect.objectContaining({ number: 31462, kind: 'issue', relation: 'fixes' })]);
    expect(out.context).toEqual({ token: true, prs: expect.any(Number), reviews: expect.any(Number), issues: 2 });
    expect(out.context?.error).toBeUndefined();
    expect(timeline.steps[0]!.reviews).toEqual([]); // input untouched
  });

  test('the prompt carries the revert discussion as citable evidence', async () => {
    const { fetch } = fakeGitHub(angularRoutes);
    const prompt = buildStoryPrompt(await addGitHubContext(timeline, { fetch }));
    expect(prompt.user).toContain('Review review:fc9b2d6-1 by atscott (on reverted PR pr:67692, 2026-09-30): Reverting due to test failures in g3');
    expect(prompt.user).toContain('Reverts pr:67692: fix(core): block dangerous data: and vbscript: URLs');
    expect(prompt.user).toContain('Fixes issue issue:31462: Allow sms: URLs');
    expect(prompt.ids).toEqual(expect.arrayContaining(['pr:71064', 'review:fc9b2d6-1', 'issue:31462', 'pr:67692']));
  });

  test('a rate limit keeps what was found and says why the rest is missing', async () => {
    const { fetch } = fakeGitHub(angularRoutes, { status: (route) => (route.startsWith('/pulls/') ? 403 : undefined) });
    const out = await addGitHubContext(timeline, { fetch });
    expect(out.steps).toHaveLength(timeline.steps.length);
    expect(out.context?.error).toMatch(/rate limit.*token raises the limit/);
    expect(out.context?.token).toBe(false);
  });

  test('a cache makes the second run free', async () => {
    const cache = new GitHubCache(mkdtempSync(path.join(tmpdir(), 'gh-cache-')));
    const first = fakeGitHub(angularRoutes);
    const a = await addGitHubContext(timeline, { fetch: first.fetch, cache });
    const second = fakeGitHub(angularRoutes);
    const b = await addGitHubContext(timeline, { fetch: second.fetch, cache });
    expect(first.calls.length).toBeGreaterThan(0);
    expect(second.calls).toHaveLength(0);
    expect(b.steps).toEqual(a.steps);
  });

  test('does nothing without a GitHub remote', async () => {
    const { fetch, calls } = fakeGitHub(angularRoutes);
    const out = await addGitHubContext({ ...timeline, github: undefined }, { fetch });
    expect(out.context).toBeUndefined();
    expect(calls).toHaveLength(0);
  });
});
