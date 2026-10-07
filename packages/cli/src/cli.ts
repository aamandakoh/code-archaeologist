import path from 'node:path';
import { parseArgs } from 'node:util';
import { describeTimeline, trace, TimelineCache } from '@code-archaeologist/core';

const USAGE = `Usage: archaeologist trace <file> <start> <end> [options]

Traces how lines <start>-<end> of <file> (as they are at HEAD) evolved, commit by commit.

Options:
  --json             Print the Timeline as JSON
  --snapshots        Show the traced lines at each commit (text output only)
  --keep-noise       Keep whitespace, formatting and license-only commits
  --cache-dir <dir>  Reuse results for the same file, range and HEAD
  -h, --help         Show this help`;

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      json: { type: 'boolean', default: false },
      snapshots: { type: 'boolean', default: false },
      'keep-noise': { type: 'boolean', default: false },
      'cache-dir': { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });

  const [command, file, startArg, endArg] = positionals;
  if (values.help || command === undefined) {
    console.log(USAGE);
    return values.help ? 0 : 1;
  }
  if (command !== 'trace' || file === undefined || startArg === undefined || endArg === undefined) {
    console.error(USAGE);
    return 1;
  }

  const start = Number(startArg);
  const end = Number(endArg);
  const timeline = await trace({
    file,
    start,
    end,
    keepNoise: values['keep-noise'],
    cache: values['cache-dir'] ? new TimelineCache(path.resolve(values['cache-dir'])) : undefined,
    onProgress: values.json ? undefined : (message) => console.error(`${message}…`),
  });

  console.log(values.json ? JSON.stringify(timeline, null, 2) : describeTimeline(timeline, { snapshots: values.snapshots }));
  return 0;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(`archaeologist: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  },
);
