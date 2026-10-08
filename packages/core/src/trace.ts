import path from 'node:path';
import { runGit, GitError, type GitRunner } from './git.js';
import { LOG_FORMAT, parseLineLog, postImage, preImage, type RawCommit } from './lineLog.js';
import { classifyNoise } from './noise.js';
import type { TimelineCache } from './cache.js';
import type { NoiseCommit, Step, Timeline } from './types.js';
import { parseGitLabRemote } from './gitlab.js';

export type TraceOptions = {
  /** Absolute path, or relative to `cwd`. */
  file: string;
  /** 1-based inclusive line range as it is at HEAD. */
  start: number;
  end: number;
  cwd?: string;
  /** Keep noise commits in `steps` instead of filtering them out. */
  keepNoise?: boolean;
  git?: GitRunner;
  /** When given, a timeline for the same repo, file, range and HEAD is reused. */
  cache?: TimelineCache;
  /** Called with short progress lines such as "Tracing 19 commits". */
  onProgress?: (message: string) => void;
  /** A self-hosted GitLab, e.g. "https://git.example.com". Needed to find it when its host has no "gitlab" in it. */
  gitlabUrl?: string;
};

/** Where a file lives in its repository. */
export type FileLocation = { root: string; relativePath: string };

export async function locateFile(file: string, cwd = process.cwd(), git: GitRunner = runGit): Promise<FileLocation> {
  const absolute = path.resolve(cwd, file);
  const dir = path.dirname(absolute);
  let root: string;
  let prefix: string;
  try {
    root = (await git(['rev-parse', '--show-toplevel'], dir)).trim();
    prefix = (await git(['rev-parse', '--show-prefix'], dir)).trim();
  } catch (error) {
    throw new Error(`${file} is not inside a git repository`, { cause: error });
  }
  const relativePath = path.posix.join(prefix, path.basename(absolute));
  try {
    await git(['ls-files', '--error-unmatch', '--', relativePath], root);
  } catch (error) {
    throw new Error(`${relativePath} is not tracked by git, so it has no history yet`, { cause: error });
  }
  return { root, relativePath };
}

export async function trace(options: TraceOptions): Promise<Timeline> {
  const git = options.git ?? runGit;
  const { start, end } = options;
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start) {
    throw new Error(`Invalid line range ${start}-${end}: expected 1 <= start <= end`);
  }

  const { root, relativePath } = await locateFile(options.file, options.cwd, git);
  const head = (await git(['rev-parse', 'HEAD'], root)).trim();

  const warnings: string[] = [];
  if (await hasUncommittedChanges(git, root, relativePath)) {
    warnings.push(
      `${relativePath} has uncommitted changes. Line numbers are matched against the last commit, so the traced lines may differ from what you selected.`,
    );
  }

  const { github, gitlab } = await originRepo(git, root, options.gitlabUrl);
  const host = { ...(github && { github }), ...(gitlab && { gitlab }) };
  const cacheKey = { root, file: relativePath, range: [start, end] as [number, number], head };
  const cached = options.keepNoise ? undefined : await options.cache?.get(cacheKey);
  if (cached) return { ...cached, ...host, warnings: [...warnings, ...cached.warnings] };

  options.onProgress?.('Tracing history');
  let output: string;
  try {
    output = await git(
      ['log', `-L${start},${end}:${relativePath}`, `--format=${LOG_FORMAT}`, '--no-color', '--no-ext-diff', 'HEAD'],
      root,
    );
  } catch (error) {
    if (error instanceof GitError && /has only \d+ lines?/.test(error.stderr)) {
      throw new Error(`Lines ${start}-${end} are past the end of ${relativePath} at HEAD`, { cause: error });
    }
    throw error;
  }

  const raw = parseLineLog(output).reverse(); // oldest first
  options.onProgress?.(`Tracing ${raw.length} commits`);
  const timeline = buildTimeline(raw, { file: relativePath, range: [start, end], head, keepNoise: options.keepNoise });
  if (!options.keepNoise) await options.cache?.set(cacheKey, timeline);
  return { ...timeline, ...host, warnings: [...warnings, ...timeline.warnings] };
}

/** Pure part of the trace: turns parsed commits (oldest first) into a Timeline. */
export function buildTimeline(
  raw: RawCommit[],
  meta: { file: string; range: [number, number]; head: string; keepNoise?: boolean },
): Timeline {
  const steps: Step[] = [];
  const noise: NoiseCommit[] = [];

  raw.forEach((entry, index) => {
    const isOrigin = index === 0 || entry.created || preImage(entry.hunks).length === 0;
    const reason = isOrigin ? undefined : classifyNoise(entry.hunks);
    if (reason && !meta.keepNoise) {
      noise.push({ commit: entry.commit, reason });
      return;
    }
    const { lines, added } = postImage(entry.hunks);
    steps.push({
      commit: entry.commit,
      snapshot: lines.join('\n'),
      startLine: entry.hunks[0]?.newStart ?? meta.range[0],
      addedLines: added,
      removedLines: entry.hunks.flatMap((h) => h.lines.filter((l) => l.kind === 'removed').map((l) => l.text)),
      diff: entry.diff,
      reviews: [],
      issues: [],
    });
  });

  return { file: meta.file, range: meta.range, head: meta.head, skipped: noise.length, steps, noise, warnings: [] };
}

async function hasUncommittedChanges(git: GitRunner, root: string, relativePath: string): Promise<boolean> {
  try {
    await git(['diff', '--quiet', 'HEAD', '--', relativePath], root);
    return false;
  } catch (error) {
    if (error instanceof GitError && error.exitCode === 1) return true;
    throw error;
  }
}

/** owner/repo for a github.com `origin` remote (https or ssh form), else undefined. */
export function parseGitHubRemote(url: string): { owner: string; repo: string } | undefined {
  const match = /^(?:(?:https?|ssh|git):\/\/)?(?:[^@/\s]+@)?github\.com(?::\d+)?[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(url.trim());
  return match ? { owner: match[1]!, repo: match[2]! } : undefined;
}

/** The GitHub repository or GitLab project behind `origin`, if either. */
async function originRepo(git: GitRunner, root: string, gitlabUrl?: string): Promise<Pick<Timeline, 'github' | 'gitlab'>> {
  let remote: string;
  try {
    remote = await git(['remote', 'get-url', 'origin'], root);
  } catch {
    return {}; // no origin remote
  }
  const github = parseGitHubRemote(remote);
  return github ? { github } : { gitlab: parseGitLabRemote(remote, gitlabUrl) };
}
