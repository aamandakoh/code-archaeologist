import path from 'node:path';
import { parseArgs } from 'node:util';
import {
  addGitHubContext,
  addGitLabContext,
  addJiraContext,
  DEFAULT_MODEL,
  GitHubCache,
  describeStory,
  describeTimeline,
  modelClient,
  parseHeaders,
  parseNameList,
  parseProjectKeys,
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
  --no-github        Skip pull requests, reviews and issues from GitHub or GitLab. They
                     are read when origin is on github.com (with GITHUB_TOKEN if set) or
                     on GitLab (with GITLAB_TOKEN, needed for private projects)
  --gitlab-url <url> Your self-hosted GitLab; GITLAB_TOKEN is sent only there and to gitlab.com
  --jira-url <url>   Read Jira tickets named in commits and PRs, e.g. PAY-412 (or JIRA_URL).
                     JIRA_TOKEN is sent only there; Jira Cloud also needs JIRA_EMAIL.
                     JIRA_PROJECTS="PAY,CORE" limits which keys count, and
                     JIRA_IGNORE_AUTHORS="gitlab-bot, Jenkins" drops those commenters
  --story            Ask an LLM for per-commit notes, a summary, warning flags and a score
                     (Gemini by default, with GEMINI_API_KEY)
  --provider <name>  gemini (default) or openai, for any OpenAI-compatible API
                     (key in OPENAI_API_KEY, optional for local servers)
  --base-url <url>   LLM API URL, e.g. http://localhost:11434/v1 (default: the
                     provider's own API)
  --header <h>       Extra header on every LLM request, as "Name: value"; repeatable
  --model <id>       Model for --story (default ${DEFAULT_MODEL} for Gemini; needed for openai)
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
      provider: { type: 'string' },
      'base-url': { type: 'string' },
      header: { type: 'string', multiple: true },
      'gitlab-url': { type: 'string' },
      'jira-url': { type: 'string' },
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
  const provider = values.provider ?? 'gemini';
  if (provider !== 'gemini' && provider !== 'openai') {
    console.error(`archaeologist: --provider must be gemini or openai, not ${provider}`);
    return 1;
  }
  const apiKey = (provider === 'openai' ? process.env.OPENAI_API_KEY : process.env.GEMINI_API_KEY) || undefined;
  if (values.story && provider === 'gemini' && !apiKey) {
    console.error('archaeologist: --story needs a Gemini API key in GEMINI_API_KEY');
    return 1;
  }
  if (values.story && provider === 'openai' && !values.model) {
    console.error('archaeologist: --provider openai needs --model');
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
    gitlabUrl: values['gitlab-url'] ?? process.env.GITLAB_URL,
    onProgress: progress,
  });

  if (!values['no-github'] && (timeline.github || timeline.gitlab)) {
    const options = { cache: cacheDir ? new GitHubCache(path.join(cacheDir, 'github')) : undefined, onProgress: progress };
    timeline = timeline.gitlab
      ? await addGitLabContext(timeline, { ...options, token: process.env.GITLAB_TOKEN || undefined, gitlabUrl: values['gitlab-url'] ?? process.env.GITLAB_URL })
      : await addGitHubContext(timeline, { ...options, token: process.env.GITHUB_TOKEN || process.env.GH_TOKEN || undefined });
    if (timeline.context?.error && !values.json) console.error(`warning: ${timeline.context.error}`);
  }

  const jiraUrl = values['jira-url'] ?? process.env.JIRA_URL;
  if (jiraUrl) {
    timeline = await addJiraContext(timeline, {
      url: jiraUrl,
      email: process.env.JIRA_EMAIL || undefined,
      token: process.env.JIRA_TOKEN || undefined,
      projects: parseProjectKeys(process.env.JIRA_PROJECTS),
      ignoreAuthors: parseNameList(process.env.JIRA_IGNORE_AUTHORS),
      onProgress: progress,
    });
    if (timeline.jira?.error && !values.json) console.error(`warning: ${timeline.jira.error}`);
  }

  if (values.story) {
    timeline.story = await writeStory(timeline, {
      client: modelClient({ provider, apiKey, model: values.model, baseUrl: values['base-url'], headers: parseHeaders((values.header ?? []).join('\n')).headers }),
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
