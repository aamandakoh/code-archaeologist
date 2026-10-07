import * as vscode from 'vscode';
import { TimelineCache, trace } from '@code-archaeologist/core';
import { ArchaeologistPanel } from './panel';

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel('Code Archaeologist');
  const cache = new TimelineCache(vscode.Uri.joinPath(context.globalStorageUri, 'timelines').fsPath);

  context.subscriptions.push(
    output,
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
      panel.post({ type: 'loading', file: name, range: [start, end], message: 'Tracing history…' });

      try {
        const timeline = await trace({
          file: document.uri.fsPath,
          start,
          end,
          cache,
          onProgress: (message) => panel.post({ type: 'progress', message: `${message}…` }),
        });
        if (document.isDirty) {
          timeline.warnings.unshift('This file has unsaved edits. The trace uses the last commit, not the editor.');
        }
        output.appendLine(`Traced ${timeline.file}:${start}-${end}: ${timeline.steps.length} steps, ${timeline.skipped} skipped`);
        panel.post({ type: 'timeline', timeline });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        output.appendLine(`Trace failed for ${name}:${start}-${end}: ${message}`);
        panel.post({ type: 'error', message });
      }
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
