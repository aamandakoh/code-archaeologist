import path from 'node:path';
import { parseArgs } from 'node:util';
import {
  addGitHubContext,
  DEFAULT_MODEL,
  GitHubCache,
  describeStory,
  describeTimeline,
  geminiClient,
  StoryCache,
  trace,
  TimelineCache,
  writeStory,
} from '@code-archaeologist/core';

const USAGE = `Usage: archaeologist trace <file> <start> <end> [options]

Traces how lines <start>-<end> of <file> (as they are at HEAD) evolved, commit by commit.

Options:
  --json             Print the Timeline as JSON
  --snapshots        Show the traced lines at each commit (text output only)
  --keep-noise       Keep whitespace, formatting and license-only commits
  --no-github        Skip pull requests, reviews and issues from GitHub. They are read
                     when origin is on github.com, with GITHUB_TOKEN if set
  --story            Ask Gemini for per-commit notes, a summary and a risk verdict
                     (needs GEMINI_API_KEY)
  --model <id>       Gemini model for --story (default ${DEFAULT_MODEL})
  --cache-dir <dir>  Reuse traces and stories for the same file, range and HEAD
  -h, --help         Show this help`;

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      json: { type: 'boolean', default: false },
      snapshots: { type: 'boolean', default: false },
      'keep-noise': { type: 'boolean', default: false },
      'no-github': { type: 'boolean', default: false },
      story: { type: 'boolean', default: false },
      model: { type: 'string' },
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
  const apiKey = process.env.GEMINI_API_KEY;
  if (values.story && !apiKey) {
    console.error('archaeologist: --story needs a Gemini API key in GEMINI_API_KEY');
    return 1;
  }

  const cacheDir = values['cache-dir'] ? path.resolve(values['cache-dir']) : undefined;
  const progress = values.json ? undefined : (message: string) => console.error(`${message}…`);
  let timeline = await trace({
    file,
    start,
    end,
    keepNoise: values['keep-noise'],
    cache: cacheDir ? new TimelineCache(path.join(cacheDir, 'timelines')) : undefined,
    onProgress: progress,
  });

  if (!values['no-github'] && timeline.github) {
    timeline = await addGitHubContext(timeline, {
      token: process.env.GITHUB_TOKEN || process.env.GH_TOKEN || undefined,
      cache: cacheDir ? new GitHubCache(path.join(cacheDir, 'github')) : undefined,
      onProgress: progress,
    });
    if (timeline.context?.error && !values.json) console.error(`warning: ${timeline.context.error}`);
  }

  if (values.story && apiKey) {
    timeline.story = await writeStory(timeline, {
      client: geminiClient({ apiKey, model: values.model }),
      cache: cacheDir ? new StoryCache(path.join(cacheDir, 'stories')) : undefined,
      onProgress: progress,
    });
  }

  if (values.json) {
    console.log(JSON.stringify(timeline, null, 2));
  } else {
    if (timeline.story) console.log(describeStory(timeline, timeline.story), '\n');
    console.log(describeTimeline(timeline, { snapshots: values.snapshots }));
  }
  return 0;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(`archaeologist: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  },
);
