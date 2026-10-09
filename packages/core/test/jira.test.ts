import { describe, expect, test } from 'vitest';
import { addJiraContext, buildStoryPrompt, checkJira, isMentionNotice, parseNameList, jiraBase, jiraKeys, parseProjectKeys, parseStory, type Timeline } from '../src/index.js';

describe('jiraKeys', () => {
  test('finds keys once each, in order, and skips UTF-8 and friends', () => {
    expect(jiraKeys('PAY-412 Round per line\n\nSee [CORE-7], PAY-412 again. UTF-8, SHA-256, ISO-8601.')).toEqual(['PAY-412', 'CORE-7']);
    expect(jiraKeys('pay-412, PAY-0, feature/PAY-9-x, PAY-12a')).toEqual([]);
    expect(jiraKeys('PAY-1 fixes #3')).toEqual(['PAY-1']);
  });

  test('matches only the configured project keys when given', () => {
    expect(jiraKeys('PAY-1 CORE-2 OPS-3', ['pay', 'OPS'])).toEqual(['PAY-1', 'OPS-3']);
    expect(parseProjectKeys('PAY, core; ops  x-1')).toEqual(['PAY', 'CORE', 'OPS']);
  });
});

test('mention notices and ignored names', () => {
  expect(isMentionNotice('Ann mentioned this issue in a commit of team/app on branch main')).toBe(true);
  expect(isMentionNotice('[Ann|u] mentioned this issue in [merge request !31|u]')).toBe(true);
  expect(isMentionNotice('Bo mentioned this issue in a branch of team/app')).toBe(true);
  expect(isMentionNotice('As Dana mentioned, this issue is about rounding.')).toBe(false);
  expect(parseNameList('gitlab-bot, Jenkins CI;\nx')).toEqual(['gitlab-bot', 'Jenkins CI', 'x']);
});

test('jiraBase normalises what people paste', () => {
  expect(jiraBase('acme.atlassian.net/')).toBe('https://acme.atlassian.net');
  expect(jiraBase('https://acme.atlassian.net/browse/PAY-412')).toBe('https://acme.atlassian.net');
  expect(jiraBase('https://corp.example/jira')).toBe('https://corp.example');
  expect(jiraBase('https://corp.example/tracker/')).toBe('https://corp.example/tracker');
  expect(jiraBase('')).toBeUndefined();
  expect(jiraBase('ftp://x')).toBeUndefined();
});

describe('addJiraContext', () => {
  const step = (sha: string, message: string, pr?: { title: string; body: string }) => ({
    commit: { sha, date: '2026-01-01T00:00:00Z', author: 'a', message },
    snapshot: 'x',
    startLine: 1,
    addedLines: [1],
    removedLines: [],
    diff: '',
    reviews: [],
    issues: [],
    ...(pr && { pr: { number: 31, url: 'https://gitlab.example.com/p/-/merge_requests/31', ...pr } }),
  });
  const timeline: Timeline = {
    file: 'invoice.py',
    range: [1, 1],
    head: 'f'.repeat(40),
    skipped: 0,
    steps: [step('a'.repeat(40), 'Round per line', { title: 'Fix cent drift', body: 'Implements PAY-412.' }), step('b'.repeat(40), 'CORE-9 Tidy up')],
    noise: [],
    warnings: [],
  };
  const issue = {
    key: 'PAY-412',
    fields: {
      summary: 'Invoice total off by 0.01',
      description: 'h2. Problem\nTotals drift. See [the sheet|https://x.example].',
      issuetype: { name: 'Bug' },
      status: { name: 'Done' },
      reporter: { displayName: 'Priya' },
      created: '2024-05-21T09:00:00.000+0000',
      comment: {
        comments: [
          { id: '10', body: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Finance signed off.' }] }] }, author: { displayName: 'Dana' }, created: '2024-05-28T00:00:00.000+0000' },
          { id: '11', body: 'Build passed', author: { displayName: 'Jira Automation', accountType: 'app' } },
          { id: '12', body: '[Ann Lee|https://gitlab.example.com/ann] mentioned this issue in [a commit of team/app|https://gitlab.example.com/c/1]:\n{quote}PAY-412 Round per line{quote}', author: { displayName: 'Ann Lee' } },
          { id: '13', body: 'Deployed to staging.', author: { displayName: 'Deploy Robot', name: 'deployer' } },
        ],
      },
    },
  };

  function fakeJira(responses: Record<string, { status: number; body?: unknown }>) {
    const calls: { url: string; auth?: string }[] = [];
    const fetch = (async (url: string, init?: RequestInit) => {
      const auth = (init?.headers as Record<string, string>)?.authorization;
      calls.push({ url, auth });
      const key = Object.keys(responses).find((k) => url.includes(k));
      const r = key ? responses[key]! : { status: 404, body: {} };
      return new Response(JSON.stringify(r.body ?? {}), { status: r.status, headers: { 'content-type': 'application/json' } });
    }) as typeof globalThis.fetch;
    return { calls, fetch };
  }

  test('reads tickets from commit messages and PR descriptions, with Cloud basic auth', async () => {
    const { calls, fetch } = fakeJira({ '/issue/PAY-412': { status: 200, body: issue } });
    const out = await addJiraContext(timeline, { url: 'https://acme.atlassian.net', email: 'me@acme.test', token: 'tok', ignoreAuthors: ['DEPLOYER'], fetch });
    expect(calls.map((c) => c.url.split('?')[0])).toEqual([
      'https://acme.atlassian.net/rest/api/2/issue/PAY-412',
      'https://acme.atlassian.net/rest/api/2/issue/CORE-9',
    ]);
    expect(calls[0]!.auth).toBe(`Basic ${Buffer.from('me@acme.test:tok').toString('base64')}`);
    expect(out.steps[0]!.tickets).toEqual([
      {
        key: 'PAY-412',
        title: 'Invoice total off by 0.01',
        url: 'https://acme.atlassian.net/browse/PAY-412',
        type: 'Bug',
        status: 'Done',
        reporter: 'Priya',
        date: '2024-05-21T09:00:00.000+0000',
        body: 'Problem\nTotals drift. See the sheet.',
        comments: [{ author: 'Dana', body: 'Finance signed off.', url: 'https://acme.atlassian.net/browse/PAY-412?focusedCommentId=10', date: '2024-05-28T00:00:00.000+0000' }],
      },
    ]);
    expect(out.steps[1]!.tickets).toEqual([]);
    expect(out.jira).toEqual({ url: 'https://acme.atlassian.net', token: true, tickets: 1 });
  });

  test('sends a Data Center token as a bearer token, and says when credentials are rejected', async () => {
    const { calls, fetch } = fakeJira({ '/issue/': { status: 401 } });
    const out = await addJiraContext(timeline, { url: 'https://jira.corp.example', token: 'pat', fetch });
    expect(calls[0]!.auth).toBe('Bearer pat');
    expect(out.jira?.error).toMatch(/rejected the credentials/);
    expect(out.steps.every((s) => s.tickets?.length === 0)).toBe(true);
  });

  test('the tickets become citable evidence', async () => {
    const { fetch } = fakeJira({ '/issue/PAY-412': { status: 200, body: issue } });
    const out = await addJiraContext(timeline, { url: 'https://acme.atlassian.net', fetch });
    const prompt = buildStoryPrompt(out);
    expect(prompt.ids).toContain('jira:PAY-412');
    expect(prompt.user).toContain('Jira ticket jira:PAY-412 (Bug, Done, reported by Priya, 2024-05-21): Invoice total off by 0.01');
    expect(prompt.user).toContain('Comment by Dana (2024-05-28): Finance signed off.');
    const story = parseStory(
      JSON.stringify({
        summary: 's',
        steps: [{ commit: 'aaaaaaa', note: 'Rounds per line, as jira:PAY-412 asks.', citations: ['PAY-412'] }],
        verdict: { flags: [], reasons: [{ text: 'r', citations: ['jira:pay-412', 'jira:NOPE-1'] }], checks: [] },
      }),
      out,
      prompt,
      'm',
    );
    expect(story.steps[0]!.citations).toContain('jira:PAY-412');
    expect(story.steps[0]!.note).toBe('Rounds per line, as PAY-412 asks.');
    expect(story.verdict.reasons[0]!.citations).toEqual(['jira:PAY-412']);
  });
});

describe('checkJira', () => {
  const answer = (status: number, body: unknown) =>
    (async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;

  test('says who the token belongs to, or that it was rejected', async () => {
    await expect(checkJira({ url: 'acme.atlassian.net', email: 'me@acme.test', token: 't', fetch: answer(200, { displayName: 'Marco' }) })).resolves.toBe('Connected as Marco.');
    await expect(checkJira({ url: 'acme.atlassian.net', token: 't', fetch: answer(401, {}) })).rejects.toThrow(/Jira Cloud needs your Atlassian email/);
    await expect(checkJira({ url: 'https://jira.corp.example', fetch: answer(200, { serverTitle: 'Corp Jira' }) })).resolves.toMatch(/^Reached Corp Jira\./);
  });

  test('says when the URL is not Jira', async () => {
    const html = (async () => new Response('<html>', { status: 200, headers: { 'content-type': 'text/html' } })) as unknown as typeof fetch;
    await expect(checkJira({ url: 'https://example.com', token: 't', fetch: html })).rejects.toThrow(/did not answer like Jira/);
  });
});
