import type { Commit } from './types.js';

/**
 * Format string for `git log -L`. Each commit starts with a record separator and a
 * marker, and the message ends with a unit separator, so commit messages can contain
 * anything (including diff-like text) without confusing the parser.
 */
export const COMMIT_MARKER = '\x1eARCH-COMMIT\n';
export const LOG_FORMAT = '%x1eARCH-COMMIT%n%H%n%aI%n%an%n%B%x1f';

export type HunkLine = { kind: 'context' | 'added' | 'removed'; text: string };

export type Hunk = {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: HunkLine[];
};

export type RawCommit = {
  commit: Commit;
  /** True when the file did not exist before this commit (`--- /dev/null`). */
  created: boolean;
  hunks: Hunk[];
  /** The diff text as git printed it, headers included. */
  diff: string;
};

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** Parses `git log -L <range>:<file> --format=LOG_FORMAT` output. Newest first, like git. */
export function parseLineLog(output: string): RawCommit[] {
  const commits: RawCommit[] = [];
  for (const chunk of output.split(COMMIT_MARKER)) {
    if (chunk.trim() === '') continue;
    const messageEnd = chunk.indexOf('\x1f');
    if (messageEnd === -1) throw new Error('Unexpected git log output: missing message terminator');
    const header = chunk.slice(0, messageEnd);
    const diff = chunk.slice(messageEnd + 1).replace(/^\n+/, '').replace(/\n+$/, '');

    const [sha = '', date = '', author = '', ...messageLines] = header.split('\n');
    const commit: Commit = { sha, date, author, message: messageLines.join('\n').trim() };
    commits.push({ commit, ...parseDiff(diff), diff });
  }
  return commits;
}

function parseDiff(diff: string): { created: boolean; hunks: Hunk[] } {
  const lines = diff === '' ? [] : diff.split('\n');
  const hunks: Hunk[] = [];
  let created = false;
  let current: Hunk | undefined;
  // Lines still expected in the current hunk, from its header counts. Counting keeps a
  // removed line such as "-- foo" from being mistaken for a "--- a/file" header.
  let oldLeft = 0;
  let newLeft = 0;

  for (const line of lines) {
    if (current && (oldLeft > 0 || newLeft > 0)) {
      const marker = line[0];
      const text = line.slice(1);
      if (marker === '+') {
        current.lines.push({ kind: 'added', text });
        newLeft--;
      } else if (marker === '-') {
        current.lines.push({ kind: 'removed', text });
        oldLeft--;
      } else if (marker === ' ' || line === '') {
        current.lines.push({ kind: 'context', text });
        oldLeft--;
        newLeft--;
      }
      // "\ No newline at end of file" and anything else is ignored.
      continue;
    }
    if (line.startsWith('\\')) continue;

    const match = HUNK_HEADER.exec(line);
    if (match) {
      current = {
        oldStart: Number(match[1]),
        oldCount: match[2] === undefined ? 1 : Number(match[2]),
        newStart: Number(match[3]),
        newCount: match[4] === undefined ? 1 : Number(match[4]),
        lines: [],
      };
      oldLeft = current.oldCount;
      newLeft = current.newCount;
      hunks.push(current);
      continue;
    }
    if (line === '--- /dev/null') created = true;
  }
  return { created, hunks };
}

/** The traced lines after the commit, and which of them (1-based) the commit added. */
export function postImage(hunks: Hunk[]): { lines: string[]; added: number[] } {
  const lines: string[] = [];
  const added: number[] = [];
  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      if (line.kind === 'removed') continue;
      lines.push(line.text);
      if (line.kind === 'added') added.push(lines.length);
    }
  }
  return { lines, added };
}

/** The traced lines before the commit. */
export function preImage(hunks: Hunk[]): string[] {
  return hunks.flatMap((h) => h.lines.filter((l) => l.kind !== 'added').map((l) => l.text));
}
