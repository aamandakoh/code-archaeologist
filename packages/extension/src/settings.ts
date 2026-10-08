import * as vscode from 'vscode';
import { parseHeaders } from '@code-archaeologist/core';
import type { FromSettings, SecretName, SecretState, SettingsValues, ToSettings } from './settingsMessages';

/** The settings form: LLM provider, URL, model and key, the GitHub and GitLab tokens, and Jira. */
export class SettingsPanel {
  private static current: SettingsPanel | undefined;
  private saving = false;
  private stateSeq = 0;

  static show(extensionUri: vscode.Uri, host: SettingsHost): void {
    if (SettingsPanel.current) {
      SettingsPanel.current.panel.reveal();
      return;
    }
    const panel = vscode.window.createWebviewPanel('codeArchaeologistSettings', 'Code Archaeologist Settings', vscode.ViewColumn.Active, {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'dist'), vscode.Uri.joinPath(extensionUri, 'media')],
    });
    SettingsPanel.current = new SettingsPanel(panel, extensionUri, host);
  }

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    private readonly host: SettingsHost,
  ) {
    panel.iconPath = vscode.Uri.joinPath(extensionUri, 'media', 'icon.svg');
    panel.webview.html = html(panel.webview, extensionUri);
    panel.webview.onDidReceiveMessage((message: FromSettings) => void this.handle(message));
    // Edits made in VS Code's own settings show up here too.
    const watch = vscode.workspace.onDidChangeConfiguration((e) => {
      // A save sends the state itself once every setting is written; one sent halfway would show
      // the fields not yet written as empty, and a second Save would then store them empty.
      if (e.affectsConfiguration('codeArchaeologist') && !this.saving) void this.sendState();
    });
    panel.onDidDispose(() => {
      watch.dispose();
      SettingsPanel.current = undefined;
    });
  }

  private async handle(message: FromSettings): Promise<void> {
    if (message.type === 'ready') return this.sendState();
    if (message.type === 'test') {
      const result = await this.host.test(message.values, message.apiKey, message.headers);
      return this.post({ type: 'test-result', target: 'llm', ...result });
    }
    if (message.type === 'test-jira') {
      const result = await this.host.testJira(message.values, message.token);
      return this.post({ type: 'test-result', target: 'jira', ...result });
    }
    this.saving = true;
    try {
      await this.save(message.values, message.secrets);
    } catch (error) {
      void vscode.window.showErrorMessage(`Code Archaeologist: could not save settings. ${error instanceof Error ? error.message : String(error)}`);
      return this.sendState();
    } finally {
      this.saving = false;
    }
    await this.sendState();
    this.post({ type: 'saved' });
    this.host.saved();
  }

  private async save(values: SettingsValues, secrets: Partial<Record<SecretName, string | null>>): Promise<void> {
    const config = vscode.workspace.getConfiguration('codeArchaeologist');
    const target = vscode.ConfigurationTarget.Global;
    // An empty field resets the setting to its default rather than storing "".
    await config.update('provider', values.provider === 'gemini' ? undefined : values.provider, target);
    await config.update('baseUrl', values.baseUrl.trim() || undefined, target);
    await config.update('model', values.model.trim() || undefined, target);
    await config.update('gitlabUrl', values.gitlabUrl.trim() || undefined, target);
    await config.update('jiraUrl', values.jiraUrl.trim() || undefined, target);
    await config.update('jiraEmail', values.jiraEmail.trim() || undefined, target);
    await config.update('jiraProjects', values.jiraProjects.trim() || undefined, target);
    for (const [name, value] of Object.entries(secrets) as [SecretName, string | null][]) {
      if (value === null) await this.host.secrets.delete(SECRETS[name]);
      else if (value.trim()) await this.host.secrets.store(SECRETS[name], value.trim());
    }
  }

  private async sendState(): Promise<void> {
    // Secret reads are async, so an earlier call can finish after a later one: only the latest posts.
    const seq = ++this.stateSeq;
    const config = vscode.workspace.getConfiguration('codeArchaeologist');
    const values: SettingsValues = {
      provider: config.get<string>('provider') === 'openai' ? 'openai' : 'gemini',
      baseUrl: config.get<string>('baseUrl') ?? '',
      model: config.get<string>('model') ?? '',
      gitlabUrl: config.get<string>('gitlabUrl') ?? '',
      jiraUrl: config.get<string>('jiraUrl') ?? '',
      jiraEmail: config.get<string>('jiraEmail') ?? '',
      jiraProjects: config.get<string>('jiraProjects') ?? '',
    };
    const where = async (name: SecretName, ...env: (string | undefined)[]) =>
      (await this.host.secrets.get(SECRETS[name])) ? 'saved' : env.some(Boolean) ? 'env' : 'none';
    const e = process.env;
    const secrets: SecretState = {
      apiKey: await where('apiKey', values.provider === 'openai' ? e.OPENAI_API_KEY : e.GEMINI_API_KEY),
      githubToken: await where('githubToken', e.GITHUB_TOKEN),
      gitlabToken: await where('gitlabToken', e.GITLAB_TOKEN),
      jiraToken: await where('jiraToken', e.JIRA_TOKEN),
      llmHeaders: await where('llmHeaders'),
    };
    const headerNames = Object.keys(parseHeaders((await this.host.secrets.get(SECRETS.llmHeaders)) ?? '').headers);
    if (seq === this.stateSeq) this.post({ type: 'state', values, secrets, headerNames });
  }

  private post(message: ToSettings): void {
    void this.panel.webview.postMessage(message);
  }
}

/** What the panel needs from the extension. */
export type SettingsHost = {
  secrets: vscode.SecretStorage;
  /** Sends a tiny prompt with these settings and says whether the model answered. */
  test(values: SettingsValues, apiKey?: string, headers?: string): Promise<{ ok: boolean; message: string }>;
  /** Asks Jira who the credentials belong to. */
  testJira(values: SettingsValues, token?: string): Promise<{ ok: boolean; message: string }>;
  /** Called after a save, e.g. to rewrite the story on screen with the new settings. */
  saved(): void;
};

/** Secret storage keys, the same ones the "Set … key/token" commands use. */
export const SECRETS: Record<SecretName, string> = {
  apiKey: 'codeArchaeologist.geminiApiKey',
  githubToken: 'codeArchaeologist.githubToken',
  gitlabToken: 'codeArchaeologist.gitlabToken',
  jiraToken: 'codeArchaeologist.jiraToken',
  llmHeaders: 'codeArchaeologist.llmHeaders',
};

function html(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const script = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'dist', 'settings.js'));
  const style = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'settings.css'));
  const nonce = Array.from({ length: 32 }, () => Math.floor(Math.random() * 36).toString(36)).join('');
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link href="${style}" rel="stylesheet">
  <title>Code Archaeologist Settings</title>
</head>
<body>
  <main id="app"></main>
  <script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
}
