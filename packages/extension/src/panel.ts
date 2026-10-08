import * as vscode from 'vscode';
import type { FromWebview, ToWebview } from './messages';

/** The one panel beside the editor. A new trace reuses it. */
export class ArchaeologistPanel {
  private static current: ArchaeologistPanel | undefined;

  private ready = false;
  /** The latest state, replayed whenever the page (re)loads. */
  private last: ToWebview | undefined;
  private lastProgress: ToWebview | undefined;

  /** Handles what the page asks for besides 'ready', e.g. adding an API key. */
  static onAction: ((message: Exclude<FromWebview, { type: 'ready' }>) => void) | undefined;

  static show(extensionUri: vscode.Uri): ArchaeologistPanel {
    if (ArchaeologistPanel.current) {
      ArchaeologistPanel.current.panel.reveal(vscode.ViewColumn.Beside, true);
      return ArchaeologistPanel.current;
    }
    const panel = vscode.window.createWebviewPanel(
      'codeArchaeologist',
      'Code Archaeologist',
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      {
        enableScripts: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'dist'), vscode.Uri.joinPath(extensionUri, 'media')],
      },
    );
    ArchaeologistPanel.current = new ArchaeologistPanel(panel, extensionUri);
    return ArchaeologistPanel.current;
  }

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
  ) {
    panel.iconPath = vscode.Uri.joinPath(extensionUri, 'media', 'icon.svg');
    panel.webview.html = this.html(panel.webview, extensionUri);
    panel.webview.onDidReceiveMessage((message: FromWebview) => {
      if (message.type === 'ready') {
        // Also fires when a hidden panel is shown again and its page reloads.
        this.ready = true;
        for (const m of [this.last, this.lastProgress]) if (m) void panel.webview.postMessage(m);
      } else {
        ArchaeologistPanel.onAction?.(message);
      }
    });
    panel.onDidChangeViewState(() => {
      if (!panel.visible) this.ready = false;
    });
    panel.onDidDispose(() => {
      this.ready = false;
      ArchaeologistPanel.current = undefined;
    });
  }

  post(message: ToWebview): void {
    if (message.type === 'progress') {
      this.lastProgress = message;
    } else {
      this.last = message;
      this.lastProgress = undefined;
    }
    if (this.ready) void this.panel.webview.postMessage(message);
  }

  private html(webview: vscode.Webview, extensionUri: vscode.Uri): string {
    const script = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'dist', 'webview.js'));
    const style = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'panel.css'));
    const nonce = Array.from({ length: 32 }, () => Math.floor(Math.random() * 36).toString(36)).join('');
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; img-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link href="${style}" rel="stylesheet">
  <title>Code Archaeologist</title>
</head>
<body>
  <main id="app" aria-live="polite"></main>
  <script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
  }
}
