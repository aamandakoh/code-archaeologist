import * as vscode from 'vscode';
import {
  addGitHubContext,
  DEFAULT_MODEL,
  GitHubCache,
  geminiClient,
  StoryCache,
  TimelineCache,
  trace,
  writeStory,
  type Timeline,
} from '@code-archaeologist/core';
import { ArchaeologistPanel } from './panel';
import type { AiState } from './messages';

const KEY_SECRET = 'codeArchaeologist.geminiApiKey';
const GITHUB_SECRET = 'codeArchaeologist.githubToken';

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

  async function apiKey(): Promise<string | undefined> {
    return (await context.secrets.get(KEY_SECRET)) || process.env.GEMINI_API_KEY || undefined;
  }

  async function githubToken(): Promise<string | undefined> {
    return (await context.secrets.get(GITHUB_SECRET)) || process.env.GITHUB_TOKEN || undefined;
  }

  /** Reads PRs, reviews and issues for the raw trace, then writes the story from all of it. */
  async function explain(raw: Timeline, panel: ArchaeologistPanel): Promise<void> {
    pending?.abort();
    shown = { timeline: raw, raw, panel };
    if (!raw.github || raw.steps.length === 0) return tellStory(raw, raw, panel);

    const controller = new AbortController();
    pending = controller;
    panel.post({ type: 'timeline', timeline: raw, ai: { status: 'reading', message: 'Reading pull requests…' } });
    let timeline: Timeline;
    try {
      timeline = await addGitHubContext(raw, {
        token: await githubToken(),
        cache: github,
        signal: controller.signal,
        onProgress: (message) => panel.post({ type: 'progress', message: `${message}…` }),
      });
    } catch (error) {
      if (controller.signal.aborted) return;
      throw error;
    } finally {
      if (pending === controller) pending = undefined;
    }
    if (controller.signal.aborted) return;
    const c = timeline.context;
    if (c) output.appendLine(`GitHub for ${raw.file}: ${c.prs} PRs, ${c.reviews} comments, ${c.issues} issues${c.error ? `; ${c.error}` : ''}`);
    await tellStory(timeline, raw, panel);
  }

  async function tellStory(timeline: Timeline, raw: Timeline, panel: ArchaeologistPanel): Promise<void> {
    pending?.abort();
    shown = { timeline, raw, panel };
    const post = (ai: AiState, story = timeline.story) => panel.post({ type: 'timeline', timeline: { ...timeline, story }, ai });

    const key = await apiKey();
    if (timeline.steps.length === 0) return post({ status: 'ready' });
    if (!key) return post({ status: 'no-key' });

    const controller = new AbortController();
    pending = controller;
    post({ status: 'writing' });
    const model = vscode.workspace.getConfiguration('codeArchaeologist').get<string>('model') || DEFAULT_MODEL;
    try {
      const story = await writeStory(timeline, {
        client: geminiClient({ apiKey: key, model }),
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
      title: 'Gemini API key',
      prompt: 'Paste a key from Google AI Studio (aistudio.google.com/apikey). It is kept in VS Code secret storage.',
      password: true,
      ignoreFocusOut: true,
    });
    if (key === undefined) return;
    if (key.trim()) {
      await context.secrets.store(KEY_SECRET, key.trim());
      void vscode.window.showInformationMessage('Code Archaeologist: Gemini API key saved.');
    } else {
      await context.secrets.delete(KEY_SECRET);
      void vscode.window.showInformationMessage('Code Archaeologist: Gemini API key removed.');
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

  ArchaeologistPanel.onAction = (message) => {
    if (message.type === 'set-key') void setApiKey();
    if (message.type === 'set-github-token') void setGitHubToken();
    if (message.type === 'retry-story' && shown) void tellStory(shown.timeline, shown.raw, shown.panel);
  };

  context.subscriptions.push(
    output,
    { dispose: () => pending?.abort() },
    vscode.commands.registerCommand('codeArchaeologist.setApiKey', setApiKey),
    vscode.commands.registerCommand('codeArchaeologist.setGitHubToken', setGitHubToken),
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
      // The raw timeline shows at once; GitHub context and then the story fill in after it.
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
