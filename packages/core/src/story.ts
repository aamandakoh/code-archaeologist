import { z } from 'zod';
import type { Step, Story, Timeline } from './types.js';
import type { StoryCache } from './cache.js';

/** Bump when the prompt or the Story shape changes, so cached stories are regenerated. */
export const STORY_VERSION = 1;

/** Limits on what goes to the model. Roughly 4 characters per token, so about 30k tokens. */
export const LIMITS = {
  maxChars: 120_000,
  diffLines: 60,
  messageChars: 1_500,
  prBodyChars: 1_500,
  reviewChars: 500,
  reviewsPerStep: 5,
  /** Above this many commits, the middle ones are reduced to message subject plus PR title. */
  fullCommits: 25,
  /** How many of the oldest commits stay in full when the middle is reduced. */
  fullOldest: 5,
};

const SYSTEM = `You are Code Archaeologist. You explain how a piece of code evolved and whether it is safe to change, using only the evidence you are given.

Rules:
- Explain what changed and why, from the evidence only. If the evidence gives no reason for a change, say "No reason recorded." and cite the commit. Never guess a motive. A revert whose message only names the reverted commit has no recorded reason.
- Every note and every verdict reason cites at least one id exactly as written in the evidence, such as "commit:b35fa73" or "pr:49659". When a commit names a pull request, review or issue, cite that too. Never invent ids.
- Write one note per commit, in the same order as the evidence, using its short hash in "commit". Commits marked [reduced] get a short note from their subject alone.
- Notes are at most 2 sentences, plain words, no markdown.
- "summary" is one sentence on how these lines got to where they are today and what that means for someone about to change them. Do not just describe what the code does.
- The verdict level is low, medium or high risk to change. Raise it for security fixes, reverts, a change made and then undone, tests added alongside a change, or code labelled as taken from another library.
- Give 3 to 5 verdict reasons, most important first, each citing the specific commits it rests on. Name concrete events (a fix that was reverted, a behaviour that was loosened), not general statements.
- Give 2 to 4 concrete "checks" to do before changing the code.`;

/** JSON schema for Gemini's structured output. Validated again with zod below. */
const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    steps: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          commit: { type: 'string' },
          note: { type: 'string' },
          citations: { type: 'array', items: { type: 'string' } },
        },
        required: ['commit', 'note', 'citations'],
      },
    },
    verdict: {
      type: 'object',
      properties: {
        level: { type: 'string', enum: ['low', 'medium', 'high'] },
        reasons: {
          type: 'array',
          items: {
            type: 'object',
            properties: { text: { type: 'string' }, citations: { type: 'array', items: { type: 'string' } } },
            required: ['text', 'citations'],
          },
        },
        checks: { type: 'array', items: { type: 'string' } },
      },
      required: ['level', 'reasons', 'checks'],
    },
  },
  required: ['summary', 'steps', 'verdict'],
} as const;

const ModelOutput = z.object({
  summary: z.string().min(1),
  steps: z.array(z.object({ commit: z.string(), note: z.string(), citations: z.array(z.string()).default([]) })),
  verdict: z.object({
    level: z.preprocess((v) => (typeof v === 'string' ? v.toLowerCase() : v), z.enum(['low', 'medium', 'high'])),
    reasons: z.array(z.object({ text: z.string(), citations: z.array(z.string()).default([]) })).min(1),
    checks: z.array(z.string()).default([]),
  }),
});

export type StoryPrompt = {
  system: string;
  user: string;
  /** JSON schema the model's reply must follow. */
  schema: object;
  /** Every id the model may cite, e.g. "commit:b35fa73", "pr:49659". */
  ids: string[];
  /** Commits sent as message subject only, because the history was too long. */
  reduced: number;
};

/** Builds the single prompt for a timeline, within LIMITS. Pure, so it is unit-tested. */
export function buildStoryPrompt(timeline: Timeline, limits = LIMITS): StoryPrompt {
  const steps = timeline.steps;
  const ids = new Set<string>();
  for (const step of steps) for (const id of evidenceIds(step)) ids.add(id);

  // Which steps go in full. Over the commit cap, keep the oldest few and the newest.
  const full = steps.map(() => true);
  if (steps.length > limits.fullCommits) {
    const newest = limits.fullCommits - limits.fullOldest;
    steps.forEach((_, i) => (full[i] = i < limits.fullOldest || i >= steps.length - newest));
  }

  const render = () => {
    const header = [
      `File: ${timeline.file}, lines ${timeline.range[0]}-${timeline.range[1]} at HEAD ${timeline.head.slice(0, 7)}.`,
      `${steps.length} commits touched these lines, oldest first.${timeline.skipped ? ` ${timeline.skipped} whitespace or formatting commits were left out.` : ''}`,
      '',
      'The lines today:',
      '```',
      steps.at(-1)?.snapshot ?? '',
      '```',
      '',
      'Evidence, oldest first:',
    ];
    const body = steps.map((step, i) => (full[i] ? renderFull(step, limits) : renderReduced(step)));
    return [...header, ...body].join('\n');
  };

  // Still too long: reduce more commits, working outward from the middle.
  let user = render();
  const order = steps.map((_, i) => i).sort((a, b) => Math.abs(a - steps.length / 2) - Math.abs(b - steps.length / 2));
  for (const i of order) {
    if (user.length <= limits.maxChars) break;
    if (!full[i] || i === 0 || i === steps.length - 1) continue;
    full[i] = false;
    user = render();
  }

  return { system: SYSTEM, user, schema: RESPONSE_SCHEMA, ids: [...ids], reduced: full.filter((f) => !f).length };
}

function renderFull(step: Step, limits: typeof LIMITS): string {
  const c = step.commit;
  const out = [
    '',
    `## commit:${short(c.sha)} · ${c.date.slice(0, 10)} · ${c.author}`,
    'Message:',
    clip(c.message.trim(), limits.messageChars),
  ];
  if (step.pr) {
    out.push(`PR pr:${step.pr.number}: ${step.pr.title}`);
    if (step.pr.body.trim()) out.push(`PR description: ${clip(step.pr.body.trim(), limits.prBodyChars)}`);
  }
  step.reviews.slice(0, limits.reviewsPerStep).forEach((review, i) => {
    out.push(`Review review:${short(c.sha)}-${i + 1} by ${review.author}: ${clip(review.body.trim(), limits.reviewChars)}`);
  });
  for (const issue of step.issues) out.push(`Issue issue:${issue.number}: ${issue.title}`);
  out.push('Diff of the traced lines:', '```diff', trimDiff(step.diff, limits.diffLines), '```');
  return out.join('\n');
}

function renderReduced(step: Step): string {
  const c = step.commit;
  const subject = c.message.split('\n')[0] ?? '';
  const pr = step.pr ? ` (PR pr:${step.pr.number}: ${step.pr.title})` : '';
  return `\n## commit:${short(c.sha)} · ${c.date.slice(0, 10)} · ${c.author} [reduced]\n${subject}${pr}`;
}

/** Ids the model may cite for one step. PR and issue numbers written in the message count too. */
function evidenceIds(step: Step): string[] {
  const ids = [`commit:${short(step.commit.sha)}`];
  if (step.pr) ids.push(`pr:${step.pr.number}`);
  for (const m of step.commit.message.matchAll(/(?:^|[\s(])#(\d+)\b/g)) ids.push(`pr:${m[1]}`);
  step.reviews.forEach((_, i) => ids.push(`review:${short(step.commit.sha)}-${i + 1}`));
  for (const issue of step.issues) ids.push(`issue:${issue.number}`);
  return ids;
}

/** Keeps only the hunk lines of a diff (no file headers), at most `max` lines. */
export function trimDiff(diff: string, max: number): string {
  const lines = diff.split('\n').filter((l) => !/^(diff --git|index |--- |\+\+\+ )/.test(l));
  while (lines.length > 0 && lines.at(-1) === '') lines.pop();
  if (lines.length <= max) return lines.join('\n');
  return [...lines.slice(0, max), `… ${lines.length - max} more diff lines not shown`].join('\n');
}

/**
 * Validates the model's JSON and checks its citations against the evidence. Citations that
 * match nothing are dropped; a note or reason left with none is flagged as unverified.
 */
export function parseStory(text: string, timeline: Timeline, prompt: StoryPrompt, model: string): Story {
  let json: unknown;
  try {
    json = JSON.parse(stripFences(text));
  } catch {
    throw new StoryError('The model did not return valid JSON.');
  }
  const parsed = ModelOutput.safeParse(json);
  if (!parsed.success) throw new StoryError(`The model's answer had the wrong shape: ${parsed.error.issues[0]?.message ?? 'unknown'}`);
  const out = parsed.data;

  const known = new Set(prompt.ids);
  const shas = timeline.steps.map((s) => s.commit.sha);
  const fullSha = (ref: string) => {
    const hex = ref.trim().toLowerCase();
    if (hex.length < 4 || !/^[0-9a-f]+$/.test(hex)) return undefined;
    return shas.find((sha) => sha.startsWith(hex));
  };
  const normalize = (citation: string): string | undefined => {
    const c = citation.trim().replace(/^#/, 'pr:');
    const [kind, ref = ''] = c.includes(':') ? [c.slice(0, c.indexOf(':')).toLowerCase(), c.slice(c.indexOf(':') + 1)] : ['commit', c];
    if (kind === 'commit') {
      const sha = fullSha(ref);
      return sha ? `commit:${short(sha)}` : undefined;
    }
    const id = `${kind}:${ref.trim().replace(/^#/, '')}`;
    return known.has(id) ? id : undefined;
  };
  const check = (citations: string[]) => {
    const kept = [...new Set(citations.map(normalize).filter((c): c is string => c !== undefined))];
    return { citations: kept, flagged: kept.length === 0 };
  };

  // One note per timeline step, matched by hash; the model's order is not trusted.
  const notes = new Map<string, Story['steps'][number]>();
  for (const step of out.steps) {
    const sha = fullSha(step.commit.replace(/^commit:/i, ''));
    if (!sha || notes.has(sha) || !step.note.trim()) continue;
    const { citations, flagged } = check(step.citations);
    notes.set(sha, { commit: sha, note: step.note.trim(), citations, ...(flagged && { flagged }) });
  }

  return {
    summary: out.summary.trim(),
    steps: shas.flatMap((sha) => notes.get(sha) ?? []),
    verdict: {
      level: out.verdict.level,
      reasons: out.verdict.reasons.slice(0, 5).map((r) => {
        const { citations, flagged } = check(r.citations);
        return { text: r.text.trim(), citations, ...(flagged && { flagged }) };
      }),
      checks: out.verdict.checks.map((c) => c.trim()).filter(Boolean).slice(0, 5),
    },
    model,
    reduced: prompt.reduced,
  };
}

export class StoryError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'StoryError';
  }
}

/** Sends one prompt and resolves with the model's raw text. Swappable for tests and other providers. */
export type ModelClient = { model: string; generate(prompt: StoryPrompt, signal?: AbortSignal): Promise<string> };

export type GeminiOptions = {
  apiKey: string;
  model?: string;
  /** Per attempt. A full timeline takes 20-120 seconds on the free tier, more when it is busy. */
  timeoutMs?: number;
  /** Gemini 3 thinking level. Low keeps a trace fast without hurting the notes. */
  thinkingLevel?: 'low' | 'medium' | 'high' | 'off';
  /** Extra attempts after a 429, a 5xx or a timeout. */
  retries?: number;
  fetch?: typeof fetch;
};

export const DEFAULT_MODEL = 'gemini-3.5-flash';

/** Google AI Studio's REST API, called with plain fetch so there is no SDK to bundle. */
export function geminiClient(options: GeminiOptions): ModelClient {
  const model = options.model?.trim() || DEFAULT_MODEL;
  const doFetch = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 180_000;
  let thinkingLevel = options.thinkingLevel ?? 'low';
  const retries = options.retries ?? 3;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;

  return {
    model,
    async generate(prompt, signal) {
      const body = () =>
        JSON.stringify({
          systemInstruction: { parts: [{ text: prompt.system }] },
          contents: [{ role: 'user', parts: [{ text: prompt.user }] }],
          generationConfig: {
            temperature: 0.2,
            responseMimeType: 'application/json',
            responseJsonSchema: prompt.schema,
            ...(thinkingLevel !== 'off' && { thinkingConfig: { thinkingLevel } }),
          },
        });

      for (let attempt = 0; ; attempt++) {
        const timeout = AbortSignal.timeout(timeoutMs);
        let response: Response;
        try {
          response = await doFetch(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-goog-api-key': options.apiKey },
            body: body(),
            signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
          });
        } catch (error) {
          if (signal?.aborted) throw error;
          if (timeout.aborted && attempt < Math.min(retries, 1)) continue; // a slow model rarely speeds up
          const reason = timeout.aborted ? `no answer within ${Math.round(timeoutMs / 1000)}s` : String(error);
          throw new StoryError(`Could not reach Gemini (${model}): ${reason}`, { cause: error });
        }

        if (response.ok) {
          const data = (await response.json()) as GeminiResponse;
          const candidate = data.candidates?.[0];
          const text = candidate?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
          if (!text) {
            const why = data.promptFeedback?.blockReason ?? candidate?.finishReason ?? 'empty answer';
            throw new StoryError(`Gemini (${model}) returned no story: ${why}`);
          }
          return text;
        }

        const detail = await errorMessage(response);
        if (response.status === 400 && thinkingLevel !== 'off' && /thinking/i.test(detail)) {
          thinkingLevel = 'off'; // older models have no thinking level
          attempt--;
          continue;
        }
        const retryable = response.status === 429 || response.status >= 500;
        if (retryable && attempt < retries) {
          await sleep(2_000 * 2 ** attempt, signal);
          continue;
        }
        const hint =
          response.status === 400 && /api key/i.test(detail)
            ? ' Check the Gemini API key.'
            : response.status === 404
              ? ' Check the model name in the codeArchaeologist.model setting.'
              : response.status === 429
                ? ' The free tier is rate limited; try again in a minute.'
                : '';
        throw new StoryError(`Gemini (${model}) answered ${response.status}: ${detail}.${hint}`);
      }
    },
  };
}

type GeminiResponse = {
  candidates?: { content?: { parts?: { text?: string }[] }; finishReason?: string }[];
  promptFeedback?: { blockReason?: string };
};

async function errorMessage(response: Response): Promise<string> {
  const text = await response.text().catch(() => '');
  try {
    return (JSON.parse(text) as { error?: { message?: string } }).error?.message ?? text.slice(0, 200);
  } catch {
    return text.slice(0, 200) || response.statusText;
  }
}

export type WriteStoryOptions = {
  client: ModelClient;
  /** When given, the same prompt and model reuse the stored story. */
  cache?: StoryCache;
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
};

/** Builds the prompt, asks the model once, and returns a validated, citation-checked story. */
export async function writeStory(timeline: Timeline, options: WriteStoryOptions): Promise<Story> {
  if (timeline.steps.length === 0) throw new StoryError('No commits to explain.');
  const prompt = buildStoryPrompt(timeline);
  const key = { version: STORY_VERSION, model: options.client.model, prompt: `${prompt.system}\n${prompt.user}` };
  const cached = await options.cache?.get(key);
  if (cached) return cached;

  options.onProgress?.('Writing the story');
  const text = await options.client.generate(prompt, options.signal);
  const story = parseStory(text, timeline, prompt, options.client.model);
  await options.cache?.set(key, story);
  return story;
}

function short(sha: string): string {
  return sha.slice(0, 7);
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

function stripFences(text: string): string {
  return text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(signal.reason);
    }, { once: true });
  });
}
