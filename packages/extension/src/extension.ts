import * as vscode from 'vscode';
import {
  DEFAULT_MODEL,
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

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel('Code Archaeologist');
  const timelines = new TimelineCache(vscode.Uri.joinPath(context.globalStorageUri, 'timelines').fsPath);
  const stories = new StoryCache(vscode.Uri.joinPath(context.globalStorageUri, 'stories').fsPath);

  /** The timeline on screen, without its story, so the story can be retried. */
  let shown: { timeline: Timeline; panel: ArchaeologistPanel } | undefined;
  /** Cancels the story request for a timeline that is no longer on screen. */
  let pending: AbortController | undefined;

  async function apiKey(): Promise<string | undefined> {
    return (await context.secrets.get(KEY_SECRET)) || process.env.GEMINI_API_KEY || undefined;
  }

  async function tellStory(timeline: Timeline, panel: ArchaeologistPanel): Promise<void> {
    pending?.abort();
    shown = { timeline, panel };
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
    if (shown && !shown.timeline.story) void tellStory(shown.timeline, shown.panel);
  }

  ArchaeologistPanel.onAction = (message) => {
    if (message.type === 'set-key') void setApiKey();
    if (message.type === 'retry-story' && shown) void tellStory(shown.timeline, shown.panel);
  };

  context.subscriptions.push(
    output,
    { dispose: () => pending?.abort() },
    vscode.commands.registerCommand('codeArchaeologist.setApiKey', setApiKey),
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
      // The raw timeline shows at once; the story fills in when the model answers.
      await tellStory(timeline, panel);
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
