import { describe, expect, test } from 'vitest';
import { addGitLabContext, buildStoryPrompt, tokenAllowed, gitlabLinkedRefs, mrFromMessage, parseGitLabRemote, type Timeline } from '../src/index.js';

const project = { url: 'https://gitlab.example.com', project: 'platform/billing/api' };

describe('parseGitLabRemote', () => {
  test('reads gitlab hosts in ssh, scp and https form, with subgroups', () => {
    expect(parseGitLabRemote('git@gitlab.com:group/sub/repo.git')).toEqual({ url: 'https://gitlab.com', project: 'group/sub/repo' });
    expect(parseGitLabRemote('https://gitlab.example.com/platform/billing/api.git')).toEqual(project);
    expect(parseGitLabRemote('ssh://git@gitlab.example.com:2222/platform/billing/api.git')).toEqual(project);
    expect(parseGitLabRemote('https://oauth2:tok@gitlab.example.com/platform/billing/api')).toEqual(project);
  });

  test('takes any host named in gitlabUrl, including one served under a path', () => {
    expect(parseGitLabRemote('git@git.corp.example:team/repo.git')).toBeUndefined();
    expect(parseGitLabRemote('git@git.corp.example:team/repo.git', 'https://git.corp.example/')).toEqual({ url: 'https://git.corp.example', project: 'team/repo' });
    expect(parseGitLabRemote('https://corp.example/gitlab/team/repo.git', 'https://corp.example/gitlab')).toEqual({
      url: 'https://corp.example/gitlab',
      project: 'team/repo',
    });
    expect(parseGitLabRemote('git@github.com:a/b.git')).toBeUndefined();
  });
});

test('mrFromMessage reads GitLab merge commits', () => {
  expect(mrFromMessage("Merge branch 'fix' into 'main'\n\nFix rounding\n\nSee merge request platform/billing/api!42")).toBe(42);
  expect(mrFromMessage('Fix rounding (!42)')).toBe(42);
  expect(mrFromMessage('Fix rounding, see #42')).toBeUndefined();
});

test('gitlabLinkedRefs tells issues from merge requests', () => {
  expect(
    gitlabLinkedRefs(
      'Closes #7, fixes https://gitlab.example.com/platform/billing/api/-/issues/8\nReverts !12\nThis reverts commit abcdef1.',
      project,
      () => 30,
    ),
  ).toEqual([
    { number: 7, relation: 'fixes', kind: 'issue' },
    { number: 8, relation: 'fixes', kind: 'issue' },
    { number: 12, relation: 'reverts', kind: 'pr' },
    { number: 30, relation: 'reverts', kind: 'pr' },
  ]);
});

test('gitlabLinkedRefs reads mentions and issues in other projects, closing words first', () => {
  expect(
    gitlabLinkedRefs(
      'Round half up, see #9 and tracker#4\nCloses #9\nPart of platform/ops/board#2 and https://gitlab.example.com/platform/billing/api/-/issues/5\n' +
        'Also https://gitlab.example.com/platform/ops/board/-/issues/3, platform/billing/api#6, &#12; and a.b/c#',
      project,
    ),
  ).toEqual([
    { number: 9, relation: 'fixes', kind: 'issue' },
    { number: 4, relation: 'mentions', kind: 'issue', project: 'platform/billing/tracker' },
    { number: 2, relation: 'mentions', kind: 'issue', project: 'platform/ops/board' },
    { number: 5, relation: 'mentions', kind: 'issue' },
    { number: 3, relation: 'mentions', kind: 'issue', project: 'platform/ops/board' },
    { number: 6, relation: 'mentions', kind: 'issue' },
  ]);
});

describe('addGitLabContext', () => {
  const commit = (sha: string, message: string) => ({ sha, date: '2026-01-01T00:00:00Z', author: 'a', message });
  const step = (sha: string, message: string) => ({
    commit: commit(sha, message),
    snapshot: 'x',
    startLine: 1,
    addedLines: [1],
    removedLines: [],
    diff: '',
    reviews: [],
    issues: [],
  });
  const timeline: Timeline = {
    file: 'src/rounding.ts',
    range: [1, 1],
    head: 'c'.repeat(40),
    skipped: 0,
    noise: [],
    warnings: [],
    gitlab: project,
    steps: [
      step('a'.repeat(40), "Merge branch 'round' into 'main'\n\nRound half up\n\nSee merge request platform/billing/api!5"),
      step('b'.repeat(40), 'Revert "Round half up"\n\nThis reverts commit aaaaaaa.'),
    ],
  };
  const author = { username: 'reviewer' };
  const routes: Record<string, unknown> = {
    '': { id: 1 },
    '/merge_requests/5': { iid: 5, title: 'Round half up', description: 'Closes #3', web_url: 'https://gitlab.example.com/p/-/merge_requests/5' },
    '/merge_requests/5/notes?per_page=100&sort=asc': [
      { id: 1, body: 'added 1 commit', system: true, author },
      { id: 2, body: 'This breaks invoices in EUR, revert it', author },
      { id: 3, body: 'Off by one here', author, position: { new_path: 'src/rounding.ts' } },
      { id: 4, body: 'Pipeline passed', author: { username: 'project_1_bot_x' } },
    ],
    [`/repository/commits/${'b'.repeat(40)}/merge_requests`]: [
      { iid: 6, state: 'merged', title: 'Revert', web_url: 'https://gitlab.example.com/p/-/merge_requests/6' },
    ],
    '/merge_requests/6': { iid: 6, title: 'Revert "Round half up"', description: '', web_url: 'https://gitlab.example.com/p/-/merge_requests/6' },
    '/merge_requests/6/notes?per_page=100&sort=asc': [],
    '/issues/3': { iid: 3, title: 'Totals off by a cent', description: 'Seen on EUR', web_url: 'https://gitlab.example.com/p/-/issues/3' },
  };
  const base = 'https://gitlab.example.com/api/v4/projects/platform%2Fbilling%2Fapi';

  test('reads merge requests, notes and closed issues, and finds the reason for the revert', async () => {
    const headers: (Record<string, string> | undefined)[] = [];
    const fetch = (async (url: string, init?: RequestInit) => {
      headers.push(init?.headers as Record<string, string>);
      const route = String(url).slice(base.length);
      return route in routes ? new Response(JSON.stringify(routes[route])) : new Response('{"message":"404 Not found"}', { status: 404 });
    }) as typeof globalThis.fetch;
    const out = await addGitLabContext(timeline, { token: 't', gitlabUrl: 'https://gitlab.example.com/', fetch });

    expect(headers[0]!['private-token']).toBe('t');
    expect(out.context).toEqual({ source: 'gitlab', token: true, prs: 2, reviews: 3, issues: 2 });
    const [merged, revert] = out.steps;
    expect(merged!.pr?.number).toBe(5);
    expect(merged!.reviews.map((r) => r.body)).toEqual(['Off by one here', 'This breaks invoices in EUR, revert it']);
    expect(merged!.reviews[0]!.path).toBe('src/rounding.ts');
    expect(merged!.reviews[0]!.url).toBe('https://gitlab.example.com/p/-/merge_requests/5#note_3');
    expect(merged!.issues).toEqual([expect.objectContaining({ number: 3, kind: 'issue', relation: 'fixes' })]);
    expect(revert!.pr?.number).toBe(6);
    expect(revert!.reviews[0]).toMatchObject({ body: 'This breaks invoices in EUR, revert it', on: 5 });
    expect(buildStoryPrompt(out).ids).toEqual(expect.arrayContaining(['pr:5', 'pr:6', 'issue:3']));
  });

  test('reads a board issue in another project with its labels and comments, into the prompt', async () => {
    const board = 'https://gitlab.example.com/api/v4/projects/platform%2Fops%2Fboard';
    const boardRoutes: Record<string, unknown> = {
      '/issues/9': {
        iid: 9,
        title: 'EUR invoices are a cent short',
        description: 'Finance found totals off by 0.01 on EUR invoices.',
        web_url: 'https://gitlab.example.com/platform/ops/board/-/issues/9',
        state: 'closed',
        labels: ['bug', 'workflow::done'],
        author: { username: 'finance-lead' },
        created_at: '2025-12-01T09:00:00Z',
      },
      '/issues/9/notes?per_page=100&sort=asc': [
        { id: 11, body: 'mentioned in commit aaaaaaa', system: true, author },
        { id: 12, body: 'Must round half up, per the tax office.', author: { username: 'accountant' }, created_at: '2025-12-02T10:00:00Z' },
        { id: 13, body: 'Moved to Done', author: { username: 'project_7_bot_abc' } },
      ],
    };
    const fetch = (async (url: string) => {
      const u = String(url);
      const [table, route] = u.startsWith(board) ? [boardRoutes, u.slice(board.length)] : [routes, u.slice(base.length)];
      return route in table ? new Response(JSON.stringify(table[route])) : new Response('{}', { status: 404 });
    }) as typeof globalThis.fetch;
    const withBoard: Timeline = {
      ...timeline,
      steps: [step('a'.repeat(40), 'Round half up\n\nFor platform/ops/board#9 (#404 is unrelated)'), timeline.steps[1]!],
    };
    const out = await addGitLabContext(withBoard, { token: 't', gitlabUrl: 'https://gitlab.example.com', fetch });

    expect(out.steps[0]!.issues).toEqual([
      {
        number: 9,
        title: 'EUR invoices are a cent short',
        url: 'https://gitlab.example.com/platform/ops/board/-/issues/9',
        kind: 'issue',
        relation: 'mentions',
        project: 'platform/ops/board',
        state: 'closed',
        labels: ['bug', 'workflow::done'],
        author: 'finance-lead',
        date: '2025-12-01T09:00:00Z',
        body: 'Finance found totals off by 0.01 on EUR invoices.',
        comments: [expect.objectContaining({ author: 'accountant', body: 'Must round half up, per the tax office.', url: 'https://gitlab.example.com/platform/ops/board/-/issues/9#note_12' })],
      },
    ]);
    const prompt = buildStoryPrompt(out);
    expect(prompt.ids).toContain('issue:platform/ops/board#9');
    expect(prompt.user).toContain(
      'Mentions issue issue:platform/ops/board#9 (closed, labels bug, workflow::done, opened by finance-lead, 2025-12-01): EUR invoices are a cent short',
    );
    expect(prompt.user).toContain('Comment by accountant (2025-12-02): Must round half up, per the tax office.');
  });

  test('keeps the token from a host that is neither gitlab.com nor gitlabUrl', async () => {
    const headers: (Record<string, string> | undefined)[] = [];
    const fetch = (async (url: string, init?: RequestInit) => {
      headers.push(init?.headers as Record<string, string>);
      const route = String(url).slice(base.length);
      return route in routes ? new Response(JSON.stringify(routes[route])) : new Response('{}', { status: 404 });
    }) as typeof globalThis.fetch;
    const out = await addGitLabContext(timeline, { token: 't', fetch });
    expect(headers.length).toBeGreaterThan(0);
    expect(headers.every((h) => h?.['private-token'] === undefined)).toBe(true);
    expect(out.context?.token).toBe(false);
    expect(out.context?.error).toMatch(/token was not sent to gitlab\.example\.com/);
    expect(out.context?.error).toContain('set GitLab URL to https://gitlab.example.com');
    expect(out.context?.tokenHeldBackFrom).toBe('https://gitlab.example.com');
  });

  test('reads what it can without a token when comments need one', async () => {
    const fetch = (async (url: string) => {
      const route = String(url).slice(base.length);
      if (route.includes('/notes')) return new Response('{"message":"401 Unauthorized"}', { status: 401 });
      return route in routes ? new Response(JSON.stringify(routes[route])) : new Response('{}', { status: 404 });
    }) as typeof globalThis.fetch;
    const out = await addGitLabContext(timeline, { fetch });
    expect(out.steps[0]!.pr?.number).toBe(5);
    expect(out.steps[0]!.issues).toHaveLength(1);
    expect(out.context?.error).toMatch(/signed-in users\. Set a GitLab token/);
  });

  test('says a private project needs a token', async () => {
    const fetch = (async () => new Response('{"message":"404 Project Not Found"}', { status: 404 })) as typeof globalThis.fetch;
    const out = await addGitLabContext(timeline, { fetch });
    expect(out.context?.error).toMatch(/could not find platform\/billing\/api on gitlab\.example\.com\. If it is private, set a GitLab token/);
  });
});

test('tokenAllowed only trusts gitlab.com and the configured GitLab', () => {
  expect(tokenAllowed('https://gitlab.com')).toBe(true);
  expect(tokenAllowed('https://gitlab.example.com')).toBe(false);
  expect(tokenAllowed('https://gitlab.example.com', 'https://gitlab.example.com/')).toBe(true);
  expect(tokenAllowed('https://corp.example/gitlab', 'https://corp.example/gitlab')).toBe(true);
  expect(tokenAllowed('https://gitlab.com.evil.example')).toBe(false);
  expect(tokenAllowed('https://gitlab.example.com', 'not a url')).toBe(false);
  expect(tokenAllowed('https://gitlab.example.com', 'gitlab.example.com')).toBe(true);
  expect(tokenAllowed('https://gitlab.example.com', 'http://gitlab.example.com')).toBe(false);
});
