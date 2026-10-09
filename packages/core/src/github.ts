import path from 'node:path';
import type { GitHubCache } from './cache.js';
import type { GitHubContext, LinkedIssue, Review, Step, Timeline } from './types.js';

export type GitHubOptions = {
  /** A read-only token. Without one GitHub allows 60 requests an hour, enough for a short history. */
  token?: string;
  /** When given, every response is kept on disk, so a rerun makes no requests. */
  cache?: GitHubCache;
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
  /** Requests in flight at once. */
  concurrency?: number;
  fetch?: typeof fetch;
  apiUrl?: string;
};

/** Per-PR limits on what is kept, before the prompt applies its own. */
const KEEP = { bodyChars: 4_000, commentChars: 1_500, issueBodyChars: 800 };

/**
 * Finds each step's pull request, the review comments and discussion on it, and the issues it
 * fixes or the PR it reverts. Best effort: on any GitHub failure the timeline comes back with
 * what was found so far and `context.error` says what went wrong.
 */
export async function addGitHubContext(timeline: Timeline, options: GitHubOptions = {}): Promise<Timeline> {
  const repo = timeline.github;
  if (!repo || timeline.steps.length === 0) return timeline;
  return addForgeContext(timeline, new GitHubApi(repo, options), options);
}

/** A link from a commit or PR to an issue it fixes or a PR it reverts. */
export type ForgeRef = {
  number: number;
  relation: 'fixes' | 'reverts' | 'mentions';
  /** Set where issues and PRs are numbered apart (GitLab). GitHub says which when the issue is read. */
  kind?: 'issue' | 'pr';
  /** Another project on the same host, for a GitLab "group/tracker#12". */
  project?: string;
};

/** What a code host answers. GitHub and GitLab each implement it; the steps below are shared. */
export interface Forge {
  readonly concurrency: number;
  /** Called once first; throws when the repository cannot be read at all. */
  check?(): Promise<void>;
  /** Something left out without failing the rest, reported as `context.error` when nothing worse is. */
  readonly warning?: string;
  prFromMessage(message: string): number | undefined;
  prForCommit(sha: string): Promise<number | undefined>;
  pullRequest(n: number, file: string): Promise<PullRequest | undefined>;
  linkedRefs(text: string, shaToPr: (sha: string) => number | undefined): ForgeRef[];
  issue(n: number, kind?: 'issue' | 'pr', project?: string): Promise<{ issue: LinkedIssue; discussion: Review[] } | undefined>;
}

/** The shared steps behind addGitHubContext and addGitLabContext. */
export async function addForgeContext(
  timeline: Timeline,
  api: Forge,
  options: { token?: string; signal?: AbortSignal; onProgress?: (message: string) => void },
  source?: GitHubContext['source'],
): Promise<Timeline> {
  const steps: Step[] = timeline.steps.map((s) => ({ ...s, pr: undefined, reviews: [], issues: [] }));
  const context: GitHubContext = { token: Boolean(options.token), prs: 0, reviews: 0, issues: 0, ...(source && { source }) };
  const refKey = (ref: { number: number; kind?: string; project?: string }) => `${ref.kind ?? ''}:${ref.project ?? ''}#${ref.number}`;

  try {
    await api.check?.();

    // 1. Which PR merged each commit: from the message when it says, else the host's "PRs for a commit".
    const prOf = new Map<string, number>();
    await mapLimit(steps, api.concurrency, async (step) => {
      const n = api.prFromMessage(step.commit.message) ?? (await api.prForCommit(step.commit.sha));
      if (n !== undefined) prOf.set(step.commit.sha, n);
    });

    // 2. Each PR once: description, line comments on this file, review summaries and discussion.
    const numbers = [...new Set(prOf.values())];
    options.onProgress?.(`Reading ${numbers.length} ${source === 'gitlab' ? 'merge request' : 'pull request'}${numbers.length === 1 ? '' : 's'}`);
    const prs = new Map<number, PullRequest>();
    await mapLimit(numbers, api.concurrency, async (n) => {
      const pr = await api.pullRequest(n, path.posix.basename(timeline.file));
      if (pr) prs.set(n, pr);
    });

    // 3. What each commit fixes or reverts.
    const shaToPr = (sha: string) => {
      const step = steps.find((s) => s.commit.sha.startsWith(sha.toLowerCase()));
      return step ? prOf.get(step.commit.sha) : undefined;
    };
    const links = new Map<Step, ForgeRef[]>();
    for (const step of steps) {
      const own = prOf.get(step.commit.sha);
      const found = api.linkedRefs(`${step.commit.message}\n${prs.get(own ?? -1)?.body ?? ''}`, shaToPr);
      links.set(step, found.filter((l) => l.number !== own || l.kind === 'issue' || l.project !== undefined));
    }
    const wanted = [...new Map([...links.values()].flat().map((l) => [refKey(l), l])).values()];
    if (wanted.length > 0) options.onProgress?.(`Reading ${wanted.length} linked issue${wanted.length === 1 ? '' : 's'}`);
    const issues = new Map<string, { issue: LinkedIssue; discussion: Review[] }>();
    await mapLimit(wanted, api.concurrency, async (ref) => {
      const found = await api.issue(ref.number, ref.kind, ref.project);
      if (found) issues.set(refKey(ref), found);
    });

    // 4. Put it together.
    for (const step of steps) {
      const pr = prs.get(prOf.get(step.commit.sha) ?? -1);
      const reviews: Review[] = [];
      for (const link of links.get(step) ?? []) {
        const found = issues.get(refKey(link));
        if (!found) continue;
        step.issues.push({ ...found.issue, relation: link.relation });
        // The reason for a revert is usually in the discussion on the PR it undid.
        if (link.relation === 'reverts') reviews.push(...revertDiscussion(found.discussion, link.number));
      }
      // A revert of a commit already in this timeline: the reverted PR is read in step 2.
      for (const sha of revertedShas(step.commit.message)) {
        const reverted = prs.get(shaToPr(sha) ?? -1);
        if (reverted && reverted.number !== pr?.number && !reviews.some((r) => r.on === reverted.number)) {
          reviews.push(...revertDiscussion(reverted.discussion, reverted.number));
        }
      }
      if (pr) {
        step.pr = { number: pr.number, title: pr.title, body: pr.body, url: pr.url };
        reviews.push(...pr.discussion);
      }
      step.reviews = dedupe(reviews);
    }
  } catch (error) {
    if (options.signal?.aborted) throw error;
    context.error = error instanceof Error ? error.message : String(error);
  }
  if (!context.error && api.warning) context.error = api.warning;

  context.prs = new Set(steps.flatMap((s) => (s.pr ? [s.pr.number] : []))).size;
  context.reviews = steps.reduce((n, s) => n + s.reviews.length, 0);
  context.issues = new Set(steps.flatMap((s) => s.issues.map(refKey))).size;
  return { ...timeline, steps, context };
}

/** The PR number a merge tool wrote into the message: "(#123)" ending the subject, Angular's "PR Close #123", or a merge commit. */
export function prFromMessage(message: string): number | undefined {
  const subject = message.split('\n')[0] ?? '';
  const m =
    /\(#(\d+)\)\s*$/.exec(subject) ??
    /^Merge pull request #(\d+)\b/.exec(subject) ??
    /^PR Close #(\d+)\s*$/m.exec(message);
  return m ? Number(m[1]) : undefined;
}

/**
 * Issues a commit or PR says it fixes, and PRs it reverts, by number. `shaToPr` resolves
 * "This reverts commit <sha>" when that commit's PR is known.
 */
export function linkedRefs(
  text: string,
  repo: { owner: string; repo: string },
  shaToPr: (sha: string) => number | undefined = () => undefined,
): { number: number; relation: 'fixes' | 'reverts' }[] {
  const clean = stripTemplate(text);
  const ref = `(?:#|${escape(`https://github.com/${repo.owner}/${repo.repo}/`)}(?:issues|pull)/|${escape(`${repo.owner}/${repo.repo}#`)})(\\d+)`;
  const out = new Map<number, 'fixes' | 'reverts'>();
  for (const m of clean.matchAll(new RegExp(`(?<!PR )\\b(?:fix(?:es|ed)?|close[sd]?|resolve[sd]?)\\s*:?\\s+${ref}`, 'gi'))) {
    out.set(Number(m[1]), 'fixes');
  }
  for (const m of clean.matchAll(new RegExp(`\\breverts?\\s+(?:pr\\s+|pull request\\s+)?${ref}`, 'gi'))) {
    out.set(Number(m[1]), 'reverts');
  }
  for (const sha of revertedShas(clean)) {
    const n = shaToPr(sha);
    if (n !== undefined && !out.has(n)) out.set(n, 'reverts');
  }
  return [...out].map(([number, relation]) => ({ number, relation }));
}

/** "This reverts commit <sha>." as git writes it. */
export function revertedShas(message: string): string[] {
  return [...message.matchAll(/\bThis reverts commit ([0-9a-f]{7,40})\b/gi)].map((m) => m[1]!);
}

/** Comments on a reverted PR, the ones that mention the revert first. */
function revertDiscussion(discussion: Review[], on: number): Review[] {
  const about = discussion.filter((r) => /\brevert/i.test(r.body));
  return (about.length > 0 ? about : discussion.slice(-3)).map((r) => ({ ...r, on }));
}

function dedupe(reviews: Review[]): Review[] {
  const seen = new Set<string>();
  return reviews.filter((r) => (seen.has(r.url) ? false : (seen.add(r.url), true)));
}

/** Drops what PR templates add: HTML comments and checkbox lists. */
export function stripTemplate(text: string): string {
  return text
    .replace(/<!--[\s\S]*?-->/g, '')
    .split('\n')
    .filter((line) => !/^\s*[-*]\s*\[[ xX]\]/.test(line))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export type PullRequest = { number: number; title: string; body: string; url: string; discussion: Review[] };

type GitHubUser = { login?: string; type?: string } | null;
type ApiComment = { user: GitHubUser; body?: string | null; html_url: string; created_at?: string; submitted_at?: string; path?: string; state?: string };
type ApiPull = { number: number; title: string; body?: string | null; html_url: string; merged_at?: string | null };
type ApiIssue = { number: number; title: string; body?: string | null; html_url: string; pull_request?: unknown };

export class GitHubError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = 'GitHubError';
  }
}

class GitHubApi implements Forge {
  readonly concurrency: number;
  private readonly base: string;
  private readonly doFetch: typeof fetch;
  /** Set on the first failure that would fail every later request too (bad token, rate limit). */
  private fatal?: GitHubError;

  constructor(
    private readonly repo: { owner: string; repo: string },
    private readonly options: GitHubOptions,
  ) {
    this.concurrency = options.concurrency ?? 4;
    this.base = `${options.apiUrl ?? 'https://api.github.com'}/repos/${repo.owner}/${repo.repo}`;
    this.doFetch = options.fetch ?? fetch;
  }

  prFromMessage(message: string): number | undefined {
    return prFromMessage(message);
  }

  linkedRefs(text: string, shaToPr: (sha: string) => number | undefined): ForgeRef[] {
    return linkedRefs(text, this.repo, shaToPr);
  }

  async prForCommit(sha: string): Promise<number | undefined> {
    const pulls = await this.get<ApiPull[]>(`/commits/${sha}/pulls`);
    const merged = pulls?.find((p) => p.merged_at) ?? pulls?.[0];
    return merged?.number;
  }

  async pullRequest(n: number, file: string): Promise<PullRequest | undefined> {
    const pull = await this.get<ApiPull>(`/pulls/${n}`);
    if (!pull) return undefined;
    const [lineComments, reviews, comments] = await Promise.all([
      this.get<ApiComment[]>(`/pulls/${n}/comments?per_page=100`),
      this.get<ApiComment[]>(`/pulls/${n}/reviews?per_page=100`),
      this.get<ApiComment[]>(`/issues/${n}/comments?per_page=100`),
    ]);
    const kept = (list: (Review | undefined)[]) => list.filter((r): r is Review => r !== undefined);
    const discussion = [
      // Line comments on this file come first: they are about the traced code.
      ...kept((lineComments ?? []).filter((c) => c.path && path.posix.basename(c.path) === file).map((c) => toReview(c, c.path))),
      ...kept([...(reviews ?? []), ...(comments ?? [])].map((c) => toReview(c))).sort((a, b) => (a.date ?? '').localeCompare(b.date ?? '')),
    ];
    return { number: pull.number, title: pull.title, body: clip(stripTemplate(pull.body ?? ''), KEEP.bodyChars), url: pull.html_url, discussion };
  }

  /** An issue or PR by number, with its discussion when it is a PR. */
  async issue(n: number): Promise<{ issue: LinkedIssue; discussion: Review[] } | undefined> {
    const issue = await this.get<ApiIssue>(`/issues/${n}`);
    if (!issue) return undefined;
    const isPr = Boolean(issue.pull_request);
    const comments = isPr ? await this.get<ApiComment[]>(`/issues/${n}/comments?per_page=100`) : undefined;
    const body = clip(stripTemplate(issue.body ?? ''), KEEP.issueBodyChars);
    return {
      issue: { number: issue.number, title: issue.title, url: issue.html_url, kind: isPr ? 'pr' : 'issue', ...(body && { body }) },
      discussion: (comments ?? []).map((c) => toReview(c)).filter((r): r is Review => r !== undefined),
    };
  }

  /** GET a path under the repo. Resolves undefined for 404 (unknown commit or PR, or a private repo). */
  private async get<T>(route: string): Promise<T | undefined> {
    if (this.fatal) throw this.fatal;
    // Kept apart by whether a token was sent: GitHub answers 404 for a private repo without one,
    // and that 404 must not hide the repo for a week once a token is set.
    const cacheKey = `${this.options.token ? 'token' : 'anon'}:${this.repo.owner}/${this.repo.repo}${route}`;
    const cached = await this.options.cache?.get(cacheKey);
    if (cached) return (cached.data ?? undefined) as T | undefined;

    for (let attempt = 0; ; attempt++) {
      let response: Response;
      try {
        response = await this.doFetch(`${this.base}${route}`, {
          headers: {
            accept: 'application/vnd.github+json',
            'x-github-api-version': '2022-11-28',
            'user-agent': 'code-archaeologist',
            ...(this.options.token && { authorization: `Bearer ${this.options.token}` }),
          },
          signal: this.options.signal,
        });
      } catch (error) {
        if (this.options.signal?.aborted || attempt >= 1) throw new GitHubError(`Could not reach GitHub: ${String(error)}`);
        continue;
      }

      if (response.ok) {
        const data = (await response.json()) as T;
        await this.options.cache?.set(cacheKey, data);
        return data;
      }
      if (response.status === 404 || response.status === 422) {
        await this.options.cache?.set(cacheKey, null); // e.g. a commit GitHub has never seen
        return undefined;
      }
      if (response.status >= 500 && attempt < 1) continue;
      throw (this.fatal = await this.failure(response));
    }
  }

  private async failure(response: Response): Promise<GitHubError> {
    const detail = await response
      .json()
      .then((b: { message?: string }) => b.message ?? '')
      .catch(() => '');
    const status = response.status;
    if (status === 401) return new GitHubError('GitHub rejected the token. Set a new one.', status);
    const limited = response.headers.get('x-ratelimit-remaining') === '0' || /rate limit/i.test(detail);
    if (status === 429 || (status === 403 && limited)) {
      const reset = Number(response.headers.get('x-ratelimit-reset'));
      const when = reset ? ` until ${new Date(reset * 1000).toISOString().slice(11, 16)} UTC` : '';
      const fix = this.options.token ? '' : ' A GitHub token raises the limit from 60 to 5,000 requests an hour.';
      return new GitHubError(`GitHub's rate limit was reached${when}, so some pull requests were not read.${fix}`, status);
    }
    if (status === 403) return new GitHubError(`GitHub refused access to ${this.repo.owner}/${this.repo.repo}${detail ? `: ${detail}` : ''}.`, status);
    return new GitHubError(`GitHub answered ${status}${detail ? `: ${detail}` : ''}.`, status);
  }
}

function toReview(c: ApiComment, filePath?: string): Review | undefined {
  const body = (c.body ?? '').trim();
  if (!body || isBot(c.user)) return undefined;
  const date = c.submitted_at ?? c.created_at;
  return {
    author: c.user?.login ?? 'unknown',
    body: clip(stripTemplate(body), KEEP.commentChars),
    url: c.html_url,
    ...(date && { date }),
    ...(filePath && { path: filePath }),
  };
}

function isBot(user: GitHubUser): boolean {
  return !user || user.type === 'Bot' || /\[bot\]$/.test(user.login ?? '');
}

export async function mapLimit<T>(items: T[], limit: number, run: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await run(items[next++]!);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

export function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

export function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
