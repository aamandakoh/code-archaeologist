import type { Step, Timeline } from '@code-archaeologist/core/src/types.js';
import type { FromWebview, ToWebview } from '../src/messages';

declare function acquireVsCodeApi(): { postMessage(message: FromWebview): void };

const vscode = acquireVsCodeApi();
const app = document.getElementById('app')!;

let timeline: Timeline | undefined;
let current = 0;

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
    case 'timeline':
      timeline = message.timeline;
      current = Math.max(0, timeline.steps.length - 1);
      renderTimeline(timeline);
      break;
    case 'error':
      timeline = undefined;
      renderError(message.message);
      break;
  }
});

document.addEventListener('keydown', (event) => {
  if (!timeline || (event.target as HTMLElement).tagName === 'INPUT') return;
  if (event.key === 'ArrowLeft') select(current - 1);
  if (event.key === 'ArrowRight') select(current + 1);
});

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
  for (const [key, value] of Object.entries(props.attrs ?? {})) node.setAttribute(key, value);
  for (const child of children) if (child) node.append(child);
  return node;
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
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

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
    el('p', { class: 'meta', text: `${plural(t.steps.length, 'commit')} · ${span}` }),
    noise,
  );

  // Pinned above the history; milestone 2 fills it with the summary and verdict.
  const story = el(
    'section',
    { class: 'story pending', attrs: { 'aria-label': 'Summary and verdict' } },
    el('h2', { text: 'Summary and verdict' }),
    el('p', { text: 'No AI story yet. The one-line summary and the risk verdict will appear here; the raw history is below.' }),
  );

  const warnings = t.warnings.length > 0 && el('div', { class: 'warnings' }, ...t.warnings.map((w) => el('p', { text: w })));

  if (t.steps.length === 0) {
    app.replaceChildren(header, story, warnings || '', el('p', { class: 'status', text: 'No commits touched these lines.' }));
    return;
  }

  const slider = el('input', {
    attrs: { type: 'range', min: '0', max: String(t.steps.length - 1), value: String(current), id: 'slider', 'aria-label': 'Commit' },
  });
  slider.addEventListener('input', () => select(Number(slider.value)));
  const prev = el('button', { text: '‹', attrs: { id: 'prev', title: 'Previous commit (←)', 'aria-label': 'Previous commit' } });
  const next = el('button', { text: '›', attrs: { id: 'next', title: 'Next commit (→)', 'aria-label': 'Next commit' } });
  prev.addEventListener('click', () => select(current - 1));
  next.addEventListener('click', () => select(current + 1));

  const player = el(
    'section',
    { class: 'player' },
    el('div', { class: 'controls' }, prev, slider, next, el('span', { class: 'position', attrs: { id: 'position' } })),
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
        const row = el(
          'li',
          { attrs: { tabindex: '0', 'data-index': String(index) } },
          el('span', { class: 'date', text: shortDate(step.commit.date) }),
          el('code', { class: 'sha', text: step.commit.sha.slice(0, 7) }),
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

function select(index: number) {
  if (!timeline) return;
  current = Math.min(Math.max(index, 0), timeline.steps.length - 1);
  const step = timeline.steps[current]!;

  (document.getElementById('slider') as HTMLInputElement).value = String(current);
  document.getElementById('position')!.textContent = `${current + 1} / ${timeline.steps.length}`;
  (document.getElementById('prev') as HTMLButtonElement).disabled = current === 0;
  (document.getElementById('next') as HTMLButtonElement).disabled = current === timeline.steps.length - 1;
  document.querySelectorAll('#commit-list li').forEach((li) => {
    li.classList.toggle('current', li.getAttribute('data-index') === String(current));
  });
  document.getElementById('step')!.replaceChildren(renderStep(timeline, step));
}

function renderStep(t: Timeline, step: Step): HTMLElement {
  const { commit } = step;
  const body = commit.message.split('\n').slice(1).join('\n').trim();

  const removed =
    step.removedLines.length > 0 &&
    el(
      'details',
      { class: 'removed' },
      el('summary', { text: `${step.removedLines.length} line${step.removedLines.length === 1 ? '' : 's'} removed by this commit` }),
      el('pre', {}, ...step.removedLines.map((line) => el('div', { class: 'line del', text: line || ' ' }))),
    );

  const added = new Set(step.addedLines);
  const code = el(
    'pre',
    { class: 'snapshot' },
    ...step.snapshot.split('\n').map((line, i) =>
      el(
        'div',
        { class: added.has(i + 1) ? 'line add' : 'line' },
        el('span', { class: 'ln', text: String(step.startLine + i), attrs: { 'aria-hidden': 'true' } }),
        el('span', { class: 'mark', text: added.has(i + 1) ? '+' : ' ', attrs: { 'aria-hidden': 'true' } }),
        el('span', { class: 'text', text: line || ' ' }),
      ),
    ),
  );

  return el(
    'article',
    { class: 'step' },
    el('h3', { text: subject(commit.message) }),
    el('p', { class: 'meta' }, commitLink(t, commit.sha), ` · ${commit.author} · ${shortDate(commit.date)}`),
    body && el('details', { class: 'body' }, el('summary', { text: 'Full commit message' }), el('pre', { text: body })),
    el('p', { class: 'note pending', text: 'The AI note for this step will appear here.' }),
    code,
    removed,
  );
}

function commitLink(t: Timeline, sha: string): HTMLElement {
  const label = sha.slice(0, 7);
  if (!t.github) return el('code', { class: 'sha', text: label });
  return el(
    'a',
    { attrs: { href: `https://github.com/${t.github.owner}/${t.github.repo}/commit/${sha}`, title: sha } },
    el('code', { class: 'sha', text: label }),
  );
}

function subject(message: string): string {
  return message.split('\n')[0] ?? '';
}

function shortDate(iso: string): string {
  return iso.slice(0, 10);
}
