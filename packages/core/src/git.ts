import { execFile } from 'node:child_process';

export class GitError extends Error {
  constructor(
    message: string,
    readonly args: string[],
    readonly stderr: string,
    readonly exitCode: number | null,
  ) {
    super(message);
    this.name = 'GitError';
  }
}

export type GitRunner = (args: string[], cwd: string) => Promise<string>;

/** Runs git and resolves with stdout. Rejects with GitError on a non-zero exit. */
export const runGit: GitRunner = (args, cwd) =>
  new Promise((resolve, reject) => {
    execFile(
      'git',
      args,
      { cwd, maxBuffer: 256 * 1024 * 1024, encoding: 'utf8', env: { ...process.env, GIT_PAGER: 'cat', LC_ALL: 'C' } },
      (error, stdout, stderr) => {
        if (error) {
          const code = typeof error.code === 'number' ? error.code : null;
          const detail = stderr.trim() || error.message;
          reject(new GitError(`git ${args[0]} failed: ${detail}`, args, stderr, code));
        } else {
          resolve(stdout);
        }
      },
    );
  });
