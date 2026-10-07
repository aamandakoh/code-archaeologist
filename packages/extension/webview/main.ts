import type { Step, Story, Timeline } from '@code-archaeologist/core/src/types.js';
import type { AiState, FromWebview, ToWebview } from '../src/messages';

declare function acquireVsCodeApi(): { postMessage(message: FromWebview): void };

const vscode = acquireVsCodeApi();
const app = document.getElementById('app')!;

let timeline: Timeline | undefined;
let ai: AiState = { status: 'writing' };
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
    case 'timeline': {
      const same = timeline !== undefined && sameTrace(timeline, message.timeline) && document.getElementById('story');
      timeline = message.timeline;
      ai = message.ai;
      if (same) {
        // The story arrived for the timeline on screen: update in place, keep the slider where it is.
        document.getElementById('story')!.replaceWith(renderStory(timeline, ai));
        if (timeline.steps.length > 0) select(current);
      } else {
        current = Math.max(0, timeline.steps.length - 1);
        renderTimeline(timeline);
      }
      break;
    }
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

  // Pinned above the history so the verdict is the first thing you read.
  const story = renderStory(t, ai);

  const warnings = t.warnings.length > 0 && el('div', { class: 'warnings' }, ...t.warnings.map((w) => el('p', { text: w })));

  if (t.steps.length === 0) {
    app.replaceChildren(story, header, warnings || '', el('p', { class: 'status', text: 'No commits touched these lines.' }));
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

  app.replaceChildren(story, header, warnings || '', player, list);
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
    renderNote(t, step),
    renderEvidence(t, step),
    code,
    removed,
  );
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
  const button = (text: string, message: FromWebview) => {
    const b = el('button', { class: 'action', text });
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
          el('p', { text: 'Add a Gemini API key to get a summary, a note on every commit and a "safe to change?" verdict. The raw history is below.' }),
          button('Add Gemini API key', { type: 'set-key' }),
          githubNotice(t),
        );
      case 'error':
        return section(
          'pending failed',
          el('p', { class: 'error', text: `Could not write the story. ${state.message}` }),
          button('Try again', { type: 'retry-story' }),
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
        target === undefined ? {} : { class: 'jump', attrs: { tabindex: '0', title: 'Show the commit this cites' } },
        el('span', { text: reason.text }),
        ' ',
        citationChips(t, reason),
      );
      if (target !== undefined) {
        item.addEventListener('click', (e) => {
          if ((e.target as HTMLElement).closest('a')) return; // chips open GitHub
          select(target);
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

  return section(
    `ready level-${story.verdict.level}`,
    el('div', { class: 'verdict-head' }, el('span', { class: 'badge', text: LEVELS[story.verdict.level] })),
    el('p', { class: 'summary-line', text: story.summary }),
    reasons,
    checks,
    el('p', { class: 'fineprint', text: footer }),
    githubNotice(t),
  );
}

/** "commit messages and diffs", plus what GitHub added. */
function evidenceSources(t: Timeline): string {
  const c = t.context;
  if (!c || c.prs === 0) return 'commit messages and diffs';
  const parts = [`${c.prs} pull request${c.prs === 1 ? '' : 's'}`];
  if (c.reviews > 0) parts.push(`${c.reviews} review comment${c.reviews === 1 ? '' : 's'}`);
  if (c.issues > 0) parts.push(`${c.issues} linked issue${c.issues === 1 ? '' : 's'}`);
  return `commit messages, diffs, ${parts.join(', ')}`;
}

/** Says when GitHub context is missing or partial, with a button to add a token when that would help. */
function githubNotice(t: Timeline): HTMLElement | undefined {
  const c = t.context;
  if (!c?.error) return undefined;
  const notice = el('p', { class: 'github-notice', text: `Pull requests and reviews may be missing. ${c.error}` });
  if (!c.token) {
    const b = el('button', { class: 'action secondary', text: 'Add GitHub token' });
    b.addEventListener('click', () => vscode.postMessage({ type: 'set-github-token' }));
    notice.append(' ', b);
  }
  return notice;
}

/** The PR, linked issues and review discussion behind one commit. */
function renderEvidence(t: Timeline, step: Step): HTMLElement | undefined {
  if (!step.pr && step.issues.length === 0 && step.reviews.length === 0) return undefined;
  const links = el(
    'p',
    { class: 'evidence-links' },
    step.pr && el('a', { class: 'pr', attrs: { href: step.pr.url, title: 'Pull request' } }, el('span', { class: 'chip', text: `#${step.pr.number}` }), ` ${step.pr.title}`),
    ...step.issues.map((issue) =>
      el(
        'a',
        { class: 'issue', attrs: { href: issue.url } },
        el('span', { class: 'chip', text: `${issue.relation === 'reverts' ? 'reverts' : 'fixes'} #${issue.number}` }),
        ` ${issue.title}`,
      ),
    ),
  );
  const comments =
    step.reviews.length > 0 &&
    el(
      'details',
      { class: 'reviews' },
      el('summary', { text: `${step.reviews.length} comment${step.reviews.length === 1 ? '' : 's'} from the pull request${step.reviews.some((r) => r.on) ? 's' : ''}` }),
      el(
        'ol',
        {},
        ...step.reviews.map((review, i) =>
          el(
            'li',
            { attrs: { id: `review-${step.commit.sha.slice(0, 7)}-${i + 1}` } },
            el(
              'p',
              { class: 'meta' },
              el('a', { text: review.author, attrs: { href: review.url } }),
              review.date ? ` · ${shortDate(review.date)}` : '',
              review.on ? ` · on reverted #${review.on}` : '',
              review.path ? ` · on ${review.path.split('/').pop()}` : '',
            ),
            el('blockquote', { text: review.body }),
          ),
        ),
      ),
    );
  return el('div', { class: 'evidence' }, links, comments);
}

function renderNote(t: Timeline, step: Step): HTMLElement {
  if (ai.status === 'writing' || ai.status === 'reading') return el('p', { class: 'note pending', text: 'Writing the note for this commit…' });
  const note = t.story?.steps.find((n) => n.commit === step.commit.sha);
  if (!note) {
    const text = t.story ? 'No note for this commit.' : 'The AI note for this commit appears here once the story is written.';
    return el('p', { class: 'note pending', text });
  }
  return el('p', { class: 'note' }, el('span', { text: note.note }), ' ', citationChips(t, note));
}

/** Chips linking each citation to GitHub, or an "unverified" marker when none survived the check. */
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
      return href
        ? el('a', { class: 'chip', text: label, attrs: { href, title: citation } })
        : el('span', { class: 'chip', text: label, attrs: { title: citation } });
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
  return kind === 'pr' || kind === 'issue' ? `#${ref}` : ref;
}

function citationUrl(t: Timeline, citation: string): string | undefined {
  const [kind, ref = ''] = citation.split(':');
  if (kind === 'review') {
    const [sha, n] = ref.split('-');
    return t.steps.find((s) => s.commit.sha.startsWith(sha ?? ''))?.reviews[Number(n) - 1]?.url;
  }
  if (!t.github) return undefined;
  const repo = `https://github.com/${t.github.owner}/${t.github.repo}`;
  if (kind === 'commit') {
    const sha = t.steps.find((s) => s.commit.sha.startsWith(ref))?.commit.sha ?? ref;
    return `${repo}/commit/${sha}`;
  }
  if (kind === 'pr') return `${repo}/pull/${ref}`;
  if (kind === 'issue') return `${repo}/issues/${ref}`;
  return undefined;
}

/** The step a list of citations points at: the first commit cited, else the commit naming a cited PR or issue. */
function stepForCitations(t: Timeline, citations: string[]): number | undefined {
  for (const citation of citations) {
    const [kind, ref = ''] = citation.split(':');
    const index = t.steps.findIndex((s) =>
      kind === 'commit' || kind === 'review'
        ? s.commit.sha.startsWith(ref.split('-')[0] ?? ref)
        : s.pr?.number === Number(ref) || new RegExp(`#${ref}\\b`).test(s.commit.message) || s.issues.some((i) => i.number === Number(ref)),
    );
    if (index >= 0) return index;
  }
  return undefined;
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
