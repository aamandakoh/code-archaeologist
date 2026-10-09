import path from 'node:path';
import type { GitHubCache } from './cache.js';
import { addForgeContext, clip, escape, type Forge, type ForgeRef, type PullRequest, revertedShas, stripTemplate } from './github.js';
import type { LinkedIssue, Review, Timeline } from './types.js';

export type GitLabOptions = {
  /** A token with read_api. Needed for private projects, which GitLab reports as not found without one. */
  token?: string;
  /**
   * The self-hosted GitLab the token is for. The token goes only to gitlab.com and this host, never
   * to another server, even one with "gitlab" in its name.
   */
  gitlabUrl?: string;
  /** When given, every response is kept on disk, so a rerun makes no requests. */
  cache?: GitHubCache;
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
  /** Requests in flight at once. */
  concurrency?: number;
  fetch?: typeof fetch;
};

/** Per-MR limits on what is kept, before the prompt applies its own. */
const KEEP = { bodyChars: 4_000, commentChars: 1_500, issueBodyChars: 800, boardIssueBodyChars: 2_000, issueComments: 20 };

/**
 * The same as addGitHubContext for a project on gitlab.com or a self-hosted GitLab: each step's
 * merge request, its comments and the issues it closes. Merge requests fill `pr`, as "!n".
 */
export async function addGitLabContext(timeline: Timeline, options: GitLabOptions = {}): Promise<Timeline> {
  const project = timeline.gitlab;
  if (!project || timeline.steps.length === 0) return timeline;
  const allowed = tokenAllowed(project.url, options.gitlabUrl);
  const scoped = { ...options, token: allowed ? options.token : undefined };
  const out = await addForgeContext(timeline, new GitLabApi(project, scoped), scoped, 'gitlab');
  if (options.token && !allowed && out.context) {
    const host = new URL(project.url).host;
    const note =
      `Your GitLab token was not sent to ${host}: it only goes to gitlab.com and the GitLab URL in settings. ` +
      `To use it there, set GitLab URL to ${project.url} (codeArchaeologist.gitlabUrl; CLI: --gitlab-url).`;
    out.context.error = out.context.error ? `${note} ${out.context.error}` : note;
    out.context.tokenHeldBackFrom = project.url;
  }
  return out;
}

/** True when a GitLab token may be sent to `url`: gitlab.com, or the GitLab the user set in `gitlabUrl`. */
export function tokenAllowed(url: string, gitlabUrl?: string): boolean {
  const target = gitlabBase(url)?.origin;
  return target !== undefined && (target === 'https://gitlab.com' || target === gitlabBase(gitlabUrl)?.origin);
}

/** A GitLab URL as typed, with https:// assumed when the scheme is left off ("gitlab.example.com"). */
function gitlabBase(url: string | undefined): URL | undefined {
  const u = url?.trim();
  if (!u) return undefined;
  try {
    return new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(u) ? u : `https://${u}`);
  } catch {
    return undefined;
  }
}

/** The merge request number GitLab wrote into a merge commit: "See merge request group/project!123". */
export function mrFromMessage(message: string): number | undefined {
  const m = /^See merge request [\w./-]*!(\d+)\s*$/m.exec(message) ?? /\(!(\d+)\)\s*$/.exec(message.split('\n')[0] ?? '');
  return m ? Number(m[1]) : undefined;
}

/**
 * Issues a commit or MR names: those it says it closes ("Closes #12"), then any other it mentions
 * ("#12", "tracker#12", "group/tracker#12" or an issue URL), and merge requests it reverts ("!34").
 * GitLab numbers issues and MRs apart, so each ref says which it is. An issue in another project
 * on the same GitLab, such as a team's board project, has `project` set.
 */
export function gitlabLinkedRefs(
  text: string,
  project: { url: string; project: string },
  shaToPr: (sha: string) => number | undefined = () => undefined,
): ForgeRef[] {
  const clean = stripTemplate(text);
  const web = escape(`${project.url}/${project.project}/-/`);
  // An issue URL on this GitLab, or "#12" with an optional project path in front. Groups 1 or 2 hold the path, 3 the number.
  const issue = `(?:${escape(project.url)}/([\\w.-]+(?:/[\\w.-]+)+)/-/issues/|(?<![\\w/.&#-])([\\w.-]+(?:/[\\w.-]+)*)?#)(\\d+)\\b`;
  const mr = `(?:!|${web}merge_requests/|${escape(project.project)}!)(\\d+)`;
  const out = new Map<string, ForgeRef>();
  const add = (ref: ForgeRef) => {
    const key = `${ref.kind}:${ref.project ?? ''}#${ref.number}`;
    if (!out.has(key)) out.set(key, ref);
  };
  const issueRef = (m: RegExpMatchArray, relation: ForgeRef['relation']): ForgeRef => {
    const other = otherProject(m[1] ?? m[2], project.project);
    return { number: Number(m[3]), relation, kind: 'issue', ...(other && { project: other }) };
  };
  for (const m of clean.matchAll(new RegExp(`\\b(?:fix(?:es|ed|ing)?|close[sd]?|closing|resolve[sd]?|resolving|implement(?:s|ed|ing)?)\\s*:?\\s+${issue}`, 'gi'))) {
    add(issueRef(m, 'fixes'));
  }
  for (const m of clean.matchAll(new RegExp(issue, 'g'))) add(issueRef(m, 'mentions'));
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
 * The full path of the project an issue reference names, or undefined when it is `own`. GitLab
 * reads a path without a slash ("tracker#12") as a project in the same group.
 */
function otherProject(path: string | undefined, own: string): string | undefined {
  if (!path) return undefined;
  const group = own.includes('/') ? own.slice(0, own.lastIndexOf('/')) : '';
  const full = path.includes('/') || !group ? path : `${group}/${path}`;
  return full.toLowerCase() === own.toLowerCase() ? undefined : full;
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
  const base = gitlabBase(gitlabUrl);
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
type ApiIssue = {
  iid: number;
  title: string;
  description?: string | null;
  web_url: string;
  state?: string;
  labels?: string[];
  author?: GitLabUser;
  created_at?: string;
};

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

  /**
   * A merge request with its comments, or an issue as it sits on the board: state, labels, who
   * opened it, its description and comments. `project` reads it from another project on this GitLab.
   */
  async issue(n: number, kind: 'issue' | 'pr' = 'issue', project?: string): Promise<{ issue: LinkedIssue; discussion: Review[] } | undefined> {
    if (kind === 'pr') {
      const found = await this.get<ApiMr>(`/merge_requests/${n}`, project);
      if (!found) return undefined;
      const notes = await this.get<ApiNote[]>(`/merge_requests/${n}/notes?per_page=100&sort=asc`, project);
      const body = clip(stripTemplate(found.description ?? ''), KEEP.issueBodyChars);
      return {
        issue: { number: found.iid, title: found.title, url: found.web_url, kind, ...(project && { project }), ...(body && { body }) },
        discussion: (notes ?? []).map((note) => toReview(note, found.web_url)).filter((r): r is Review => r !== undefined),
      };
    }
    const found = await this.get<ApiIssue>(`/issues/${n}`, project);
    if (!found) return undefined;
    const notes = (await this.get<ApiNote[]>(`/issues/${n}/notes?per_page=100&sort=asc`, project)) ?? [];
    const body = clip(stripTemplate(found.description ?? ''), KEEP.boardIssueBodyChars);
    const comments = notes
      .map((note) => toReview(note, found.web_url))
      .filter((r): r is Review => r !== undefined)
      .slice(-KEEP.issueComments);
    const author = found.author?.username;
    return {
      issue: {
        number: found.iid,
        title: found.title,
        url: found.web_url,
        kind,
        ...(project && { project }),
        ...(found.state && { state: found.state }),
        ...(found.labels && found.labels.length > 0 && { labels: found.labels }),
        ...(author && { author }),
        ...(found.created_at && { date: found.created_at }),
        ...(body && { body }),
        comments,
      },
      discussion: [],
    };
  }

  /**
   * GET a path under the project, or under another project on the same GitLab. Resolves undefined
   * for 404 (unknown commit, MR or issue, or no access).
   */
  private async get<T>(route: string, project = this.project.project): Promise<T | undefined> {
    if (this.fatal) throw this.fatal;
    // Kept apart by whether a token was sent, as for GitHub: a private project is a 404 without one.
    const cacheKey = `gitlab:${this.options.token ? 'token' : 'anon'}:${this.project.url}/${project}${route}`;
    const cached = await this.options.cache?.get(cacheKey);
    if (cached) return (cached.data ?? undefined) as T | undefined;
    const base = project === this.project.project ? this.base : `${this.project.url}/api/v4/projects/${encodeURIComponent(project)}`;

    for (let attempt = 0; ; attempt++) {
      let response: Response;
      try {
        response = await this.doFetch(`${base}${route}`, {
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
