/**
 * A fake GitHub REST API for tests. The Angular routes below are abridged by hand from the
 * public pages of angular/angular PRs #67692 and #71064 (read 2026-10-07); only the fields the
 * client reads are filled in, and comment ids are made up.
 */
export type Routes = Record<string, unknown>;

export function fakeGitHub(routes: Routes, options: { status?: (route: string) => number | undefined } = {}) {
  const calls: { route: string; auth?: string }[] = [];
  const fake = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const route = url.pathname.replace(/^\/repos\/[^/]+\/[^/]+/, '') + url.search;
    const headers = new Headers(init?.headers);
    calls.push({ route, auth: headers.get('authorization') ?? undefined });
    const status = options.status?.(route);
    if (status) {
      return new Response(JSON.stringify({ message: status === 403 ? 'API rate limit exceeded' : 'error' }), {
        status,
        headers: status === 403 ? { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1791374400' } : {},
      });
    }
    const key = route.replace(/\?.*$/, '');
    if (!(key in routes)) return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 });
    return new Response(JSON.stringify(routes[key]), { status: 200 });
  };
  return { fetch: fake as typeof globalThis.fetch, calls };
}

const user = (login: string) => ({ login, type: 'User' });
const bot = (login: string) => ({ login, type: 'Bot' });
const html = (n: number, suffix = '') => `https://github.com/angular/angular/pull/${n}${suffix}`;

const FIX = 'e96936a57fe4f07f8155e5a500cec5adeb6341be';
const FIX_FOLLOWUP = '2b89a3ba5a96359544e307b07e8c04c77119fffa';
const REVERT = 'fc9b2d64e32bf48d9782e0a679060f36cc9a1dc2';
const REVERT_FOLLOWUP = 'bab72b9f5d8a6c9162d10b051093ce1e8dc817a2';

const fixPr = { number: 67692, title: 'fix(core): block dangerous data: and vbscript: URLs in URL sanitizer', html_url: html(67692), merged_at: '2026-09-29T21:00:00Z' };
const revertPr = { number: 71064, title: 'Revert "fix(core): block dangerous data: and vbscript: URLs in URL sanitizer"', html_url: html(71064), merged_at: '2026-09-30T00:20:00Z' };

/** angular/angular, enough for packages/core/src/sanitization/url_sanitizer.ts lines 38-48. */
export const angularRoutes: Routes = {
  [`/commits/${FIX}/pulls`]: [fixPr],
  [`/commits/${FIX_FOLLOWUP}/pulls`]: [fixPr],
  [`/commits/${REVERT}/pulls`]: [revertPr],
  [`/commits/${REVERT_FOLLOWUP}/pulls`]: [revertPr],

  '/pulls/67692': {
    ...fixPr,
    body:
      '<!-- PR template -->\n## PR Checklist\n- [x] Tests for the changes have been added\n\n' +
      'The URL sanitizer previously only blocked `javascript:` URLs. This extends it to block `vbscript:` URLs and `data:` URLs ' +
      'except safe media subtypes (image/*, video/*, audio/*). Resolves a longstanding TODO in html_sanitizer.ts.',
  },
  '/pulls/67692/comments': [],
  '/pulls/67692/reviews': [
    { user: user('josephperrott'), body: 'LGTM\n\nReviewed-for: fw-security', state: 'APPROVED', html_url: html(67692, '#pullrequestreview-1'), submitted_at: '2026-03-19T10:00:00Z' },
    { user: user('alan-agius4'), body: 'LGTM\n\nReviewed-for: fw-security', state: 'APPROVED', html_url: html(67692, '#pullrequestreview-2'), submitted_at: '2026-03-23T10:00:00Z' },
    { user: user('AndrewKushnir'), body: '', state: 'APPROVED', html_url: html(67692, '#pullrequestreview-3'), submitted_at: '2026-03-24T10:00:00Z' },
  ],
  '/issues/67692/comments': [
    { user: bot('pullapprove[bot]'), body: 'Requested review from josephperrott', html_url: html(67692, '#issuecomment-0'), created_at: '2026-03-15T10:00:00Z' },
    {
      user: user('alan-agius4'),
      body: "This change causes a failure in G3: Expected 'unsafe:data:application/octet-stream;base64,dGVzdA==' to equal 'data:application/octet-stream;base64,dGVzdA=='.",
      html_url: html(67692, '#issuecomment-1'),
      created_at: '2026-03-25T09:00:00Z',
    },
    { user: user('KevinZhao'), body: 'Fixed: extended the data: URL allowlist to include common non-executable MIME types.', html_url: html(67692, '#issuecomment-2'), created_at: '2026-03-25T12:00:00Z' },
    {
      user: user('atscott'),
      body: 'Reverting due to test failures in g3 that were not addressed prior to merging. This will need a TGP and local fixes.',
      html_url: html(67692, '#issuecomment-3'),
      created_at: '2026-09-30T00:10:00Z',
    },
  ],
  '/issues/67692': { ...fixPr, body: 'The URL sanitizer previously only blocked `javascript:` URLs.', pull_request: { url: '' } },

  '/pulls/71064': { ...revertPr, body: 'Reverts #67692. This reverts commits 2b89a3b and e96936a.' },
  '/pulls/71064/comments': [],
  '/pulls/71064/reviews': [{ user: user('JeanMeche'), body: '', state: 'APPROVED', html_url: html(71064, '#pullrequestreview-1'), submitted_at: '2026-09-30T00:05:00Z' }],
  '/issues/71064/comments': [],

  '/pulls/49659': { number: 49659, title: 'feat(core): change the URL sanitization to only block javascript: URLs', body: '', html_url: html(49659), merged_at: '2023-03-31T00:00:00Z' },
  '/pulls/31463': { number: 31463, title: 'feat(platform-browser): Allow `sms`-URLs', body: 'Fixes #31462', html_url: html(31463), merged_at: '2020-06-25T00:00:00Z' },
  '/issues/31462': { number: 31462, title: 'Allow sms: URLs in the URL sanitizer', body: 'Closure library already allows sms: URLs.', html_url: 'https://github.com/angular/angular/issues/31462' },
};
