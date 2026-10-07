import type { Timeline } from './types.js';

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
  out.push('');

  timeline.steps.forEach((step, index) => {
    const subject = step.commit.message.split('\n')[0] ?? '';
    out.push(`${String(index + 1).padStart(2)}. ${step.commit.sha.slice(0, 7)} ${step.commit.date.slice(0, 10)} ${step.commit.author}`);
    out.push(`    ${subject}`);
    out.push(`    +${step.addedLines.length} -${step.removedLines.length} lines, starts at line ${step.startLine}`);
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
