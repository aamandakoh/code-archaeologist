import { clip, stripTemplate } from './github.js';
import type { JiraContext, JiraTicket, Review, Step, Timeline } from './types.js';

export type JiraOptions = {
  /** The Jira site, e.g. "https://yourcompany.atlassian.net". Credentials are only ever sent here. */
  url: string;
  /** Jira Cloud: the Atlassian account email that goes with an API token. Leave out for a Data Center or Server personal access token. */
  email?: string;
  /** A Jira Cloud API token, or a Data Center or Server personal access token. Without one only public tickets can be read. */
  token?: string;
  /** Project keys to match, e.g. ["PAY", "CORE"]. Empty matches any ABC-123, minus a few that are rarely tickets. */
  projects?: string[];
  /** Comment authors to leave out, by display name, username or email, e.g. ["gitlab-bot"]. Case does not matter. */
  ignoreAuthors?: string[];
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
  /** Requests in flight at once. */
  concurrency?: number;
  fetch?: typeof fetch;
};

/** Per-ticket limits on what is kept, before the prompt applies its own. */
const KEEP = { bodyChars: 2_000, commentChars: 1_000, comments: 20 };

/** Look like ticket keys but almost never are: "UTF-8", "SHA-256", "ISO-8601", "RFC-7231". */
const NOT_TICKETS = new Set(['UTF', 'SHA', 'ISO', 'RFC', 'CVE', 'CWE', 'MD', 'AES', 'RSA', 'HTTP', 'TLS', 'SSL', 'IPV', 'X', 'ES', 'PEP', 'GPL', 'LGPL', 'BSD', 'CC', 'UTC', 'GMT']);

/**
 * Jira keys named in some text, in order, once each: "PAY-412", "[CORE-7]", "pay-412" does not count.
 * With `projects`, only those project keys match.
 */
export function jiraKeys(text: string, projects: string[] = []): string[] {
  const only = new Set(projects.map((p) => p.trim().toUpperCase()).filter(Boolean));
  const out = new Set<string>();
  for (const m of text.matchAll(/(?<![\w/-])([A-Z][A-Z\d_]{0,19})-([1-9]\d{0,7})(?![\w-])/g)) {
    const project = m[1]!;
    if (only.size > 0 ? !only.has(project) : NOT_TICKETS.has(project)) continue;
    out.add(`${project}-${m[2]}`);
  }
  return [...out];
}

/** "gitlab-bot, Jenkins CI" → ["gitlab-bot", "Jenkins CI"]: names may hold spaces, so only commas, semicolons and new lines split. */
export function parseNameList(text: string | undefined): string[] {
  return (text ?? '')
    .split(/[,;\n]+/)
    .map((n) => n.trim())
    .filter(Boolean);
}

/**
 * A comment that only says a commit, branch or merge request mentioned the ticket, as the GitLab,
 * GitHub and Bitbucket integrations post: "[Ann|…] mentioned this issue in [a commit of team/app|…]".
 */
export function isMentionNotice(body: string): boolean {
  return /\bmentioned (?:this|the) (?:issue|ticket|work item) in (?:an? )?(?:\[?\s*)?(?:commit|branch|merge request|pull request|MR|PR)\b/i.test(body.slice(0, 300));
}

/** "PAY, core" → ["PAY", "CORE"]. */
export function parseProjectKeys(text: string | undefined): string[] {
  return (text ?? '')
    .split(/[\s,;]+/)
    .map((p) => p.trim().toUpperCase())
    .filter((p) => /^[A-Z][A-Z\d_]*$/.test(p));
}

/** The Jira site as typed, with https:// assumed and any trailing slash or /browse/... path dropped. */
export function jiraBase(url: string | undefined): string | undefined {
  const u = url?.trim();
  if (!u) return undefined;
  try {
    const parsed = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(u) ? u : `https://${u}`);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return undefined;
    const pathname = parsed.pathname.replace(/\/(?:browse|projects|jira)(?:\/.*)?$/, '').replace(/\/+$/, '');
    return `${parsed.origin}${pathname}`;
  } catch {
    return undefined;
  }
}

/**
 * Reads the Jira tickets each step's commit message, PR or MR title and description name, and
 * puts them on `step.tickets`. Best effort: on a failure the timeline comes back with what was
 * read and `jira.error` says what went wrong.
 */
export async function addJiraContext(timeline: Timeline, options: JiraOptions): Promise<Timeline> {
  const base = jiraBase(options.url);
  if (!base || timeline.steps.length === 0) return timeline;
  const api = new JiraApi(base, options);
  const projects = options.projects ?? [];
  const keysOf = new Map<Step, string[]>();
  for (const step of timeline.steps) {
    keysOf.set(step, jiraKeys([step.commit.message, step.pr?.title ?? '', step.pr?.body ?? ''].join('\n'), projects));
  }
  const wanted = [...new Set([...keysOf.values()].flat())];
  const context: JiraContext = { url: base, token: Boolean(options.token), tickets: 0 };
  const found = new Map<string, JiraTicket>();
  if (wanted.length > 0) {
    options.onProgress?.(`Reading ${wanted.length} Jira ticket${wanted.length === 1 ? '' : 's'}`);
    try {
      await mapLimit(wanted, options.concurrency ?? 4, async (key) => {
        const ticket = await api.ticket(key);
        if (ticket) found.set(key, ticket);
      });
    } catch (error) {
      if (options.signal?.aborted) throw error;
      context.error = error instanceof Error ? error.message : String(error);
    }
    if (!context.error && found.size === 0) {
      context.error = options.token
        ? `Jira found none of ${wanted.join(', ')}. Check that the token can read those projects.`
        : `Jira found none of ${wanted.join(', ')}. If they are not public, set a Jira token.`;
    }
  }
  const steps = timeline.steps.map((step) => ({ ...step, tickets: (keysOf.get(step) ?? []).flatMap((k) => found.get(k) ?? []) }));
  context.tickets = found.size;
  return { ...timeline, steps, jira: context };
}

/** Checks the URL and credentials, and says in a sentence who Jira takes you for. Throws a JiraError saying what to fix. */
export async function checkJira(options: JiraOptions): Promise<string> {
  const base = jiraBase(options.url);
  if (!base) throw new JiraError('Set the Jira URL, e.g. https://yourcompany.atlassian.net.');
  const api = new JiraApi(base, options);
  if (!options.token) {
    const info = await api.get<{ serverTitle?: string }>('/serverInfo');
    if (!info) throw new JiraError(`No Jira REST API at ${base}. Check the Jira URL.`, 404);
    return `Reached ${info.serverTitle || base}. Without a token only public tickets can be read.`;
  }
  const me = await api.get<{ displayName?: string; name?: string; emailAddress?: string }>('/myself');
  if (!me) throw new JiraError(`No Jira REST API at ${base}. Check the Jira URL.`, 404);
  return `Connected as ${me.displayName || me.name || me.emailAddress || 'unknown user'}.`;
}

export class JiraError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = 'JiraError';
  }
}

type ApiUser = { displayName?: string; name?: string; emailAddress?: string; accountType?: string } | null | undefined;
type ApiComment = { id: string; body?: unknown; author?: ApiUser; created?: string };
type ApiIssue = {
  key: string;
  fields: {
    summary?: string;
    description?: unknown;
    issuetype?: { name?: string } | null;
    status?: { name?: string } | null;
    reporter?: ApiUser;
    created?: string;
    comment?: { comments?: ApiComment[] } | null;
  };
};

class JiraApi {
  private readonly doFetch: typeof fetch;
  /** Set on the first failure that would fail every later request too (bad token, rate limit). */
  private fatal?: JiraError;

  constructor(
    private readonly base: string,
    private readonly options: JiraOptions,
  ) {
    this.doFetch = options.fetch ?? fetch;
  }

  async ticket(key: string): Promise<JiraTicket | undefined> {
    const issue = await this.get<ApiIssue>(`/issue/${encodeURIComponent(key)}?fields=summary,description,issuetype,status,reporter,created,comment`);
    if (!issue) return undefined;
    const f = issue.fields ?? {};
    const url = `${this.base}/browse/${issue.key}`;
    const comments = (f.comment?.comments ?? [])
      .map((c): Review | undefined => {
        const raw = text(c.body);
        if (!raw || isBot(c.author) || this.ignored(c.author) || isMentionNotice(raw)) return undefined;
        const body = clip(stripTemplate(raw), KEEP.commentChars);
        if (!body) return undefined;
        return { author: who(c.author), body, url: `${url}?focusedCommentId=${c.id}`, ...(c.created && { date: c.created }) };
      })
      .filter((c): c is Review => c !== undefined)
      .slice(-KEEP.comments);
    const body = clip(stripTemplate(text(f.description)), KEEP.bodyChars);
    return {
      key: issue.key,
      title: f.summary ?? issue.key,
      url,
      ...(f.issuetype?.name && { type: f.issuetype.name }),
      ...(f.status?.name && { status: f.status.name }),
      ...(f.reporter && { reporter: who(f.reporter) }),
      ...(f.created && { date: f.created }),
      ...(body && { body }),
      comments,
    };
  }

  private ignored(user: ApiUser): boolean {
    const names = new Set((this.options.ignoreAuthors ?? []).map((n) => n.trim().toLowerCase()).filter(Boolean));
    return [user?.displayName, user?.name, user?.emailAddress].some((n) => n !== undefined && names.has(n.toLowerCase()));
  }

  /** GET a path under the REST API. Resolves undefined for 404 (no such ticket, or no access to it). */
  async get<T>(route: string): Promise<T | undefined> {
    if (this.fatal) throw this.fatal;
    const { email, token } = this.options;
    // Jira Cloud takes the email and API token as basic auth; Data Center and Server take a personal access token as a bearer token.
    const auth = token ? (email?.trim() ? `Basic ${Buffer.from(`${email.trim()}:${token}`).toString('base64')}` : `Bearer ${token}`) : undefined;
    for (let attempt = 0; ; attempt++) {
      let response: Response;
      try {
        response = await this.doFetch(`${this.base}/rest/api/2${route}`, {
          headers: { accept: 'application/json', ...(auth && { authorization: auth }) },
          signal: this.options.signal,
        });
      } catch (error) {
        if (this.options.signal?.aborted || attempt >= 1) throw new JiraError(`Could not reach Jira at ${this.base}: ${String(error)}`);
        continue;
      }
      if (response.ok) {
        const type = response.headers.get('content-type') ?? '';
        // A login page or a proxy's HTML instead of the API.
        if (!type.includes('json')) throw (this.fatal = new JiraError(`${this.base} did not answer like Jira. Check the Jira URL.`));
        return (await response.json()) as T;
      }
      if (response.status === 404) return undefined;
      if (response.status >= 500 && attempt < 1) continue;
      throw (this.fatal = await this.failure(response));
    }
  }

  private async failure(response: Response): Promise<JiraError> {
    const detail = await response
      .json()
      .then((b: { errorMessages?: unknown[]; message?: unknown }) => String(b.errorMessages?.[0] ?? b.message ?? ''))
      .catch(() => '');
    const status = response.status;
    if (status === 401) {
      const hint = this.options.email?.trim()
        ? 'Check the email and API token.'
        : this.base.endsWith('.atlassian.net')
          ? 'Jira Cloud needs your Atlassian email with the API token.'
          : 'Check the personal access token.';
      return new JiraError(`Jira rejected the credentials. ${hint}`, status);
    }
    if (status === 429) return new JiraError("Jira's rate limit was reached, so some tickets were not read.", status);
    if (status === 403) return new JiraError(`Jira refused access${detail ? `: ${detail}` : ''}.`, status);
    return new JiraError(`Jira answered ${status}${detail ? `: ${detail}` : ''}.`, status);
  }
}

function who(user: ApiUser): string {
  return user?.displayName || user?.name || 'unknown';
}

function isBot(user: ApiUser): boolean {
  return user?.accountType === 'app' || /\b(?:bot|automation)\b/i.test(user?.displayName ?? '');
}

/**
 * Plain text from a Jira field: API v2 gives wiki markup as a string; some sites give Atlassian
 * Document Format, a tree of nodes, which is flattened here.
 */
function text(value: unknown): string {
  if (typeof value === 'string') return wiki(value).trim();
  if (!value || typeof value !== 'object') return '';
  const out: string[] = [];
  const walk = (node: { type?: string; text?: string; content?: unknown[]; attrs?: { text?: string } }) => {
    if (node.text) out.push(node.text);
    else if (node.type === 'mention' && node.attrs?.text) out.push(node.attrs.text);
    else if (node.type === 'hardBreak') out.push('\n');
    for (const child of node.content ?? []) walk(child as typeof node);
    if (node.type === 'paragraph' || node.type === 'heading' || node.type === 'listItem') out.push('\n');
  };
  walk(value as Parameters<typeof walk>[0]);
  return out.join('').replace(/\n{3,}/g, '\n\n').trim();
}

/** The wiki markup that gets in the way of reading: {code}, {noformat}, [text|url] links, h2. headings. */
function wiki(s: string): string {
  return s
    .replace(/\{(?:code|noformat|quote|panel)(?::[^}]*)?\}/g, '')
    .replace(/\[([^|\]]+)\|[^\]]+\]/g, '$1')
    .replace(/^h[1-6]\.\s*/gm, '')
    .replace(/\r\n/g, '\n');
}

async function mapLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await fn(items[next++]!);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}
