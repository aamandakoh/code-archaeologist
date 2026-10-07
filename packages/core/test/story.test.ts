import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import {
  buildStoryPrompt,
  buildTimeline,
  geminiClient,
  LIMITS,
  parseLineLog,
  parseStory,
  StoryCache,
  trimDiff,
  writeStory,
  type ModelClient,
  type Timeline,
} from '../src/index.js';

// Same recording as lineLog.test.ts: angular/angular at ff0dbf1, url_sanitizer.ts lines 38-48.
const fixture = readFileSync(new URL('./fixtures/url_sanitizer_38_48.log', import.meta.url), 'utf8');
const timeline: Timeline = buildTimeline(parseLineLog(fixture).reverse(), {
  file: 'packages/core/src/sanitization/url_sanitizer.ts',
  range: [38, 48],
  head: 'ff0dbf1cd4',
});

const answer = (overrides: object = {}) =>
  JSON.stringify({
    summary: 'Angular loosened its URL sanitizer, tightened it, then reverted.',
    steps: [
      { commit: 'b35fa73', note: 'Only javascript: is blocked now.', citations: ['commit:b35fa73', 'pr:49659'] },
      { commit: 'fc9b2d6', note: 'No reason recorded.', citations: ['commit:fc9b2d6'] },
      { commit: 'e96936a', note: 'Made up.', citations: ['pr:1', 'issue:42'] },
    ],
    verdict: {
      level: 'HIGH',
      reasons: [
        { text: 'A security fix (commit:e96936a57fe) was reverted, see pr:49659.', citations: ['fc9b2d64e32b', '#49659'] },
        { text: 'Invented.', citations: ['commit:deadbee'] },
      ],
      checks: ['Read the revert discussion first.'],
    },
    ...overrides,
  });

describe('buildStoryPrompt', () => {
  test('includes every commit with its id and the trimmed diff', () => {
    const prompt = buildStoryPrompt(timeline);
    expect(prompt.reduced).toBe(0);
    for (const step of timeline.steps) expect(prompt.user).toContain(`commit:${step.commit.sha.slice(0, 7)}`);
    expect(prompt.ids).toContain('pr:49659');
    expect(prompt.user).not.toContain('diff --git');
    expect(prompt.user).toContain('const SAFE_URL_PATTERN');
  });

  test('reduces the middle commits when the history is long', () => {
    const prompt = buildStoryPrompt(timeline, { ...LIMITS, fullCommits: 10, fullOldest: 3 });
    expect(prompt.reduced).toBe(timeline.steps.length - 10);
    expect(prompt.user.match(/\[reduced\]/g)).toHaveLength(timeline.steps.length - 10);
  });

  test('reduces more commits to stay within the character budget', () => {
    const prompt = buildStoryPrompt(timeline, { ...LIMITS, maxChars: 8_000 });
    expect(prompt.reduced).toBeGreaterThan(0);
    // The first and last commits always stay in full.
    expect(prompt.user).toMatch(/commit:908a102[^\n]*\nMessage:/);
    expect(prompt.user).toMatch(/commit:fc9b2d6[^\n]*\nMessage:/);
  });
});

test('trimDiff drops file headers and caps the lines', () => {
  const diff = 'diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1,3 +1,3 @@\n-a\n+b\n c\n d\n';
  expect(trimDiff(diff, 10)).toBe('@@ -1,3 +1,3 @@\n-a\n+b\n c\n d');
  expect(trimDiff(diff, 2)).toBe('@@ -1,3 +1,3 @@\n-a\n… 3 more diff lines not shown');
});

describe('parseStory', () => {
  const prompt = buildStoryPrompt(timeline);

  test('keeps valid citations, normalises their form and orders notes by the timeline', () => {
    const story = parseStory(answer(), timeline, prompt, 'test-model');
    expect(story.verdict.level).toBe('high');
    expect(story.steps.map((s) => s.commit.slice(0, 7))).toEqual(['b35fa73', 'e96936a', 'fc9b2d6']);
    expect(story.steps[0]).toEqual({
      commit: expect.stringMatching(/^b35fa73/),
      note: 'Only javascript: is blocked now.',
      citations: ['commit:b35fa73', 'pr:49659'],
    });
    expect(story.verdict.reasons[0]).toEqual({ text: 'A security fix (e96936a) was reverted, see #49659.', citations: ['commit:fc9b2d6', 'pr:49659'] });
    expect(story.model).toBe('test-model');
  });

  test('drops citations that match no evidence and flags the claim', () => {
    const story = parseStory(answer(), timeline, prompt, 'm');
    expect(story.steps[1]).toMatchObject({ note: 'Made up.', citations: [], flagged: true });
    expect(story.verdict.reasons[1]).toMatchObject({ citations: [], flagged: true });
  });

  test('adds the PR a commit message names to that commit\'s note', () => {
    const steps = [{ commit: 'fc5c34d', note: 'Allowed sms: URLs.', citations: ['commit:fc5c34d'] }];
    const story = parseStory(answer({ steps }), timeline, prompt, 'm');
    expect(story.steps[0]!.citations).toEqual(['commit:fc5c34d', 'pr:31463']);
  });

  test('accepts JSON wrapped in a code fence', () => {
    expect(parseStory('```json\n' + answer() + '\n```', timeline, prompt, 'm').summary).toMatch(/reverted/);
  });

  test('rejects answers that are not JSON or have the wrong shape', () => {
    expect(() => parseStory('Sure! Here is', timeline, prompt, 'm')).toThrow(/valid JSON/);
    expect(() => parseStory(answer({ verdict: { level: 'extreme', reasons: [], checks: [] } }), timeline, prompt, 'm')).toThrow(
      /wrong shape/,
    );
  });
});

describe('geminiClient', () => {
  const prompt = buildStoryPrompt(timeline);
  const ok = (text: string) =>
    new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] }), { status: 200 });

  test('sends the prompt with a JSON schema and returns the text', async () => {
    const fetch = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => ok('{"a":1}'));
    const client = geminiClient({ apiKey: 'k', model: 'gemini-x', fetch: fetch as typeof globalThis.fetch });
    expect(await client.generate(prompt)).toBe('{"a":1}');
    const [url, init] = fetch.mock.calls[0]!;
    expect(String(url)).toContain('/models/gemini-x:generateContent');
    expect((init!.headers as Record<string, string>)['x-goog-api-key']).toBe('k');
    const body = JSON.parse(String(init!.body));
    expect(body.generationConfig.responseMimeType).toBe('application/json');
    expect(body.generationConfig.thinkingConfig).toEqual({ thinkingLevel: 'low' });
  });

  test('retries when the model is overloaded', async () => {
    vi.useFakeTimers();
    try {
      const busy = () => new Response(JSON.stringify({ error: { message: 'high demand' } }), { status: 503 });
      const fetch = vi.fn().mockResolvedValueOnce(busy()).mockResolvedValueOnce(ok('{}'));
      const pending = geminiClient({ apiKey: 'k', fetch }).generate(prompt);
      await vi.runAllTimersAsync();
      expect(await pending).toBe('{}');
      expect(fetch).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  test('does not retry a used-up daily quota', async () => {
    const message =
      'You exceeded your current quota, please check your plan and billing details.\n* Quota exceeded for metric: generate_content_free_tier_requests, limit: 20, model: gemini-3.5-flash\nPlease retry in 9h23m44.781424344s.';
    const fetch = vi.fn(async () => new Response(JSON.stringify({ error: { message } }), { status: 429 }));
    await expect(geminiClient({ apiKey: 'k', fetch }).generate(prompt)).rejects.toThrow(/daily quota for gemini-3.5-flash is used up; it resets in 9h23m44s/);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  test('explains a wrong model name', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ error: { message: 'not found' } }), { status: 404 }));
    await expect(geminiClient({ apiKey: 'k', model: 'nope', fetch }).generate(prompt)).rejects.toThrow(/404.*model name/);
  });
});

test('writeStory caches by prompt and model', async () => {
  const cache = new StoryCache(mkdtempSync(path.join(tmpdir(), 'archaeologist-story-')));
  const client: ModelClient = { model: 'fake', generate: vi.fn(async () => answer()) };
  const first = await writeStory(timeline, { client, cache });
  const second = await writeStory(timeline, { client, cache });
  expect(second).toEqual(first);
  expect(client.generate).toHaveBeenCalledTimes(1);
});
