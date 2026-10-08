import path from 'node:path';
import type { GitHubCache } from './cache.js';
import { addForgeContext, clip, escape, type Forge, type ForgeRef, type PullRequest, revertedShas, stripTemplate } from './github.js';
import type { LinkedIssue, Review, Timeline } from './types.js';

export type GitLabOptions = {
  /** A token with read_api. Needed for private projects, which GitLab reports as not found without one. */
  token?: string;
  /** When given, every response is kept on disk, so a rerun makes no requests. */
  cache?: GitHubCache;
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
  /** Requests in flight at once. */
  concurrency?: number;
  fetch?: typeof fetch;
};

/** Per-MR limits on what is kept, before the prompt applies its own. */
const KEEP = { bodyChars: 4_000, commentChars: 1_500, issueBodyChars: 800 };

/**
 * The same as addGitHubContext for a project on gitlab.com or a self-hosted GitLab: each step's
 * merge request, its comments and the issues it closes. Merge requests fill `pr`, as "!n".
 */
export async function addGitLabContext(timeline: Timeline, options: GitLabOptions = {}): Promise<Timeline> {
  const project = timeline.gitlab;
  if (!project || timeline.steps.length === 0) return timeline;
  return addForgeContext(timeline, new GitLabApi(project, options), options, 'gitlab');
}

/** The merge request number GitLab wrote into a merge commit: "See merge request group/project!123". */
export function mrFromMessage(message: string): number | undefined {
  const m = /^See merge request [\w./-]*!(\d+)\s*$/m.exec(message) ?? /\(!(\d+)\)\s*$/.exec(message.split('\n')[0] ?? '');
  return m ? Number(m[1]) : undefined;
}

/**
 * Issues a commit or MR says it closes ("#12"), and merge requests it reverts ("!34"). GitLab
 * numbers the two apart, so each ref says which it is.
 */
export function gitlabLinkedRefs(
  text: string,
  project: { url: string; project: string },
  shaToPr: (sha: string) => number | undefined = () => undefined,
): ForgeRef[] {
  const clean = stripTemplate(text);
  const web = escape(`${project.url}/${project.project}/-/`);
  const issue = `(?:#|${web}issues/|${escape(project.project)}#)(\\d+)`;
  const mr = `(?:!|${web}merge_requests/|${escape(project.project)}!)(\\d+)`;
  const out = new Map<string, ForgeRef>();
  const add = (ref: ForgeRef) => {
    const key = `${ref.kind}:${ref.number}`;
    if (!out.has(key)) out.set(key, ref);
  };
  for (const m of clean.matchAll(new RegExp(`\\b(?:fix(?:es|ed|ing)?|close[sd]?|closing|resolve[sd]?|resolving|implement(?:s|ed|ing)?)\\s*:?\\s+${issue}`, 'gi'))) {
    add({ number: Number(m[1]), relation: 'fixes', kind: 'issue' });
  }
  for (const m of clean.matchAll(new RegExp(`\\breverts?\\s+(?:merge request\\s+)?${mr}`, 'gi'))) {
    add({ number: Number(m[1]), relation: 'reverts', kind: 'pr' });
  }
  for (const sha of revertedShas(clean)) {
    const n = shaToPr(sha);
    if (n !== undefined) add({ number: n, relation: 'reverts', kind: 'pr' });
  }
  return [...out.values()];
}

/**
 * The GitLab project behind a remote URL (https, ssh or scp form), when its host is `gitlabUrl`'s
 * or has "gitlab" in its name. Subgroups are kept in `project`.
 */
export function parseGitLabRemote(remote: string, gitlabUrl?: string): { url: string; project: string } | undefined {
  const m =
    /^(?:https?|ssh|git):\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+?)(?:\.git)?\/?$/.exec(remote.trim()) ??
    /^(?:[^@/]+@)?([^/:]+):(.+?)(?:\.git)?\/?$/.exec(remote.trim());
  if (!m) return undefined;
  const [, host, fullPath] = m as unknown as [string, string, string];
  let base: URL | undefined;
  try {
    base = gitlabUrl?.trim() ? new URL(gitlabUrl.trim()) : undefined;
  } catch {
    base = undefined;
  }
  if (base?.hostname === host.toLowerCase()) {
    // A GitLab served under a path, e.g. https://example.com/gitlab: the remote's path starts with it.
    const prefix = base.pathname.replace(/^\/+|\/+$/g, '');
    const project = prefix && fullPath.startsWith(`${prefix}/`) ? fullPath.slice(prefix.length + 1) : fullPath;
    return project.includes('/') ? { url: `${base.origin}${prefix ? `/${prefix}` : ''}`, project } : undefined;
  }
  if (!/gitlab/i.test(host) || !fullPath.includes('/')) return undefined;
  return { url: `https://${host.toLowerCase()}`, project: fullPath };
}

export class GitLabError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = 'GitLabError';
  }
}

type GitLabUser = { username?: string; bot?: boolean } | null;
type ApiNote = {
  id: number;
  body?: string | null;
  author: GitLabUser;
  created_at?: string;
  system?: boolean;
  position?: { new_path?: string | null; old_path?: string | null } | null;
};
type ApiMr = { iid: number; title: string; description?: string | null; web_url: string; state?: string };
type ApiIssue = { iid: number; title: string; description?: string | null; web_url: string };

class GitLabApi implements Forge {
  readonly concurrency: number;
  private readonly base: string;
  private readonly doFetch: typeof fetch;
  /** Set on the first failure that would fail every later request too (bad token, rate limit). */
  private fatal?: GitLabError;
  warning?: string;

  constructor(
    private readonly project: { url: string; project: string },
    private readonly options: GitLabOptions,
  ) {
    this.concurrency = options.concurrency ?? 4;
    this.base = `${project.url}/api/v4/projects/${encodeURIComponent(project.project)}`;
    this.doFetch = options.fetch ?? fetch;
  }

  /** GitLab answers 404 for a private project without a token, so say that rather than finding nothing. */
  async check(): Promise<void> {
    if ((await this.get<unknown>('')) !== undefined) return;
    const fix = this.options.token ? ' Check that the token has read_api access to it.' : ' If it is private, set a GitLab token.';
    throw new GitLabError(`GitLab could not find ${this.project.project} on ${new URL(this.project.url).host}.${fix}`, 404);
  }

  prFromMessage(message: string): number | undefined {
    return mrFromMessage(message);
  }

  linkedRefs(text: string, shaToPr: (sha: string) => number | undefined): ForgeRef[] {
    return gitlabLinkedRefs(text, this.project, shaToPr);
  }

  async prForCommit(sha: string): Promise<number | undefined> {
    const mrs = await this.get<ApiMr[]>(`/repository/commits/${sha}/merge_requests`);
    return (mrs?.find((m) => m.state === 'merged') ?? mrs?.[0])?.iid;
  }

  async pullRequest(n: number, file: string): Promise<PullRequest | undefined> {
    const mr = await this.get<ApiMr>(`/merge_requests/${n}`);
    if (!mr) return undefined;
    const notes = (await this.get<ApiNote[]>(`/merge_requests/${n}/notes?per_page=100&sort=asc`)) ?? [];
    const onFile = (note: ApiNote) => [note.position?.new_path, note.position?.old_path].find((p) => p && path.posix.basename(p) === file);
    const kept = (list: (Review | undefined)[]) => list.filter((r): r is Review => r !== undefined);
    const discussion = [
      // Line comments on this file come first: they are about the traced code.
      ...kept(notes.filter(onFile).map((note) => toReview(note, mr.web_url, onFile(note) ?? undefined))),
      ...kept(notes.filter((note) => !onFile(note)).map((note) => toReview(note, mr.web_url))),
    ];
    return { number: mr.iid, title: mr.title, body: clip(stripTemplate(mr.description ?? ''), KEEP.bodyChars), url: mr.web_url, discussion };
  }

  /** An issue, or a merge request with its comments. */
  async issue(n: number, kind: 'issue' | 'pr' = 'issue'): Promise<{ issue: LinkedIssue; discussion: Review[] } | undefined> {
    const found = await this.get<ApiIssue>(kind === 'pr' ? `/merge_requests/${n}` : `/issues/${n}`);
    if (!found) return undefined;
    const notes = kind === 'pr' ? await this.get<ApiNote[]>(`/merge_requests/${n}/notes?per_page=100&sort=asc`) : undefined;
    const body = clip(stripTemplate(found.description ?? ''), KEEP.issueBodyChars);
    return {
      issue: { number: found.iid, title: found.title, url: found.web_url, kind, ...(body && { body }) },
      discussion: (notes ?? []).map((note) => toReview(note, found.web_url)).filter((r): r is Review => r !== undefined),
    };
  }

  /** GET a path under the project. Resolves undefined for 404 (unknown commit or MR, or no access). */
  private async get<T>(route: string): Promise<T | undefined> {
    if (this.fatal) throw this.fatal;
    const cacheKey = `gitlab:${this.project.url}/${this.project.project}${route}`;
    const cached = await this.options.cache?.get(cacheKey);
    if (cached) return (cached.data ?? undefined) as T | undefined;

    for (let attempt = 0; ; attempt++) {
      let response: Response;
      try {
        response = await this.doFetch(`${this.base}${route}`, {
          headers: { accept: 'application/json', ...(this.options.token && { 'private-token': this.options.token }) },
          signal: this.options.signal,
        });
      } catch (error) {
        if (this.options.signal?.aborted || attempt >= 1) throw new GitLabError(`Could not reach GitLab at ${this.project.url}: ${String(error)}`);
        continue;
      }

      if (response.ok) {
        const data = (await response.json()) as T;
        await this.options.cache?.set(cacheKey, data);
        return data;
      }
      if (response.status === 404) {
        if (route) await this.options.cache?.set(cacheKey, null); // e.g. a commit GitLab has never seen
        return undefined;
      }
      if (response.status === 401 && !this.options.token) {
        // gitlab.com shows merge request comments only to signed-in users, even on public projects.
        this.warning = 'GitLab shows comments only to signed-in users. Set a GitLab token to read them.';
        return undefined;
      }
      if (response.status >= 500 && attempt < 1) continue;
      throw (this.fatal = await this.failure(response));
    }
  }

  private async failure(response: Response): Promise<GitLabError> {
    const detail = await response
      .json()
      .then((b: { message?: unknown; error?: unknown }) => String(b.message ?? b.error ?? ''))
      .catch(() => '');
    const status = response.status;
    if (status === 401) return new GitLabError('GitLab rejected the token. Set a new one with read_api access.', status);
    if (status === 429) {
      const reset = Number(response.headers.get('ratelimit-reset'));
      const when = reset ? ` until ${new Date(reset * 1000).toISOString().slice(11, 16)} UTC` : '';
      return new GitLabError(`GitLab's rate limit was reached${when}, so some merge requests were not read.`, status);
    }
    if (status === 403) return new GitLabError(`GitLab refused access to ${this.project.project}${detail ? `: ${detail}` : ''}.`, status);
    return new GitLabError(`GitLab answered ${status}${detail ? `: ${detail}` : ''}.`, status);
  }
}

function toReview(note: ApiNote, parentUrl: string, filePath?: string): Review | undefined {
  const body = (note.body ?? '').trim();
  // System notes are GitLab's own ("added 2 commits", "approved this merge request").
  if (!body || note.system || isBot(note.author)) return undefined;
  return {
    author: note.author?.username ?? 'unknown',
    body: clip(stripTemplate(body), KEEP.commentChars),
    url: `${parentUrl}#note_${note.id}`,
    ...(note.created_at && { date: note.created_at }),
    ...(filePath && { path: filePath }),
  };
}

function isBot(user: GitLabUser): boolean {
  return !user || user.bot === true || /(?:^project_\d+_bot|[-_]bot$|^ghost$)/i.test(user.username ?? '');
}
