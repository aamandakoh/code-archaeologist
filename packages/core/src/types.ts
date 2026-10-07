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
  /** Things the reader should know, e.g. uncommitted edits in the file. */
  warnings: string[];
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
  /** Filled in by milestone 3. */
  pr?: { number: number; title: string; body: string; url: string };
  reviews: { author: string; body: string; url: string }[];
  issues: { number: number; title: string; url: string }[];
};

export type NoiseReason = 'whitespace' | 'formatting' | 'license-header';

export type NoiseCommit = {
  commit: Commit;
  reason: NoiseReason;
};

/** Placeholder for milestone 2; validated with zod there. */
export type Story = {
  summary: string;
  steps: { commit: string; note: string; citations: string[] }[];
  verdict: {
    level: 'low' | 'medium' | 'high';
    reasons: { text: string; citations: string[] }[];
    checks: string[];
  };
};
