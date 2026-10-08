import type { Story, Timeline } from './types.js';

/** Plain-text rendering of a timeline, for the CLI and for logs. */
export function describeTimeline(timeline: Timeline, options: { snapshots?: boolean } = {}): string {
  const out: string[] = [];
  const [start, end] = timeline.range;
  const first = timeline.steps[0]?.commit.date.slice(0, 10);
  const last = timeline.steps.at(-1)?.commit.date.slice(0, 10);
  out.push(`${timeline.file}:${start}-${end} at ${timeline.head.slice(0, 7)}`);
  out.push(
    `${timeline.steps.length} commits${first ? ` from ${first} to ${last}` : ''}, ${timeline.skipped} noise commits skipped`,
  );
  for (const warning of timeline.warnings) out.push(`warning: ${warning}`);
  if (timeline.context) out.push(describeContext(timeline));
  out.push('');

  const notes = new Map(timeline.story?.steps.map((n) => [n.commit, n]));
  timeline.steps.forEach((step, index) => {
    const subject = step.commit.message.split('\n')[0] ?? '';
    out.push(`${String(index + 1).padStart(2)}. ${step.commit.sha.slice(0, 7)} ${step.commit.date.slice(0, 10)} ${step.commit.author}`);
    out.push(`    ${subject}`);
    out.push(`    +${step.addedLines.length} -${step.removedLines.length} lines, starts at line ${step.startLine}`);
    if (step.pr) out.push(`    ${timeline.gitlab ? `MR !${step.pr.number}` : `PR #${step.pr.number}`}: ${step.pr.title}${step.reviews.length ? ` (${step.reviews.length} comments)` : ''}`);
    for (const issue of step.issues) {
      const ref = issue.kind === 'pr' && timeline.gitlab ? `!${issue.number}` : `#${issue.number}`;
      out.push(`    ${issue.relation === 'reverts' ? 'reverts' : 'fixes'} ${ref}: ${issue.title}`);
    }
    for (const ticket of step.tickets ?? []) {
      out.push(`    Jira ${ticket.key}: ${ticket.title}${ticket.status ? ` (${ticket.status})` : ''}`);
    }
    const note = notes.get(step.commit.sha);
    if (note) out.push(`    > ${note.note} ${cite(note)}`);
    if (options.snapshots) {
      const added = new Set(step.addedLines);
      step.snapshot.split('\n').forEach((line, i) => {
        out.push(`    ${added.has(i + 1) ? '+' : ' '} ${line}`);
      });
    }
  });

  if (timeline.noise.length > 0) {
    out.push('', 'Skipped as noise:');
    for (const n of timeline.noise) {
      out.push(`    ${n.commit.sha.slice(0, 7)} ${n.reason}: ${n.commit.message.split('\n')[0]}`);
    }
  }
  return out.join('\n');
}

/** Plain-text rendering of the summary and verdict. */
export function describeStory(timeline: Timeline, story: Story): string {
  const out = [story.summary, '', `Risk to change: ${story.verdict.level.toUpperCase()}`];
  for (const reason of story.verdict.reasons) out.push(`  - ${reason.text} ${cite(reason)}`);
  if (story.verdict.checks.length > 0) {
    out.push('Check before changing:');
    for (const check of story.verdict.checks) out.push(`  - ${check}`);
  }
  const reduced = story.reduced ? `, ${story.reduced} of ${timeline.steps.length} commits sent as subject only` : '';
  out.push(`(written by ${story.model}${reduced})`);
  return out.join('\n');
}

function describeContext(timeline: Timeline): string {
  const c = timeline.context!;
  const found =
    c.source === 'gitlab'
      ? `GitLab: ${c.prs} merge requests, ${c.reviews} comments, ${c.issues} linked issues${c.token ? '' : ' (no token)'}`
      : `GitHub: ${c.prs} pull requests, ${c.reviews} review comments, ${c.issues} linked issues${c.token ? '' : ' (no token)'}`;
  return c.error ? `${found}. ${c.error}` : found;
}

function cite(claim: { citations: string[]; flagged?: boolean }): string {
  return claim.flagged ? '[unverified: no matching evidence]' : `[${claim.citations.join(', ')}]`;
}
