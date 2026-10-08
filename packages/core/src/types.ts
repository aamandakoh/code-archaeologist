/** The one shape every package passes around. See the spec's Architecture section. */
export type Timeline = {
  /** Path relative to the repository root, as it is at HEAD. */
  file: string;
  /** 1-based inclusive line range at HEAD. */
  range: [number, number];
  /** Full SHA of HEAD when the trace ran. */
  head: string;
  /** Number of noise commits filtered out of `steps`. */
  skipped: number;
  /** Oldest first. */
  steps: Step[];
  /** Commits filtered out as noise, oldest first, so the panel can list them. */
  noise: NoiseCommit[];
  /** The GitHub repository behind `origin`, when there is one. Used for links. */
  github?: { owner: string; repo: string };
  /** The GitLab project behind `origin`, when there is one: its web root and full path. */
  gitlab?: { url: string; project: string };
  /** Things the reader should know, e.g. uncommitted edits in the file. */
  warnings: string[];
  /** PRs, reviews and issues found on GitHub (milestone 3). Absent when not looked up. */
  context?: GitHubContext;
  /** What was read from Jira. Absent when no Jira URL is set. */
  jira?: JiraContext;
  /** AI output (milestone 2). Absent when no key is configured. */
  story?: Story;
};

export type Commit = {
  sha: string;
  /** ISO 8601 author date. */
  date: string;
  author: string;
  message: string;
};

export type Step = {
  commit: Commit;
  /** The traced lines as they were right after this commit. */
  snapshot: string;
  /** 1-based line number in the file where `snapshot` starts at this commit. */
  startLine: number;
  /** 1-based offsets into `snapshot` of the lines this commit introduced or changed. */
  addedLines: number[];
  /** Lines this commit removed from the range (the pre-image side of the diff). */
  removedLines: string[];
  /** The raw diff hunk(s) for the traced lines, used later as model input. */
  diff: string;
  /** The pull request that merged this commit, from GitHub (milestone 3). */
  pr?: { number: number; title: string; body: string; url: string };
  /**
   * Review comments on this file, review summaries and conversation comments, oldest first.
   * `on` is set when the comment was posted on another PR, e.g. the PR a revert undid.
   */
  reviews: Review[];
  /** Issues and pull requests the commit or its PR names as fixed, closed or reverted. */
  issues: LinkedIssue[];
  /** Jira tickets the commit message or its PR names, e.g. "PAY-412". Absent when Jira was not read. */
  tickets?: JiraTicket[];
};

export type JiraTicket = {
  /** "PAY-412". Cited as "jira:PAY-412". */
  key: string;
  /** The ticket's summary. */
  title: string;
  url: string;
  /** "Bug", "Story", "Task". */
  type?: string;
  /** "Done", "In Progress". */
  status?: string;
  reporter?: string;
  /** ISO 8601, when it was created. */
  date?: string;
  /** Description as plain text, trimmed. */
  body?: string;
  /** Oldest first. */
  comments: Review[];
};

/** What was read from Jira for a timeline. */
export type JiraContext = {
  /** The Jira site, as normalised from settings. */
  url: string;
  /** Whether credentials were sent. */
  token: boolean;
  tickets: number;
  /** Set when some or all tickets could not be read. The timeline is still usable. */
  error?: string;
};

export type Review = {
  author: string;
  body: string;
  url: string;
  /** ISO 8601. */
  date?: string;
  /** A comment on a specific line of the file, rather than on the PR as a whole. */
  path?: string;
  /** The PR this was posted on, when it is not the step's own PR. */
  on?: number;
};

export type LinkedIssue = {
  number: number;
  title: string;
  url: string;
  /** Opening text, trimmed. */
  body?: string;
  /** "pr" for a pull request, such as the one a revert undid. */
  kind?: 'issue' | 'pr';
  /** How the commit or PR refers to it. */
  relation?: 'fixes' | 'reverts';
};

/** What milestone 3 found on GitHub or GitLab for a timeline. PRs are GitLab merge requests there. */
export type GitHubContext = {
  /** Where it came from. Absent means GitHub. */
  source?: 'github' | 'gitlab';
  /** Whether a token was used. Without one GitHub allows 60 requests an hour. */
  token: boolean;
  prs: number;
  reviews: number;
  issues: number;
  /** Set when some or all of the context could not be read. The timeline is still usable. */
  error?: string;
  /** The GitLab a token was held back from, because it is neither gitlab.com nor the configured `gitlabUrl`. */
  tokenHeldBackFrom?: string;
};

export type NoiseReason = 'whitespace' | 'formatting' | 'license-header';

export type NoiseCommit = {
  commit: Commit;
  reason: NoiseReason;
};

/** AI output (milestone 2), validated and citation-checked by `parseStory`. */
export type Story = {
  /** One sentence about the whole history. */
  summary: string;
  /** One note per step that got one, in timeline order. `commit` is the full SHA. */
  steps: { commit: string; note: string; citations: string[]; flagged?: boolean }[];
  verdict: {
    level: 'low' | 'medium' | 'high';
    reasons: { text: string; citations: string[]; flagged?: boolean }[];
    checks: string[];
  };
  /** The model that wrote it. */
  model: string;
  /** Commits sent to the model as subject only, because the history was long. */
  reduced: number;
};

/**
 * Citations look like "commit:b35fa73", "pr:49659", "issue:123", "review:b35fa73-1" or "jira:PAY-412".
 * `flagged` means none of the model's citations matched the evidence, so the claim is unverified.
 */
export type Citation = string;
