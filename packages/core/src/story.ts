import { z } from 'zod';
import type { LinkedIssue, Step, Story, Timeline } from './types.js';
import { prFromMessage } from './github.js';
import { mrFromMessage } from './gitlab.js';
import type { StoryCache } from './cache.js';

/** Bump when the prompt or the Story shape changes, so cached stories are regenerated. */
export const STORY_VERSION = 3;

/** Limits on what goes to the model. Roughly 4 characters per token, so about 30k tokens. */
export const LIMITS = {
  maxChars: 120_000,
  diffLines: 60,
  messageChars: 1_500,
  prBodyChars: 1_500,
  reviewChars: 500,
  reviewsPerStep: 6,
  issueBodyChars: 400,
  /** Above this many commits, the middle ones are reduced to message subject plus PR title. */
  fullCommits: 25,
  /** How many of the oldest commits stay in full when the middle is reduced. */
  fullOldest: 5,
};

const SYSTEM = `You are Code Archaeologist. You explain how a piece of code evolved and whether it is safe to change, using only the evidence you are given.

Rules:
- Explain what changed and why, from the evidence only: the commit message, its pull request description, review comments, PR discussion and linked issues. If none of them gives a reason for a change, say "No reason recorded." and cite the commit. Never guess a motive.
- For a revert, look for the reason in the review comments, especially those marked as posted on the reverted PR, and state that reason in the revert's own note. If there is none, a revert whose message only names the reverted commit has no recorded reason.
- When the reason comes from a review comment or an issue, say who raised it or what broke in plain words, and cite that review or issue id.
- Every note and every verdict reason cites at least one id exactly as written in the evidence, such as "commit:b35fa73", "pr:49659", "review:b35fa73-2" or "issue:31462". Cite the PR, review or issue the claim rests on, not just the commit. Never invent ids.
- Write one note per commit, in the same order as the evidence, using its short hash in "commit". Commits marked [reduced] get a short note from their subject alone.
- Notes are at most 2 sentences, plain words, no markdown. Ids go in "citations", not in the text.
- "summary" is one sentence on how these lines got to where they are today and what that means for someone about to change them. Do not just describe what the code does.
- The verdict level is low, medium or high risk to change. Raise it for security fixes, security review sign-offs, reverts, a change made and then undone, tests added alongside a change, breakage reported in review, or code labelled as taken from another library.
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
  for (const step of steps) for (const id of evidenceIds(step, Boolean(timeline.gitlab))) ids.add(id);

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
    const where = [review.on ? `on reverted PR pr:${review.on}` : '', review.path ? `on ${review.path}` : '', review.date?.slice(0, 10) ?? '']
      .filter(Boolean)
      .join(', ');
    out.push(`Review review:${short(c.sha)}-${i + 1} by ${review.author}${where ? ` (${where})` : ''}: ${oneLine(clip(review.body.trim(), limits.reviewChars))}`);
  });
  for (const issue of step.issues) {
    const verb = issue.relation === 'reverts' ? 'Reverts' : issue.kind === 'pr' ? 'Linked PR' : 'Fixes issue';
    out.push(`${verb} ${issueId(issue)}: ${issue.title}`);
    if (issue.body) out.push(`  ${oneLine(clip(issue.body, limits.issueBodyChars))}`);
  }
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
function evidenceIds(step: Step, gitlab = false): string[] {
  const ids = [`commit:${short(step.commit.sha)}`];
  if (step.pr) ids.push(`pr:${step.pr.number}`);
  if (gitlab) {
    // GitLab numbers issues ("#n") and merge requests ("!n") apart.
    for (const m of step.commit.message.matchAll(/(?:^|[\s(])#(\d+)\b/g)) ids.push(`issue:${m[1]}`);
    for (const m of step.commit.message.matchAll(/(?:^|[\s(\w/])!(\d+)\b/g)) ids.push(`pr:${m[1]}`);
  } else {
    // A "#n" in the message is a PR unless GitHub said it is an issue.
    const issues = new Set(step.issues.filter((i) => i.kind !== 'pr').map((i) => i.number));
    for (const m of step.commit.message.matchAll(/(?:^|[\s(])#(\d+)\b/g)) if (!issues.has(Number(m[1]))) ids.push(`pr:${m[1]}`);
  }
  step.reviews.forEach((review, i) => {
    ids.push(`review:${short(step.commit.sha)}-${i + 1}`);
    if (review.on) ids.push(`pr:${review.on}`);
  });
  for (const issue of step.issues) ids.push(issueId(issue));
  return ids;
}

/** PRs are cited as "pr:N", issues as "issue:N". */
function issueId(issue: LinkedIssue): string {
  return `${issue.kind === 'pr' ? 'pr' : 'issue'}:${issue.number}`;
}

function oneLine(text: string): string {
  return text.replace(/\s*\n\s*/g, ' / ');
}

/** The PR that merged a commit: from GitHub when known, else the number the merge tool wrote into the message. */
function mergedPr(step: Step, gitlab = false): string | undefined {
  const n = step.pr?.number ?? (gitlab ? mrFromMessage : prFromMessage)(step.commit.message);
  return n === undefined ? undefined : `pr:${n}`;
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
  const mr = Boolean(timeline.gitlab);
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
    const n = ref.trim().replace(/^#/, '');
    const id = `${kind}:${n}`;
    if (known.has(id)) return id;
    // GitHub numbers issues and PRs together, so the model sometimes mixes the two up.
    const other = kind === 'issue' ? `pr:${n}` : kind === 'pr' ? `issue:${n}` : undefined;
    return other && known.has(other) ? other : undefined;
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
    // A note about a commit also cites the PR its message names, when the model left it out.
    const own = timeline.steps.find((s) => s.commit.sha === sha)!;
    const pr = flagged ? undefined : mergedPr(own, mr);
    if (pr && !citations.includes(pr)) citations.push(pr);
    notes.set(sha, { commit: sha, note: prose(step.note, mr), citations, ...(flagged && { flagged }) });
  }

  return {
    summary: out.summary.trim(),
    steps: shas.flatMap((sha) => notes.get(sha) ?? []),
    verdict: {
      level: out.verdict.level,
      reasons: out.verdict.reasons.slice(0, 5).map((r) => {
        const { citations, flagged } = check(r.citations);
        return { text: prose(r.text, mr), citations, ...(flagged && { flagged }) };
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

/**
 * The request format. "gemini" is Google AI Studio's REST API. "openai" is the chat completions
 * API that OpenAI, OpenRouter, Ollama, LM Studio, vLLM and most gateways speak.
 */
export type Provider = 'gemini' | 'openai';

export type ClientOptions = {
  provider?: Provider;
  /** Optional for "openai", since local servers usually take none. */
  apiKey?: string;
  model?: string;
  /**
   * API root, e.g. "https://generativelanguage.googleapis.com/v1beta" or "http://localhost:11434/v1".
   * Defaults to DEFAULT_BASE_URL for the provider.
   */
  baseUrl?: string;
  /** Per attempt. A full timeline takes 20-120 seconds on the free tier, more when it is busy. */
  timeoutMs?: number;
  /** Gemini 3 thinking level. Low keeps a trace fast without hurting the notes. */
  thinkingLevel?: 'low' | 'medium' | 'high' | 'off';
  /** Extra attempts after a 429, a 5xx or a timeout. */
  retries?: number;
  /** Extra HTTP headers on every request, e.g. for a gateway. They win over the client's own, so one can replace the auth header. */
  headers?: Record<string, string>;
  fetch?: typeof fetch;
};

/**
 * Headers written one per line as "Name: value". Blank lines and lines starting with # are skipped;
 * anything else that isn't a valid header comes back in `invalid`.
 */
export function parseHeaders(text: string): { headers: Record<string, string>; invalid: string[] } {
  const headers: Record<string, string> = {};
  const invalid: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^([!#$%&'*+.^_`|~0-9A-Za-z-]+)\s*:\s*(.*)$/.exec(line);
    // Values may not hold control characters; fetch would refuse them anyway.
    if (m && !/[\0-\x1f\x7f]/.test(m[2]!)) headers[m[1]!.toLowerCase()] = m[2]!;
    else invalid.push(line);
  }
  return { headers, invalid };
}

export type GeminiOptions = ClientOptions & { apiKey: string };

export const DEFAULT_MODEL = 'gemini-3.5-flash';

export const DEFAULT_BASE_URL: Record<Provider, string> = {
  gemini: 'https://generativelanguage.googleapis.com/v1beta',
  openai: 'https://api.openai.com/v1',
};

/** A client for the provider in the options, Gemini by default. */
export function modelClient(options: ClientOptions): ModelClient {
  return options.provider === 'openai' ? openAiClient(options) : geminiClient({ ...options, apiKey: options.apiKey ?? '' });
}

/** Google AI Studio's REST API, called with plain fetch so there is no SDK to bundle. */
export function geminiClient(options: GeminiOptions): ModelClient {
  const model = options.model?.trim() || DEFAULT_MODEL;
  const base = trimUrl(options.baseUrl) || DEFAULT_BASE_URL.gemini;
  const url = /:generateContent$/.test(base) ? base : `${base}/models/${encodeURIComponent(model)}:generateContent`;
  let thinkingLevel = options.thinkingLevel ?? 'low';

  return {
    model,
    generate: (prompt, signal) =>
      send(options, {
        name: base === DEFAULT_BASE_URL.gemini ? 'Gemini' : host(base),
        model,
        url,
        headers: { 'content-type': 'application/json', 'x-goog-api-key': options.apiKey },
        body: () => ({
          systemInstruction: { parts: [{ text: prompt.system }] },
          contents: [{ role: 'user', parts: [{ text: prompt.user }] }],
          generationConfig: {
            temperature: 0.2,
            responseMimeType: 'application/json',
            responseJsonSchema: prompt.schema,
            ...(thinkingLevel !== 'off' && { thinkingConfig: { thinkingLevel } }),
          },
        }),
        downgrade: (detail) => {
          if (thinkingLevel === 'off' || !/thinking/i.test(detail)) return false;
          thinkingLevel = 'off'; // older models have no thinking level
          return true;
        },
        read: (data: GeminiResponse) => {
          const candidate = data.candidates?.[0];
          const text = candidate?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
          return { text, why: data.promptFeedback?.blockReason ?? candidate?.finishReason };
        },
      }, signal),
  };
}

/** Any OpenAI-compatible chat completions endpoint, also with plain fetch. */
export function openAiClient(options: ClientOptions): ModelClient {
  const model = options.model?.trim() ?? '';
  const base = trimUrl(options.baseUrl) || DEFAULT_BASE_URL.openai;
  const url = /\/chat\/completions$/.test(base) ? base : `${base}/chat/completions`;
  // Not every server takes a JSON schema or a temperature; drop each the first time one is refused.
  let format: 'json_schema' | 'json_object' | 'none' = 'json_schema';
  let temperature = true;

  return {
    model,
    async generate(prompt, signal) {
      if (!model) throw new StoryError('Set a model name for the OpenAI-compatible API in the codeArchaeologist.model setting.');
      return send(options, {
        name: host(base),
        model,
        url,
        headers: { 'content-type': 'application/json', ...(options.apiKey && { authorization: `Bearer ${options.apiKey}` }) },
        body: () => ({
          model,
          messages: [
            { role: 'system', content: prompt.system },
            { role: 'user', content: prompt.user },
          ],
          ...(temperature && { temperature: 0.2 }),
          ...(format === 'json_schema' && { response_format: { type: 'json_schema', json_schema: { name: 'story', schema: prompt.schema } } }),
          ...(format === 'json_object' && { response_format: { type: 'json_object' } }),
        }),
        downgrade: (detail) => {
          if (temperature && /temperature/i.test(detail)) {
            temperature = false;
            return true;
          }
          if (format !== 'none' && /response_format|json_schema|json_object|structured/i.test(detail)) {
            format = format === 'json_schema' ? 'json_object' : 'none';
            return true;
          }
          return false;
        },
        read: (data: OpenAiResponse) => {
          const choice = data.choices?.[0];
          const content = choice?.message?.content;
          const text = typeof content === 'string' ? content : (content ?? []).map((p) => p.text ?? '').join('');
          return { text, why: choice?.message?.refusal ?? choice?.finish_reason };
        },
      }, signal);
    },
  };
}

type Request<T> = {
  /** Who answered, for error messages: "Gemini" or the API's host. */
  name: string;
  model: string;
  url: string;
  headers: Record<string, string>;
  body: () => object;
  /** Given a 400's message, drops a request option the server refused. True to resend. */
  downgrade: (detail: string) => boolean;
  read: (data: T) => { text: string; why?: string | null };
};

/** Posts the request, retrying a busy or slow model, and turns failures into readable StoryErrors. */
async function send<T>(options: ClientOptions, req: Request<T>, signal?: AbortSignal): Promise<string> {
  const doFetch = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 180_000;
  const retries = options.retries ?? 3;
  const { name, model } = req;

  for (let attempt = 0; ; attempt++) {
    const timeout = AbortSignal.timeout(timeoutMs);
    let response: Response;
    try {
      response = await doFetch(req.url, {
        method: 'POST',
        headers: { ...req.headers, ...Object.fromEntries(Object.entries(options.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v])) },
        body: JSON.stringify(req.body()),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      if (timeout.aborted && attempt < Math.min(retries, 1)) continue; // a slow model rarely speeds up
      const reason = timeout.aborted ? `no answer within ${Math.round(timeoutMs / 1000)}s` : String(error);
      throw new StoryError(`Could not reach ${name} (${model}): ${reason}`, { cause: error });
    }

    if (response.ok) {
      const { text, why } = req.read((await response.json()) as T);
      if (!text) throw new StoryError(`${name} (${model}) returned no story: ${why || 'empty answer'}`);
      return text;
    }

    const detail = await errorMessage(response);
    if (response.status === 400 && req.downgrade(detail)) {
      attempt--;
      continue;
    }
    // A used-up daily quota says "retry in 9h23m"; waiting a few seconds won't help.
    const wait = /retry in ((?:\d+h)?(?:\d+m)?[\d.]*s?)/i.exec(detail)?.[1];
    const daily = response.status === 429 && (/per ?day|daily/i.test(detail) || /\d+h/.test(wait ?? ''));
    const retryable = (response.status === 429 && !daily) || response.status >= 500;
    if (retryable && attempt < retries) {
      await sleep(2_000 * 2 ** attempt, signal);
      continue;
    }
    const hint =
      (response.status === 400 && /api key/i.test(detail)) || response.status === 401 || response.status === 403
        ? ' Check the API key.'
        : response.status === 404
          ? ' Check the model name in the codeArchaeologist.model setting and the API URL in codeArchaeologist.baseUrl.'
          : daily
            ? ` The free tier's daily quota for ${model} is used up${wait ? `; it resets in ${wait.replace(/\.\d+s$/, 's')}` : ''}. Each model has its own quota, so pick another model in Settings${name === 'Gemini' && !/flash-lite/.test(model) ? ', e.g. gemini-3.1-flash-lite' : ''}, or try later.`
            : response.status === 429
              ? ' The API is rate limited; try again in a minute.'
              : '';
    const first = (daily ? detail.split('\n')[0]! : detail).trim().replace(/\.+$/, '');
    throw new StoryError(`${name} (${model}) answered ${response.status}: ${first}.${hint}`);
  }
}

type GeminiResponse = {
  candidates?: { content?: { parts?: { text?: string }[] }; finishReason?: string }[];
  promptFeedback?: { blockReason?: string };
};

type OpenAiResponse = {
  choices?: { message?: { content?: string | { text?: string }[] | null; refusal?: string | null }; finish_reason?: string }[];
};

function trimUrl(url: string | undefined): string {
  return url?.trim().replace(/\/+$/, '') ?? '';
}

function host(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

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

/**
 * Turns ids the model wrote into the text anyway into what a reader expects: "commit:b35fa73" →
 * "b35fa73", "pr:49659" → "#49659", or "!49659" for a GitLab merge request.
 */
function prose(text: string, mr = false): string {
  return text
    .trim()
    .replace(/\bcommit:([0-9a-f]{7,40})\b/gi, (_, sha: string) => short(sha))
    .replace(/\bpr:(\d+)\b/gi, mr ? '!$1' : '#$1')
    .replace(/\bissue:(\d+)\b/gi, '#$1');
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
