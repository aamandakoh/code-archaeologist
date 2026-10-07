import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { TimelineCache, trace } from '../src/index.js';

// End-to-end against a real git repository built on the fly.
let repo: string;

function git(...args: string[]) {
  execFileSync('git', args, {
    cwd: repo,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Ada',
      GIT_AUTHOR_EMAIL: 'ada@example.com',
      GIT_COMMITTER_NAME: 'Ada',
      GIT_COMMITTER_EMAIL: 'ada@example.com',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
    },
  });
}

function commit(file: string, content: string, message: string, date: string) {
  writeFileSync(path.join(repo, file), content);
  git('add', file);
  git('commit', '-q', '-m', message, '--date', date);
}

beforeAll(() => {
  repo = mkdtempSync(path.join(tmpdir(), 'archaeologist-'));
  git('init', '-q', '-b', 'main');
  commit('a.ts', 'header\nfunction f() {\n  return 1;\n}\nfooter\n', 'add f', '2024-01-01T00:00:00Z');
  commit('a.ts', 'header\nfunction f() {\n    return 1;\n}\nfooter\n', 'style: indent', '2024-02-01T00:00:00Z');
  commit('a.ts', 'header\nnew line\nfunction f() {\n    return 2;\n}\nfooter\n', 'fix: return 2 (#12)', '2024-03-01T00:00:00Z');
  commit('other.ts', 'unrelated\n', 'unrelated', '2024-04-01T00:00:00Z');
});

afterAll(() => rmSync(repo, { recursive: true, force: true }));

describe('trace', () => {
  test('follows the selected lines through a shift and skips the whitespace commit', async () => {
    const timeline = await trace({ file: path.join(repo, 'a.ts'), start: 3, end: 5 });
    expect(timeline.file).toBe('a.ts');
    expect(timeline.head).toMatch(/^[0-9a-f]{40}$/);
    expect(timeline.steps.map((s) => s.commit.message)).toEqual(['add f', 'fix: return 2 (#12)']);
    expect(timeline.noise.map((n) => n.commit.message)).toEqual(['style: indent']);
    expect(timeline.steps[1]).toMatchObject({
      snapshot: 'function f() {\n    return 2;\n}',
      startLine: 3,
      addedLines: [2],
      removedLines: ['    return 1;'],
    });
    expect(timeline.warnings).toEqual([]);
  });

  test('works with a path relative to cwd from a subdirectory-free repo', async () => {
    const timeline = await trace({ file: 'a.ts', cwd: repo, start: 3, end: 5 });
    expect(timeline.steps).toHaveLength(2);
  });

  test('warns about uncommitted edits', async () => {
    writeFileSync(path.join(repo, 'a.ts'), 'edited\n');
    try {
      const timeline = await trace({ file: path.join(repo, 'a.ts'), start: 1, end: 1 });
      expect(timeline.warnings[0]).toMatch(/uncommitted changes/);
    } finally {
      git('checkout', '--', 'a.ts');
    }
  });

  test('explains a range past the end of the file', async () => {
    await expect(trace({ file: path.join(repo, 'a.ts'), start: 50, end: 60 })).rejects.toThrow(/past the end/);
  });

  test('rejects untracked files and bad ranges', async () => {
    writeFileSync(path.join(repo, 'new.ts'), 'x\n');
    await expect(trace({ file: path.join(repo, 'new.ts'), start: 1, end: 1 })).rejects.toThrow(/not tracked/);
    await expect(trace({ file: path.join(repo, 'a.ts'), start: 4, end: 2 })).rejects.toThrow(/Invalid line range/);
  });

  test('caches by HEAD', async () => {
    const cache = new TimelineCache(path.join(repo, '.cache'));
    let calls = 0;
    const counting = async (args: string[], cwd: string) => {
      if (args[0] === 'log') calls++;
      return execFileSync('git', args, { cwd, encoding: 'utf8' });
    };
    const first = await trace({ file: path.join(repo, 'a.ts'), start: 3, end: 5, cache, git: counting });
    const second = await trace({ file: path.join(repo, 'a.ts'), start: 3, end: 5, cache, git: counting });
    expect(calls).toBe(1);
    expect(second).toEqual(first);
  });
});

describe('parseGitHubRemote', () => {
  test('reads https and ssh remotes', async () => {
    const { parseGitHubRemote } = await import('../src/index.js');
    expect(parseGitHubRemote('https://github.com/angular/angular.git\n')).toEqual({ owner: 'angular', repo: 'angular' });
    expect(parseGitHubRemote('git@github.com:aamandakoh/code-archaeologist.git')).toEqual({
      owner: 'aamandakoh',
      repo: 'code-archaeologist',
    });
    expect(parseGitHubRemote('https://gitlab.com/a/b.git')).toBeUndefined();
  });
});
