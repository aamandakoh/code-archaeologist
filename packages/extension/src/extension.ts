import * as vscode from 'vscode';
import {
  addGitHubContext,
  addGitLabContext,
  GitHubCache,
  modelClient,
  type Provider,
  StoryCache,
  TimelineCache,
  trace,
  writeStory,
  type Timeline,
} from '@code-archaeologist/core';
import { ArchaeologistPanel } from './panel';
import { SECRETS, SettingsPanel } from './settings';
import type { AiState } from './messages';

const KEY_SECRET = SECRETS.apiKey;
const GITHUB_SECRET = SECRETS.githubToken;
const GITLAB_SECRET = SECRETS.gitlabToken;

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel('Code Archaeologist');
  const timelines = new TimelineCache(vscode.Uri.joinPath(context.globalStorageUri, 'timelines').fsPath);
  const stories = new StoryCache(vscode.Uri.joinPath(context.globalStorageUri, 'stories').fsPath);
  const github = new GitHubCache(vscode.Uri.joinPath(context.globalStorageUri, 'github').fsPath);

  /**
   * The timeline on screen, without its story, so the story can be retried. `raw` is the trace
   * before GitHub context, so a new token can read it again.
   */
  let shown: { timeline: Timeline; raw: Timeline; panel: ArchaeologistPanel } | undefined;
  /** Cancels the story request for a timeline that is no longer on screen. */
  let pending: AbortController | undefined;

  /** The provider, URL and model from settings. Gemini on Google AI Studio unless changed. */
  function llmSettings(): { provider: Provider; baseUrl?: string; model?: string } {
    const config = vscode.workspace.getConfiguration('codeArchaeologist');
    const provider = config.get<string>('provider') === 'openai' ? 'openai' : 'gemini';
    return { provider, baseUrl: config.get<string>('baseUrl')?.trim() || undefined, model: config.get<string>('model')?.trim() || undefined };
  }

  async function apiKey(provider: Provider): Promise<string | undefined> {
    const env = provider === 'openai' ? process.env.OPENAI_API_KEY : process.env.GEMINI_API_KEY;
    return (await context.secrets.get(KEY_SECRET)) || env || undefined;
  }

  async function githubToken(): Promise<string | undefined> {
    return (await context.secrets.get(GITHUB_SECRET)) || process.env.GITHUB_TOKEN || undefined;
  }

  async function gitlabToken(): Promise<string | undefined> {
    return (await context.secrets.get(GITLAB_SECRET)) || process.env.GITLAB_TOKEN || undefined;
  }

  /** Reads PRs (or GitLab merge requests), reviews and issues for the raw trace, then writes the story from all of it. */
  async function explain(raw: Timeline, panel: ArchaeologistPanel): Promise<void> {
    pending?.abort();
    shown = { timeline: raw, raw, panel };
    if ((!raw.github && !raw.gitlab) || raw.steps.length === 0) return tellStory(raw, raw, panel);
    const host = raw.gitlab ? 'GitLab' : 'GitHub';

    const controller = new AbortController();
    pending = controller;
    panel.post({ type: 'timeline', timeline: raw, ai: { status: 'reading', message: raw.gitlab ? 'Reading merge requests…' : 'Reading pull requests…' } });
    let timeline: Timeline;
    try {
      const options = {
        cache: github,
        signal: controller.signal,
        onProgress: (message: string) => panel.post({ type: 'progress', message: `${message}…` }),
      };
      timeline = raw.gitlab
        ? await addGitLabContext(raw, { ...options, token: await gitlabToken() })
        : await addGitHubContext(raw, { ...options, token: await githubToken() });
    } catch (error) {
      if (controller.signal.aborted) return;
      throw error;
    } finally {
      if (pending === controller) pending = undefined;
    }
    if (controller.signal.aborted) return;
    const c = timeline.context;
    if (c) output.appendLine(`${host} for ${raw.file}: ${c.prs} PRs, ${c.reviews} comments, ${c.issues} issues${c.error ? `; ${c.error}` : ''}`);
    await tellStory(timeline, raw, panel);
  }

  async function tellStory(timeline: Timeline, raw: Timeline, panel: ArchaeologistPanel): Promise<void> {
    pending?.abort();
    shown = { timeline, raw, panel };
    const post = (ai: AiState, story = timeline.story) => panel.post({ type: 'timeline', timeline: { ...timeline, story }, ai });

    const settings = llmSettings();
    const key = await apiKey(settings.provider);
    if (timeline.steps.length === 0) return post({ status: 'ready' });
    // A self-hosted OpenAI-compatible server usually needs no key.
    if (!key && (settings.provider === 'gemini' || !settings.baseUrl)) return post({ status: 'no-key' });

    const controller = new AbortController();
    pending = controller;
    post({ status: 'writing' });
    try {
      const story = await writeStory(timeline, {
        client: modelClient({ ...settings, apiKey: key }),
        cache: stories,
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      const flagged = story.steps.filter((s) => s.flagged).length + story.verdict.reasons.filter((r) => r.flagged).length;
      output.appendLine(`Story for ${timeline.file}: ${story.verdict.level} risk, ${story.steps.length} notes, ${flagged} unverified claims (${story.model})`);
      post({ status: 'ready' }, story);
    } catch (error) {
      if (controller.signal.aborted) return;
      const message = error instanceof Error ? error.message : String(error);
      output.appendLine(`Story failed for ${timeline.file}: ${message}`);
      post({ status: 'error', message });
    } finally {
      if (pending === controller) pending = undefined;
    }
  }

  async function setApiKey(): Promise<void> {
    const key = await vscode.window.showInputBox({
      title: 'LLM API key',
      prompt:
        'Paste a key for the API in the codeArchaeologist.baseUrl setting (by default Gemini: aistudio.google.com/apikey). It is kept in VS Code secret storage.',
      password: true,
      ignoreFocusOut: true,
    });
    if (key === undefined) return;
    if (key.trim()) {
      await context.secrets.store(KEY_SECRET, key.trim());
      void vscode.window.showInformationMessage('Code Archaeologist: API key saved.');
    } else {
      await context.secrets.delete(KEY_SECRET);
      void vscode.window.showInformationMessage('Code Archaeologist: API key removed.');
    }
    if (shown && !shown.timeline.story) void tellStory(shown.timeline, shown.raw, shown.panel);
  }

  async function setGitHubToken(): Promise<void> {
    const token = await vscode.window.showInputBox({
      title: 'GitHub token',
      prompt:
        'Paste a fine-grained GitHub token with read-only access to public repositories (github.com/settings/personal-access-tokens). It is kept in VS Code secret storage.',
      password: true,
      ignoreFocusOut: true,
    });
    if (token === undefined) return;
    if (token.trim()) {
      await context.secrets.store(GITHUB_SECRET, token.trim());
      void vscode.window.showInformationMessage('Code Archaeologist: GitHub token saved.');
    } else {
      await context.secrets.delete(GITHUB_SECRET);
      void vscode.window.showInformationMessage('Code Archaeologist: GitHub token removed.');
    }
    // Read GitHub again for the lines on screen, then rewrite the story with what it found.
    if (shown) void explain(shown.raw, shown.panel);
  }

  async function setGitLabToken(): Promise<void> {
    const token = await vscode.window.showInputBox({
      title: 'GitLab token',
      prompt:
        'Paste a GitLab personal access token with the read_api scope (User settings > Access tokens on your GitLab). It is kept in VS Code secret storage.',
      password: true,
      ignoreFocusOut: true,
    });
    if (token === undefined) return;
    if (token.trim()) {
      await context.secrets.store(GITLAB_SECRET, token.trim());
      void vscode.window.showInformationMessage('Code Archaeologist: GitLab token saved.');
    } else {
      await context.secrets.delete(GITLAB_SECRET);
      void vscode.window.showInformationMessage('Code Archaeologist: GitLab token removed.');
    }
    if (shown) void explain(shown.raw, shown.panel);
  }

  function openSettings(): void {
    SettingsPanel.show(context.extensionUri, {
      secrets: context.secrets,
      async test(values, typedKey) {
        const key = typedKey || (await apiKey(values.provider));
        const client = modelClient({
          provider: values.provider,
          baseUrl: values.baseUrl.trim() || undefined,
          model: values.model.trim() || undefined,
          apiKey: key,
          retries: 0,
          timeoutMs: 60_000,
        });
        const prompt = {
          system: 'You check that an API connection works.',
          user: 'Reply with {"ok": true}.',
          schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] },
          ids: [],
          reduced: 0,
        };
        const started = Date.now();
        try {
          await client.generate(prompt);
          return { ok: true, message: `Connected: ${client.model} answered in ${((Date.now() - started) / 1000).toFixed(1)}s.` };
        } catch (error) {
          return { ok: false, message: error instanceof Error ? error.message : String(error) };
        }
      },
      saved() {
        // New keys, tokens or model: read the lines on screen again and rewrite their story.
        if (shown) void explain(shown.raw, shown.panel);
      },
    });
  }

  ArchaeologistPanel.onAction = (message) => {
    if (message.type === 'set-key') void setApiKey();
    if (message.type === 'set-github-token') void setGitHubToken();
    if (message.type === 'set-gitlab-token') void setGitLabToken();
    if (message.type === 'open-settings') openSettings();
    if (message.type === 'retry-story' && shown) void tellStory(shown.timeline, shown.raw, shown.panel);
  };

  context.subscriptions.push(
    output,
    { dispose: () => pending?.abort() },
    vscode.commands.registerCommand('codeArchaeologist.setApiKey', setApiKey),
    vscode.commands.registerCommand('codeArchaeologist.setGitHubToken', setGitHubToken),
    vscode.commands.registerCommand('codeArchaeologist.setGitLabToken', setGitLabToken),
    vscode.commands.registerCommand('codeArchaeologist.openSettings', openSettings),
    vscode.commands.registerCommand('codeArchaeologist.trace', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        void vscode.window.showErrorMessage('Code Archaeologist: open a file and select the lines to trace.');
        return;
      }
      const { document } = editor;
      if (document.uri.scheme !== 'file') {
        void vscode.window.showErrorMessage('Code Archaeologist: only files saved on disk in a git repository can be traced.');
        return;
      }

      const [start, end] = selectedLines(editor.selection);
      const name = vscode.workspace.asRelativePath(document.uri);
      const panel = ArchaeologistPanel.show(context.extensionUri);
      pending?.abort();
      shown = undefined;
      panel.post({ type: 'loading', file: name, range: [start, end], message: 'Tracing history…' });

      let timeline: Timeline;
      try {
        timeline = await trace({
          file: document.uri.fsPath,
          start,
          end,
          cache: timelines,
          gitlabUrl: vscode.workspace.getConfiguration('codeArchaeologist').get<string>('gitlabUrl') || undefined,
          onProgress: (message) => panel.post({ type: 'progress', message: `${message}…` }),
        });
        if (document.isDirty) {
          timeline.warnings.unshift('This file has unsaved edits. The trace uses the last commit, not the editor.');
        }
        output.appendLine(`Traced ${timeline.file}:${start}-${end}: ${timeline.steps.length} steps, ${timeline.skipped} skipped`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        output.appendLine(`Trace failed for ${name}:${start}-${end}: ${message}`);
        panel.post({ type: 'error', message });
        return;
      }
      // The raw timeline shows at once; GitHub or GitLab context and then the story fill in after it.
      await explain(timeline, panel);
    }),
  );
}

export function deactivate(): void {}

/** 1-based inclusive lines. A selection ending at column 0 doesn't include that last line. */
function selectedLines(selection: vscode.Selection): [number, number] {
  const start = selection.start.line + 1;
  let end = selection.end.line + 1;
  if (!selection.isEmpty && selection.end.character === 0 && end > start) end--;
  return [start, end];
}
