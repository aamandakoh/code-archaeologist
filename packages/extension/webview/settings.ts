import type { FromSettings, SecretName, SecretState, SettingsValues, ToSettings } from '../src/settingsMessages';

declare function acquireVsCodeApi(): { postMessage(message: FromSettings): void };

const vscode = acquireVsCodeApi();
const app = document.getElementById('app')!;

const DEFAULT_URL = { gemini: 'https://generativelanguage.googleapis.com/v1beta', openai: 'https://api.openai.com/v1' };

/** One click fills the format and URL; the model stays the reader's choice. */
const PRESETS: { label: string; provider: SettingsValues['provider']; baseUrl: string; hint: string }[] = [
  { label: 'Gemini', provider: 'gemini', baseUrl: '', hint: 'Key from aistudio.google.com/apikey. Model defaults to gemini-3.5-flash.' },
  { label: 'OpenAI', provider: 'openai', baseUrl: '', hint: 'Key from platform.openai.com. Enter a model id.' },
  { label: 'OpenRouter', provider: 'openai', baseUrl: 'https://openrouter.ai/api/v1', hint: 'Key from openrouter.ai. Model ids look like vendor/model.' },
  { label: 'Ollama (local)', provider: 'openai', baseUrl: 'http://localhost:11434/v1', hint: 'No key needed. Enter a model you have pulled.' },
  { label: 'LM Studio (local)', provider: 'openai', baseUrl: 'http://localhost:1234/v1', hint: 'No key needed. Enter the model loaded in LM Studio.' },
];

let values: SettingsValues | undefined;
let secrets: SecretState | undefined;
/** Typed keys and tokens, and the ones marked for removal, until Save. */
const typed: Partial<Record<SecretName, string | null>> = {};

window.addEventListener('message', (event: MessageEvent<ToSettings>) => {
  const message = event.data;
  if (message.type === 'state') {
    values = message.values;
    secrets = message.secrets;
    render();
  } else if (message.type === 'saved') {
    for (const name of Object.keys(typed) as SecretName[]) delete typed[name];
    render();
    flash('Saved.');
  } else {
    const result = document.getElementById('test-result')!;
    result.className = message.ok ? 'result ok' : 'result failed';
    result.textContent = message.message;
    (document.getElementById('test') as HTMLButtonElement).disabled = false;
  }
});
vscode.postMessage({ type: 'ready' });

function render(): void {
  if (!values || !secrets) return;
  const v = values;
  const provider = select(
    'provider',
    [
      ['gemini', 'Gemini API'],
      ['openai', 'OpenAI-compatible (OpenAI, OpenRouter, Ollama, LM Studio, vLLM…)'],
    ],
    v.provider,
    (value) => {
      v.provider = value as SettingsValues['provider'];
      render();
    },
  );
  const presets = el(
    'div',
    { class: 'presets' },
    ...PRESETS.map((p) => {
      const on = p.provider === v.provider && p.baseUrl === v.baseUrl.replace(/\/+$/, '');
      const b = el('button', { class: on ? 'preset on' : 'preset', text: p.label, attrs: { type: 'button', title: p.hint } });
      b.addEventListener('click', () => {
        v.provider = p.provider;
        v.baseUrl = p.baseUrl;
        render();
        document.getElementById('preset-hint')!.textContent = p.hint;
        if (p.provider === 'openai' && !v.model) document.getElementById('model')?.focus();
      });
      return b;
    }),
  );

  app.replaceChildren(
    el('h1', { text: 'Code Archaeologist settings' }),
    el('p', { class: 'muted', text: 'Saved to your VS Code user settings. Keys and tokens go to VS Code secret storage.' }),

    el(
      'section',
      {},
      el('h2', { text: 'AI model' }),
      el('p', { class: 'muted', text: 'Writes the summary, the note on each commit and the risk verdict.' }),
      field('Quick setup', presets, el('p', { class: 'hint', attrs: { id: 'preset-hint' } })),
      field('API format', provider),
      field(
        'API URL',
        input('baseUrl', v.baseUrl, DEFAULT_URL[v.provider], (value) => (v.baseUrl = value)),
        hint('Up to the version path. Leave empty for the default shown.'),
      ),
      field(
        'Model',
        input('model', v.model, v.provider === 'gemini' ? 'gemini-3.5-flash' : 'Required: a model id from your API', (value) => (v.model = value)),
      ),
      secretField('apiKey', 'API key', v.provider === 'openai' ? 'OPENAI_API_KEY' : 'GEMINI_API_KEY', v.provider === 'openai' && v.baseUrl ? 'Optional for a server on your own machine.' : undefined),
      el(
        'div',
        { class: 'row' },
        button('Test connection', 'secondary', () => {
          const result = document.getElementById('test-result')!;
          result.className = 'result';
          result.textContent = 'Asking the model…';
          (document.getElementById('test') as HTMLButtonElement).disabled = true;
          vscode.postMessage({ type: 'test', values: v, ...(typed.apiKey && { apiKey: typed.apiKey }) });
        }, 'test'),
        el('span', { class: 'result', attrs: { id: 'test-result', role: 'status' } }),
      ),
    ),

    el(
      'section',
      {},
      el('h2', { text: 'GitHub' }),
      el('p', { class: 'muted', text: 'Pull requests, review comments and issues. Works without a token for about one trace an hour.' }),
      secretField('githubToken', 'Token', 'GITHUB_TOKEN', 'A fine-grained token with read-only access is enough.'),
    ),

    el(
      'section',
      {},
      el('h2', { text: 'GitLab' }),
      el('p', { class: 'muted', text: 'Merge requests, comments and issues, for repositories whose origin is on GitLab.' }),
      field(
        'GitLab URL',
        input('gitlabUrl', v.gitlabUrl, 'https://git.example.com', (value) => (v.gitlabUrl = value)),
        hint('Only for a self-hosted GitLab without "gitlab" in its address. gitlab.com and gitlab.* are found on their own.'),
      ),
      secretField('gitlabToken', 'Token', 'GITLAB_TOKEN', 'A personal access token with the read_api scope. Needed for private projects and for comments.'),
    ),

    el(
      'footer',
      {},
      button('Save', 'primary', () => vscode.postMessage({ type: 'save', values: v, secrets: { ...typed } })),
      el('span', { class: 'result', attrs: { id: 'saved', role: 'status' } }),
    ),
  );
}

/** A password field showing where the current value comes from, with a way to remove a saved one. */
function secretField(name: SecretName, label: string, env: string, note?: string): HTMLElement {
  const state = typed[name] === null ? 'removed' : secrets![name];
  const placeholder =
    state === 'saved' ? 'Saved. Type to replace it.' : state === 'env' ? `Using ${env}. Type to override it.` : state === 'removed' ? 'Removed on save.' : 'Not set';
  const box = input(name, typeof typed[name] === 'string' ? typed[name]! : '', placeholder, (value) => (typed[name] = value || undefined), 'password');
  const remove =
    state === 'saved' &&
    button('Remove', 'link', () => {
      typed[name] = null;
      render();
    });
  return field(label, el('div', { class: 'row' }, box, remove || ''), note ? hint(note) : undefined);
}

function field(label: string, control: HTMLElement, ...extra: (HTMLElement | undefined)[]): HTMLElement {
  const id = control.id || control.querySelector('[id]')?.id;
  return el('div', { class: 'field' }, el('label', { text: label, attrs: id ? { for: id } : {} }), control, ...extra.filter((x): x is HTMLElement => Boolean(x)));
}

function input(id: string, value: string, placeholder: string, onInput: (value: string) => void, type = 'text'): HTMLInputElement {
  const box = el('input', { attrs: { id, type, placeholder, spellcheck: 'false', autocomplete: 'off' } });
  box.value = value;
  box.addEventListener('input', () => onInput(box.value));
  return box;
}

function select(id: string, options: [string, string][], value: string, onChange: (value: string) => void): HTMLSelectElement {
  const box = el('select', { attrs: { id } }, ...options.map(([v, label]) => el('option', { text: label, attrs: v === value ? { value: v, selected: '' } : { value: v } })));
  box.addEventListener('change', () => onChange(box.value));
  return box;
}

function button(text: string, kind: 'primary' | 'secondary' | 'link', onClick: () => void, id?: string): HTMLButtonElement {
  const b = el('button', { class: kind, text, attrs: { type: 'button', ...(id && { id }) } });
  b.addEventListener('click', onClick);
  return b;
}

function hint(text: string): HTMLElement {
  return el('p', { class: 'hint', text });
}

function flash(text: string): void {
  const saved = document.getElementById('saved');
  if (saved) saved.textContent = text;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: { class?: string; text?: string; attrs?: Record<string, string> } = {},
  ...children: (Node | string | undefined | false)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (props.class) node.className = props.class;
  if (props.text !== undefined) node.textContent = props.text;
  for (const [key, value] of Object.entries(props.attrs ?? {})) node.setAttribute(key, value);
  for (const child of children) if (child) node.append(child);
  return node;
}
