import type { JiraTicket, Review, Step, Story, Timeline } from '@code-archaeologist/core/src/types.js';
import type { AiState, FromWebview, ToWebview } from '../src/messages';

/** `showRemoved` is on unless turned off. */
type ViewState = { showRemoved?: boolean; storyCollapsed?: boolean };

declare function acquireVsCodeApi(): {
  postMessage(message: FromWebview): void;
  getState(): ViewState | undefined;
  setState(state: ViewState): void;
};

const vscode = acquireVsCodeApi();
const app = document.getElementById('app')!;
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

let timeline: Timeline | undefined;
let ai: AiState = { status: 'writing' };
let current = 0;
/** Panel preferences that survive the panel being hidden and shown again. */
let view: ViewState = vscode.getState() ?? {};

window.addEventListener('message', (event: MessageEvent<ToWebview>) => {
  const message = event.data;
  switch (message.type) {
    case 'loading':
      timeline = undefined;
      renderLoading(`${message.file}:${message.range[0]}-${message.range[1]}`, message.message);
      break;
    case 'progress': {
      const status = document.getElementById('progress');
      if (status) status.textContent = message.message;
      break;
    }
    case 'timeline': {
      const same = timeline !== undefined && sameTrace(timeline, message.timeline) && document.getElementById('story');
      timeline = message.timeline;
      ai = message.ai;
      if (!same) current = Math.max(0, timeline.steps.length - 1);
      // GitHub context or the story arrived for the lines on screen: redraw in place, keep the
      // slider where it is.
      const scroll = window.scrollY;
      renderTimeline(timeline);
      if (same) window.scrollTo(0, scroll);
      break;
    }
    case 'error':
      timeline = undefined;
      renderError(message.message);
      break;
  }
});

document.addEventListener('keydown', (event) => {
  const target = event.target as HTMLElement;
  if (!timeline || timeline.steps.length === 0 || target.tagName === 'INPUT' || event.metaKey || event.ctrlKey || event.altKey) return;
  const go = (index: number) => {
    event.preventDefault();
    select(index, index === current + 1);
  };
  if (event.key === 'ArrowLeft') go(current - 1);
  else if (event.key === 'ArrowRight') go(current + 1);
  else if (event.key === 'Home') go(0);
  else if (event.key === 'End') go(timeline.steps.length - 1);
});

reducedMotion.addEventListener('change', () => timeline && select(current));

vscode.postMessage({ type: 'ready' });

// ---------------------------------------------------------------------------

/** Tiny element builder. Text always goes through textContent, never innerHTML. */
function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: { class?: string; text?: string; attrs?: Record<string, string> } = {},
  ...children: (Node | string | undefined | false)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (props.class) node.className = props.class;
  if (props.text !== undefined) node.textContent = props.text;
  for (const [key, value] of Object.entries(props.attrs ?? {})) {
    // Links come from GitHub, GitLab or a cached answer; only web links are followed.
    if (key === 'href' && !/^https?:\/\//i.test(value)) continue;
    node.setAttribute(key, value);
  }
  for (const child of children) if (child) node.append(child);
  return node;
}

function saveView(change: ViewState) {
  view = { ...view, ...change };
  vscode.setState(view);
}

function renderLoading(title: string, message: string) {
  app.replaceChildren(
    el('header', { class: 'summary' }, el('h1', { text: title })),
    el('p', { class: 'status' }, el('span', { class: 'spinner', attrs: { 'aria-hidden': 'true' } }), el('span', { text: message, attrs: { id: 'progress' } })),
  );
}

function renderError(message: string) {
  app.replaceChildren(
    el('header', { class: 'summary' }, el('h1', { text: 'Could not trace these lines' })),
    el('p', { class: 'error', text: message }),
  );
}

function renderTimeline(t: Timeline) {
  const [start, end] = t.range;
  const first = t.steps[0];
  const last = t.steps.at(-1);
  const span = first && last ? `${shortDate(first.commit.date)} to ${shortDate(last.commit.date)}` : 'no history';

  const noise =
    t.noise.length > 0 &&
    el(
      'details',
      { class: 'noise' },
      el('summary', { text: `${plural(t.skipped, 'noise commit')} skipped` }),
      el(
        'ul',
        {},
        ...t.noise.map((n) =>
          el('li', {}, commitLink(t, n.commit.sha), ` ${n.reason}: ${subject(n.commit.message)}`),
        ),
      ),
    );

  const header = el(
    'header',
    { class: 'summary' },
    el('h1', { text: `${t.file}:${start}-${end}` }),
    el('p', { class: 'meta', text: `${plural(t.steps.length, 'commit')} · ${span}${t.context ? ` · ${plural(t.context.prs, forge(t).pr)} from ${forge(t).name}` : ''}` }),
    noise,
  );

  // Under the file name, above the history, so the verdict is read early but scrolls away.
  const story = renderStory(t, ai);

  const warnings = t.warnings.length > 0 && el('div', { class: 'warnings' }, ...t.warnings.map((w) => el('p', { text: w })));

  if (t.steps.length === 0) {
    app.replaceChildren(header, story, warnings || '', el('p', { class: 'status', text: 'No commits touched these lines.' }));
    return;
  }

  const slider = el('input', {
    attrs: { type: 'range', min: '0', max: String(t.steps.length - 1), value: String(current), id: 'slider', 'aria-label': 'Commit' },
  });
  slider.addEventListener('input', () => {
    select(Number(slider.value), Number(slider.value) === current + 1);
  });
  const button = (id: string, text: string, label: string, onClick: () => void) => {
    const b = el('button', { text, attrs: { id, title: label, 'aria-label': label } });
    b.addEventListener('click', onClick);
    return b;
  };
  const prev = button('prev', '‹', 'Previous commit (←)', () => select(current - 1));
  const next = button('next', '›', 'Next commit (→)', () => select(current + 1, true));
  const removedToggle = el('input', { attrs: { type: 'checkbox', id: 'show-removed' } });
  removedToggle.checked = view.showRemoved ?? true;
  removedToggle.addEventListener('change', () => {
    saveView({ showRemoved: removedToggle.checked });
    select(current);
  });

  const player = el(
    'section',
    { class: 'player', attrs: { 'aria-label': 'Time-lapse' } },
    el(
      'div',
      { class: 'controls' },
      prev,
      el('div', { class: 'scrubber' }, slider, renderTrack(t)),
      next,
      el('span', { class: 'position', attrs: { id: 'position' } }),
    ),
    el(
      'div',
      { class: 'options' },
      el('label', { attrs: { for: 'show-removed' } }, removedToggle, ' Keep removed lines visible'),
      el('span', { class: 'hint', text: 'Click a dot · ← → step · Home End jump' }),
    ),
    el('div', { attrs: { id: 'step' } }),
  );

  const list = el(
    'section',
    { class: 'history' },
    el('h2', { text: 'All commits, oldest first' }),
    el(
      'ol',
      { attrs: { id: 'commit-list' } },
      ...t.steps.map((step, index) => {
        const kind = kindOf(step);
        const row = el(
          'li',
          { attrs: { tabindex: '0', 'data-index': String(index) } },
          el('span', { class: 'date', text: shortDate(step.commit.date) }),
          el('span', { class: `kind kind-${kind.id}`, text: kind.label }),
          el('span', { class: 'subject', text: subject(step.commit.message) }),
          el('span', { class: 'churn', text: `+${step.addedLines.length} −${step.removedLines.length}` }),
        );
        row.addEventListener('click', () => select(index));
        row.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') select(index);
        });
        return row;
      }),
    ),
  );

  app.replaceChildren(header, story, warnings || '', player, list);
  select(current);
}

/** One dot per commit under the slider, coloured by kind, with a year label where the year changes. */
function renderTrack(t: Timeline): HTMLElement {
  const cited = citedSteps(t);
  const n = t.steps.length;
  // Matches the thumb width in panel.css, so a dot sits under the thumb when it is on that commit.
  // A single commit sits where the slider puts its thumb: at the start.
  const at = (i: number) => `calc(var(--thumb) / 2 + (100% - var(--thumb)) * ${n === 1 ? 0 : i / (n - 1)})`;
  const track = el('div', { class: 'track', attrs: { 'aria-hidden': 'true' } });
  t.steps.forEach((step, i) => {
    const kind = kindOf(step);
    const dot = el('button', {
      class: `dot kind-${kind.id}${cited.has(i) ? ' cited' : ''}`,
      attrs: { 'data-index': String(i), title: `${shortDate(step.commit.date)} · ${subject(step.commit.message)}`, tabindex: '-1' },
    });
    dot.style.left = at(i);
    dot.addEventListener('click', () => select(i, i === current + 1));
    track.append(dot);
    const year = step.commit.date.slice(0, 4);
    const prevYear = t.steps[i - 1]?.commit.date.slice(0, 4);
    if (year !== prevYear) {
      const label = el('span', { class: 'year', text: year });
      label.style.left = at(i);
      track.append(label);
    }
  });
  new ResizeObserver(() => declutterYears(track)).observe(track);
  return track;
}

/** Hides year labels that would overlap, keeping the most recent years. */
function declutterYears(track: HTMLElement) {
  const labels = [...track.querySelectorAll<HTMLElement>('.year')];
  let leftEdge = Infinity;
  for (const label of labels.reverse()) {
    label.style.visibility = '';
    const box = label.getBoundingClientRect();
    if (box.right + 6 > leftEdge) label.style.visibility = 'hidden';
    else leftEdge = box.left;
  }
}

function select(index: number, animate = false) {
  if (!timeline || timeline.steps.length === 0) return;
  current = Math.min(Math.max(index, 0), timeline.steps.length - 1);
  const step = timeline.steps[current]!;

  (document.getElementById('slider') as HTMLInputElement).value = String(current);
  document.getElementById('position')!.textContent = `${current + 1} / ${timeline.steps.length}`;
  (document.getElementById('prev') as HTMLButtonElement).disabled = current === 0;
  (document.getElementById('next') as HTMLButtonElement).disabled = current === timeline.steps.length - 1;
  for (const node of document.querySelectorAll('#commit-list li, .track .dot')) {
    node.classList.toggle('current', node.getAttribute('data-index') === String(current));
  }
  // Light up the verdict reasons that rest on this commit.
  for (const node of document.querySelectorAll('.reasons li[data-step]')) {
    node.classList.toggle('here', node.getAttribute('data-step') === String(current));
  }
  document.getElementById('step')!.replaceChildren(renderStep(timeline, step, animate && !reducedMotion.matches));
}

function renderStep(t: Timeline, step: Step, animate: boolean): HTMLElement {
  const { commit } = step;
  const body = commit.message.split('\n').slice(1).join('\n').trim();
  const kind = kindOf(step);
  const previous = t.steps[current - 1];
  const gap = previous ? elapsed(previous.commit.date, commit.date) : 'first version';

  const fileUrl = fileAtCommit(t, step);
  // Every link for the commit on one line: the commit, the PR or MR that merged it, its Jira tickets, the file then.
  const tickets = step.tickets ?? [];
  const links = el(
    'p',
    { class: 'meta links' },
    commitLink(t, commit.sha),
    step.pr && ' · ',
    step.pr && el('a', { class: 'pr', text: `${refLabel(t, 'pr', step.pr.number)} ${step.pr.title}`, attrs: { href: step.pr.url, title: `Open the ${forge(t).pr}` } }),
    ...tickets.flatMap((ticket) => [' · ', el('a', { class: 'ticket', text: ticket.key, attrs: { href: ticket.url, title: ticketTitle(ticket) } })]),
    fileUrl && ' · ',
    fileUrl && el('a', { text: 'file at this commit', attrs: { href: fileUrl } }),
  );

  return el(
    'article',
    { class: `step${animate ? ' entering' : ''}` },
    el(
      'div',
      { class: 'step-head' },
      el('span', { class: `kind kind-${kind.id}`, text: kind.label }),
      el('span', { class: 'gap', text: gap }),
      el('span', { class: 'who', text: `· ${commit.author} · ${shortDate(commit.date)}` }),
    ),
    el('h3', { text: subject(commit.message) }),
    links,
    renderNote(t, step),
    renderCode(step, animate),
    el(
      'div',
      { class: 'drops' },
      body && el('details', { class: 'body' }, el('summary', { text: 'Full commit message' }), el('pre', { text: body })),
      renderEvidence(t, step),
      ...tickets.map(renderTicket),
    ),
  );
}

type Row = { kind: 'context' | 'add' | 'del' | 'skip'; text: string; line?: number };

/** The commit's diff of the traced lines, as rows: what it removed sits where it was. */
function diffRows(step: Step): Row[] {
  const rows: Row[] = [];
  let line = 0;
  let inHunk = false;
  for (const raw of step.diff.split('\n')) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (hunk) {
      if (inHunk) rows.push({ kind: 'skip', text: '⋯' });
      line = Number(hunk[1]);
      inHunk = true;
      continue;
    }
    if (!inHunk || raw.startsWith('\\')) continue;
    if (raw.startsWith('+')) rows.push({ kind: 'add', text: raw.slice(1), line: line++ });
    else if (raw.startsWith('-')) rows.push({ kind: 'del', text: raw.slice(1) });
    else if (raw.startsWith(' ')) rows.push({ kind: 'context', text: raw.slice(1), line: line++ });
  }
  // Fall back to the snapshot when the diff does not line up with it.
  const shown = rows.filter((r) => r.kind === 'add' || r.kind === 'context');
  if (shown.length !== step.snapshot.split('\n').length) {
    const added = new Set(step.addedLines);
    return step.snapshot.split('\n').map((text, i) => ({ kind: added.has(i + 1) ? 'add' : 'context', text, line: step.startLine + i }));
  }
  return rows;
}

/**
 * The lines at this commit. Stepping forward animates the change: removed lines flash red and
 * fold away, then the added lines grow in. "Keep removed lines visible" leaves them in place.
 */
function renderCode(step: Step, animate: boolean): HTMLElement {
  const keep = view.showRemoved ?? true;
  const rows = diffRows(step);
  const removed = rows.filter((r) => r.kind === 'del').length;
  const code = el(
    'pre',
    { class: `snapshot${animate ? ' animate' : ''}${keep ? ' keep-removed' : ''}`, attrs: { 'aria-label': 'The traced lines at this commit' } },
    ...rows.map((row) =>
      el(
        'div',
        { class: `line ${row.kind}` },
        el('span', { class: 'ln', text: row.line === undefined ? '' : String(row.line), attrs: { 'aria-hidden': 'true' } }),
        el('span', { class: 'mark', text: row.kind === 'add' ? '+' : row.kind === 'del' ? '−' : ' ', attrs: { 'aria-hidden': 'true' } }),
        el('span', { class: 'text', text: row.text || ' ' }),
      ),
    ),
  );
  const added = rows.filter((r) => r.kind === 'add').length;
  const summary = el('p', { class: 'churn-line', text: `${plural(added, 'line')} added, ${plural(removed, 'line')} removed by this commit` });
  return el('div', { class: 'code' }, summary, code);
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/** "3 years later", "2 months later", "same day". */
function elapsed(fromIso: string, toIso: string): string {
  const days = Math.round((Date.parse(toIso) - Date.parse(fromIso)) / 86_400_000);
  if (days < 1) return 'same day';
  if (days < 45) return `${plural(days, 'day')} later`;
  if (days < 365) return `${plural(Math.round(days / 30), 'month')} later`;
  const years = days / 365;
  return `${years < 1.5 ? '1 year' : `${Math.round(years)} years`} later`;
}

type Kind = { id: 'revert' | 'fix' | 'feat' | 'perf' | 'refactor' | 'docs' | 'other'; label: string };

/** What kind of change a commit is, from its subject (conventional commit prefix or "Revert"). */
function kindOf(step: Step): Kind {
  const s = subject(step.commit.message);
  if (/^revert\b/i.test(s)) return { id: 'revert', label: 'revert' };
  const type = /^(\w+)(?:\([^)]*\))?!?:/.exec(s)?.[1]?.toLowerCase();
  switch (type) {
    case 'fix':
      return { id: 'fix', label: 'fix' };
    case 'feat':
      return { id: 'feat', label: 'feature' };
    case 'perf':
      return { id: 'perf', label: 'perf' };
    case 'refactor':
    case 'style':
    case 'build':
    case 'chore':
      return { id: 'refactor', label: type === 'refactor' ? 'refactor' : type };
    case 'docs':
      return { id: 'docs', label: 'docs' };
    default:
      return { id: 'other', label: 'change' };
  }
}

/** Steps that a verdict reason cites, to mark them on the track. */
function citedSteps(t: Timeline): Set<number> {
  const out = new Set<number>();
  if (ai.status !== 'ready') return out;
  for (const reason of t.story?.verdict.reasons ?? []) {
    const i = stepForCitations(t, reason.citations);
    if (i !== undefined) out.add(i);
  }
  return out;
}

/** GitHub's or GitLab's view of the file as it was at this commit, at the traced lines. */
function fileAtCommit(t: Timeline, step: Step): string | undefined {
  const repo = forge(t).web;
  if (!repo) return undefined;
  const file = /^\+\+\+ b\/(.+)$/m.exec(step.diff)?.[1] ?? t.file;
  const end = step.startLine + step.snapshot.split('\n').length - 1;
  return t.gitlab
    ? `${repo}/-/blob/${step.commit.sha}/${file}#L${step.startLine}-${end}`
    : `${repo}/blob/${step.commit.sha}/${file}#L${step.startLine}-L${end}`;
}

/** Where the timeline's PRs live and what they are called there. GitLab has merge requests, "!12". */
function forge(t: Timeline): { name: string; pr: string; sign: string; web?: string } {
  if (t.gitlab) return { name: 'GitLab', pr: 'merge request', sign: '!', web: `${t.gitlab.url}/${t.gitlab.project}` };
  return { name: 'GitHub', pr: 'pull request', sign: '#', web: t.github && `https://github.com/${t.github.owner}/${t.github.repo}` };
}

/** "#12" for a PR or issue, "!12" for a GitLab merge request. */
function refLabel(t: Timeline, kind: string | undefined, n: number | string): string {
  return `${kind === 'pr' ? forge(t).sign : '#'}${n}`;
}

function sameTrace(a: Timeline, b: Timeline): boolean {
  return a.file === b.file && a.head === b.head && a.range[0] === b.range[0] && a.range[1] === b.range[1];
}

const LEVELS: Record<Story['verdict']['level'], string> = {
  low: 'Low risk to change',
  medium: 'Medium risk to change',
  high: 'High risk to change',
};

function renderStory(t: Timeline, state: AiState): HTMLElement {
  const section = (cls: string, ...children: (Node | string | false | undefined)[]) =>
    el('section', { class: `story ${cls}`, attrs: { id: 'story', 'aria-label': 'Summary and verdict' } }, ...children);
  const button = (text: string, message: FromWebview, kind?: 'secondary') => {
    const b = el('button', { class: kind ? `action ${kind}` : 'action', text });
    b.addEventListener('click', () => vscode.postMessage(message));
    return b;
  };

  if (t.steps.length === 0) return section('pending', el('p', { text: 'Nothing to explain: no commits touched these lines.' }));

  const story = t.story;
  if (!story || state.status !== 'ready') {
    switch (state.status) {
      case 'reading':
        return section(
          'pending',
          el('p', { class: 'status' }, el('span', { class: 'spinner', attrs: { 'aria-hidden': 'true' } }), el('span', { text: state.message, attrs: { id: 'progress' } })),
        );
      case 'writing':
        return section(
          'pending',
          el('p', { class: 'status' }, el('span', { class: 'spinner', attrs: { 'aria-hidden': 'true' } }), el('span', { text: 'Writing the story… The raw history is below meanwhile.' })),
        );
      case 'no-key':
        return section(
          'pending',
          el('p', { text: 'Add an LLM API key to get a summary, a note on every commit and a "safe to change?" verdict. The raw history is below.' }),
          button('Set up AI model', { type: 'open-settings' }),
          githubNotice(t),
        );
      case 'error':
        return section(
          'pending failed',
          el('p', { class: 'error', text: `Could not write the story. ${state.message}` }),
          el('p', { class: 'actions' }, button('Try again', { type: 'retry-story' }), ' ', button('Settings', { type: 'open-settings' }, 'secondary')),
          githubNotice(t),
        );
      default:
        return section('pending', el('p', { text: 'No story for these lines.' }));
    }
  }

  const reasons = el(
    'ul',
    { class: 'reasons' },
    ...story.verdict.reasons.map((reason) => {
      const target = stepForCitations(t, reason.citations);
      const item = el(
        'li',
        target === undefined ? {} : { class: 'jump', attrs: { tabindex: '0', title: 'Show the commit this cites', 'data-step': String(target) } },
        el('span', { text: reason.text }),
        ' ',
        citationChips(t, reason),
      );
      if (target !== undefined) {
        item.addEventListener('click', (e) => {
          if ((e.target as HTMLElement).closest('a')) return; // chips open GitHub or GitLab
          select(target);
          document.getElementById('step')?.scrollIntoView({ block: 'nearest', behavior: reducedMotion.matches ? 'auto' : 'smooth' });
        });
        item.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') select(target);
        });
      }
      return item;
    }),
  );

  const checks =
    story.verdict.checks.length > 0 &&
    el(
      'details',
      { class: 'checks', attrs: { open: '' } },
      el('summary', { text: 'Check before you change it' }),
      el('ul', {}, ...story.verdict.checks.map((c) => el('li', { text: c }))),
    );

  const flagged = story.steps.filter((s) => s.flagged).length + story.verdict.reasons.filter((r) => r.flagged).length;
  const footer = [
    `Written by ${story.model} from ${evidenceSources(t)}.`,
    story.reduced > 0 ? `${story.reduced} older commits were sent as their subject line only.` : '',
    flagged > 0 ? `${flagged} claim${flagged === 1 ? '' : 's'} cited nothing in the evidence and ${flagged === 1 ? 'is' : 'are'} marked unverified.` : '',
  ]
    .filter(Boolean)
    .join(' ');

  // Folding hides the reasons and checks but keeps the verdict and summary pinned.
  const fold = el('button', { class: 'fold', text: view.storyCollapsed ? 'Show reasons' : 'Hide reasons', attrs: { 'aria-expanded': String(!view.storyCollapsed) } });
  fold.addEventListener('click', () => {
    saveView({ storyCollapsed: !view.storyCollapsed });
    document.getElementById('story')?.classList.toggle('collapsed', view.storyCollapsed);
    fold.textContent = view.storyCollapsed ? 'Show reasons' : 'Hide reasons';
    fold.setAttribute('aria-expanded', String(!view.storyCollapsed));
  });

  return section(
    `ready level-${story.verdict.level}${view.storyCollapsed ? ' collapsed' : ''}`,
    el('div', { class: 'verdict-head' }, el('span', { class: 'badge', text: LEVELS[story.verdict.level] }), fold),
    el('p', { class: 'summary-line', text: story.summary }),
    reasons,
    checks,
    el('p', { class: 'fineprint', text: footer }),
    githubNotice(t),
  );
}

/** "commit messages and diffs", plus what GitHub or GitLab added. */
function evidenceSources(t: Timeline): string {
  const c = t.context;
  if (!c || c.prs === 0) return 'commit messages and diffs';
  const parts = [plural(c.prs, forge(t).pr)];
  if (c.reviews > 0) parts.push(`${c.reviews} review comment${c.reviews === 1 ? '' : 's'}`);
  if (c.issues > 0) parts.push(`${c.issues} linked issue${c.issues === 1 ? '' : 's'}`);
  if (t.jira?.tickets) parts.push(plural(t.jira.tickets, 'Jira ticket'));
  return `commit messages, diffs, ${parts.join(', ')}`;
}

/** Says when GitHub or GitLab context is missing or partial, with a button to add a token when that would help. */
function githubNotice(t: Timeline): HTMLElement | undefined {
  const c = t.context;
  if (!c?.error) return undefined;
  const { name, pr } = forge(t);
  const notice = el('p', { class: 'github-notice', text: `${pr[0]!.toUpperCase()}${pr.slice(1)}s and reviews may be missing. ${c.error}` });
  if (!c.token && !c.tokenHeldBackFrom) {
    const b = el('button', { class: 'action secondary', text: `Add ${name} token` });
    b.addEventListener('click', () => vscode.postMessage({ type: t.gitlab ? 'set-gitlab-token' : 'set-github-token' }));
    notice.append(' ', b);
  }
  if (c.tokenHeldBackFrom) {
    const b = el('button', { class: 'action secondary', text: `Use my token on ${hostOf(c.tokenHeldBackFrom)}` });
    b.addEventListener('click', () => vscode.postMessage({ type: 'trust-gitlab' }));
    notice.append(' ', b);
  }
  return notice;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** "MR !31 description, 1 linked issue and 2 comments": the forge's dropdown, holding what the link line leaves out. */
function renderEvidence(t: Timeline, step: Step): HTMLElement | undefined {
  const description = step.pr?.body.trim();
  if (!description && step.issues.length === 0 && step.reviews.length === 0) return undefined;
  const { name } = forge(t);
  const parts = [
    description && 'description',
    step.issues.length > 0 && plural(step.issues.length, 'linked issue'),
    step.reviews.length > 0 && plural(step.reviews.length, 'comment'),
  ].filter((x): x is string => Boolean(x));
  const what = parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}` : parts[0]!;
  const label = step.pr ? `${forge(t).pr === 'merge request' ? 'MR' : 'PR'} ${refLabel(t, 'pr', step.pr.number)} ${what}` : `${what[0]!.toUpperCase()}${what.slice(1)} from ${name}`;
  const issues =
    step.issues.length > 0 &&
    el(
      'p',
      { class: 'evidence-links' },
      ...step.issues.map((issue) =>
        el(
          'a',
          { class: 'issue', attrs: { href: issue.url } },
          el('span', { class: 'chip', text: `${issue.relation === 'reverts' ? 'reverts' : 'fixes'} ${refLabel(t, issue.kind, issue.number)}` }),
          ` ${issue.title}`,
        ),
      ),
    );
  // Open when the note rests on a comment, or the comments explain a revert.
  const note = t.story?.steps.find((n) => n.commit === step.commit.sha);
  const open = step.reviews.some((r) => r.on) || Boolean(note?.citations.some((c) => c.startsWith('review:')));
  return el(
    'details',
    { class: 'reviews', attrs: open ? { open: '' } : {} },
    el('summary', { text: label }),
    description && el('pre', { class: 'description', text: description }),
    issues,
    step.reviews.length > 0 &&
      el(
        'ol',
        {},
        ...step.reviews.map((review, i) =>
          comment(review, `review-${step.commit.sha.slice(0, 7)}-${i + 1}`, [
            review.on ? ` · on reverted ${refLabel(t, 'pr', review.on)}` : '',
            review.path ? ` · on ${review.path.split('/').pop()}` : '',
          ]),
        ),
      ),
  );
}

/** "Jira PAY-412 description and 2 comments", holding the ticket's type, status, description and comments. */
function renderTicket(ticket: JiraTicket): HTMLElement {
  const parts = [ticket.body && 'description', ticket.comments.length > 0 && plural(ticket.comments.length, 'comment')].filter((x): x is string => Boolean(x));
  const about = [ticket.type, ticket.status, ticket.reporter && `reported by ${ticket.reporter}`, ticket.date && shortDate(ticket.date)].filter(Boolean).join(' · ');
  return el(
    'details',
    { class: 'reviews ticket', attrs: { 'data-ticket': ticket.key } },
    el('summary', { text: `Jira ${ticket.key}${parts.length ? ` ${parts.join(' and ')}` : ''}` }),
    el('p', { class: 'meta ticket-about' }, el('a', { text: ticket.title, attrs: { href: ticket.url } }), about ? ` · ${about}` : ''),
    ticket.body && el('pre', { class: 'description', text: ticket.body }),
    ticket.comments.length > 0 && el('ol', {}, ...ticket.comments.map((c) => comment(c))),
  );
}

function comment(review: Review, id?: string, extra: string[] = []): HTMLElement {
  return el(
    'li',
    id ? { attrs: { id } } : {},
    el('p', { class: 'meta' }, el('a', { text: review.author, attrs: { href: review.url } }), review.date ? ` · ${shortDate(review.date)}` : '', ...extra),
    el('blockquote', { text: review.body }),
  );
}

/** "Invoice total off by 0.01 (Bug, Done)", for the ticket link's tooltip. */
function ticketTitle(ticket: JiraTicket): string {
  const about = [ticket.type, ticket.status].filter(Boolean).join(', ');
  return `${ticket.title}${about ? ` (${about})` : ''}`;
}

/** Nothing without a story: the story section at the top already says why there isn't one. */
function renderNote(t: Timeline, step: Step): HTMLElement | undefined {
  if (ai.status === 'writing' || ai.status === 'reading') return el('p', { class: 'note pending', text: 'Writing the note for this commit…' });
  if (!t.story) return undefined;
  const note = t.story.steps.find((n) => n.commit === step.commit.sha);
  if (!note) return el('p', { class: 'note pending', text: 'No note for this commit.' });
  // The commit itself and its own PR or MR are linked at the top of the card, so their chips would only repeat them.
  const own = (c: string) => (c.startsWith('commit:') && step.commit.sha.startsWith(c.slice(7).toLowerCase())) || (step.pr !== undefined && c === `pr:${step.pr.number}`);
  return el('p', { class: 'note' }, el('span', { text: note.note }), ' ', citationChips(t, { ...note, citations: note.citations.filter((c) => !own(c)) }));
}

/** Chips linking each citation to GitHub or GitLab, or an "unverified" marker when none survived the check. */
function citationChips(t: Timeline, claim: { citations: string[]; flagged?: boolean }): HTMLElement {
  if (claim.flagged) {
    return el('span', { class: 'chips' }, el('span', { class: 'chip unverified', text: 'unverified', attrs: { title: 'None of the cited ids matched the evidence' } }));
  }
  return el(
    'span',
    { class: 'chips' },
    ...claim.citations.map((citation) => {
      const href = citationUrl(t, citation);
      const label = citationLabel(t, citation);
      const cls = citation.startsWith('review:') ? 'chip review' : 'chip';
      return href
        ? el('a', { class: cls, text: label, attrs: { href, title: citation } })
        : el('span', { class: cls, text: label, attrs: { title: citation } });
    }),
  );
}

/** "b35fa73", "#49659", or "atscott's comment" for a review. */
function citationLabel(t: Timeline, citation: string): string {
  const [kind, ref = ''] = citation.split(':');
  if (kind === 'review') {
    const [sha, n] = ref.split('-');
    const author = t.steps.find((s) => s.commit.sha.startsWith(sha ?? ''))?.reviews[Number(n) - 1]?.author;
    return author ? `${author}'s comment` : 'comment';
  }
  if (kind === 'jira') return ref;
  return kind === 'pr' || kind === 'issue' ? refLabel(t, kind, ref) : ref;
}

function citationUrl(t: Timeline, citation: string): string | undefined {
  const [kind, ref = ''] = citation.split(':');
  if (kind === 'review') {
    const [sha, n] = ref.split('-');
    return t.steps.find((s) => s.commit.sha.startsWith(sha ?? ''))?.reviews[Number(n) - 1]?.url;
  }
  if (kind === 'jira') return t.steps.flatMap((s) => s.tickets ?? []).find((ticket) => ticket.key === ref)?.url;
  const repo = forge(t).web;
  if (!repo) return undefined;
  const sep = t.gitlab ? '/-' : '';
  if (kind === 'commit') {
    const sha = t.steps.find((s) => s.commit.sha.startsWith(ref))?.commit.sha ?? ref;
    return `${repo}${sep}/commit/${sha}`;
  }
  if (kind === 'pr') return `${repo}${sep}/${t.gitlab ? 'merge_requests' : 'pull'}/${ref}`;
  if (kind === 'issue') return `${repo}${sep}/issues/${ref}`;
  return undefined;
}

/** The step a list of citations points at: the first commit cited, else the commit naming a cited PR or issue. */
function stepForCitations(t: Timeline, citations: string[]): number | undefined {
  for (const citation of citations) {
    const [kind, ref = ''] = citation.split(':');
    const index = t.steps.findIndex((s) =>
      kind === 'commit' || kind === 'review'
        ? s.commit.sha.startsWith(ref.split('-')[0] ?? ref)
        : kind === 'jira'
          ? Boolean(s.tickets?.some((ticket) => ticket.key === ref))
          : (kind === 'pr' && s.pr?.number === Number(ref)) ||
          new RegExp(`${kind === 'pr' ? forge(t).sign : '#'}${ref}\\b`).test(s.commit.message) ||
          s.issues.some((i) => i.number === Number(ref) && (!t.gitlab || (i.kind ?? 'issue') === kind)),
    );
    if (index >= 0) return index;
  }
  return undefined;
}

function commitLink(t: Timeline, sha: string): HTMLElement {
  const label = sha.slice(0, 7);
  const repo = forge(t).web;
  if (!repo) return el('code', { class: 'sha', text: label });
  return el(
    'a',
    { attrs: { href: `${repo}${t.gitlab ? '/-' : ''}/commit/${sha}`, title: sha } },
    el('code', { class: 'sha', text: label }),
  );
}

function subject(message: string): string {
  return message.split('\n')[0] ?? '';
}

function shortDate(iso: string): string {
  return iso.slice(0, 10);
}
