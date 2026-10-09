import type { FromSettings, SecretName, SecretState, SettingsValues, ToSettings } from '../src/settingsMessages';

declare function acquireVsCodeApi(): { postMessage(message: FromSettings): void };

const vscode = acquireVsCodeApi();
const app = document.getElementById('app')!;

const DEFAULT_URL = { gemini: 'https://generativelanguage.googleapis.com/v1beta', openai: 'https://api.openai.com/v1' };

/** One click fills the format and URL, and the model where a preset names one; otherwise the model stays the reader's choice. */
const PRESETS: { label: string; provider: SettingsValues['provider']; baseUrl: string; model?: string; hint: string }[] = [
  { label: 'Gemini', provider: 'gemini', baseUrl: '', hint: 'Key from aistudio.google.com/apikey. Model defaults to gemini-3.5-flash.' },
  {
    label: 'Gemini Flash-Lite (free)',
    provider: 'gemini',
    baseUrl: '',
    model: 'gemini-3.1-flash-lite',
    hint: 'Same Gemini key. Each Gemini model has its own free daily quota, and Flash-Lite has the largest.',
  },
  {
    label: 'Mistral (free plan)',
    provider: 'openai',
    baseUrl: 'https://api.mistral.ai/v1',
    model: 'mistral-small-latest',
    hint: 'Key from console.mistral.ai on the free Experiment plan: a verified phone number, no card. Requests on that plan may be used for training.',
  },
  { label: 'OpenAI', provider: 'openai', baseUrl: '', hint: 'Key from platform.openai.com. Enter a model id.' },
  { label: 'OpenRouter', provider: 'openai', baseUrl: 'https://openrouter.ai/api/v1', hint: 'Key from openrouter.ai. Model ids look like vendor/model; ids ending in :free cost nothing, about 50 requests a day.' },
  { label: 'Ollama (local)', provider: 'openai', baseUrl: 'http://localhost:11434/v1', hint: 'No key needed. Enter a model you have pulled.' },
  { label: 'LM Studio (local)', provider: 'openai', baseUrl: 'http://localhost:1234/v1', hint: 'No key needed. Enter the model loaded in LM Studio.' },
];

/** The preset the form matches: same format and URL, and the preset's model if it names one. */
function activePreset(v: SettingsValues): (typeof PRESETS)[number] | undefined {
  const same = PRESETS.filter((p) => p.provider === v.provider && p.baseUrl === v.baseUrl.trim().replace(/\/+$/, ''));
  return same.find((p) => p.model && p.model === v.model.trim()) ?? same.find((p) => !p.model);
}

let values: SettingsValues | undefined;
let secrets: SecretState | undefined;
let headerNames: string[] = [];
/** Typed keys and tokens, and the ones marked for removal, until Save. */
const typed: Partial<Record<SecretName, string | null>> = {};

window.addEventListener('message', (event: MessageEvent<ToSettings>) => {
  const message = event.data;
  if (message.type === 'state') {
    values = message.values;
    secrets = message.secrets;
    headerNames = message.headerNames;
    render();
  } else if (message.type === 'saved') {
    for (const name of Object.keys(typed) as SecretName[]) delete typed[name];
    render();
    flash('Saved.');
  } else {
    const id = message.target === 'jira' ? 'test-jira' : 'test';
    const result = document.getElementById(`${id}-result`)!;
    result.className = message.ok ? 'result ok' : 'result failed';
    result.textContent = message.message;
    (document.getElementById(id) as HTMLButtonElement).disabled = false;
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
      const on = p === activePreset(v);
      const b = el('button', { class: on ? 'preset on' : 'preset', text: p.label, attrs: { type: 'button', title: p.hint } });
      b.addEventListener('click', () => {
        v.provider = p.provider;
        v.baseUrl = p.baseUrl;
        // Leaving a preset that set the model clears it, so a Mistral id isn't sent to Gemini.
        if (p.model) v.model = p.model;
        else if (PRESETS.some((q) => q.model === v.model.trim())) v.model = '';
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
      el('p', { class: 'muted', text: 'Writes the summary, the note on each commit and the warning flags.' }),
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
      headersField(),
      el(
        'div',
        { class: 'row' },
        button('Test connection', 'secondary', () => {
          const result = document.getElementById('test-result')!;
          result.className = 'result';
          result.textContent = 'Asking the model…';
          (document.getElementById('test') as HTMLButtonElement).disabled = true;
          vscode.postMessage({
            type: 'test',
            values: v,
            ...(typed.apiKey && { apiKey: typed.apiKey }),
            ...(typed.llmHeaders !== undefined && { headers: typed.llmHeaders ?? '' }),
          });
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
        hint('Your self-hosted GitLab. The token is only sent to gitlab.com and this address, so set it for any other GitLab.'),
      ),
      secretField('gitlabToken', 'Token', 'GITLAB_TOKEN', 'On GitLab, open Personal access tokens, click Generate legacy token and tick read_api. Needed for private projects and for comments.'),
    ),

    el(
      'section',
      {},
      el('h2', { text: 'Jira' }),
      el('p', { class: 'muted', text: 'Tickets named in commits and merge requests, like PAY-412. Their summary, status, description and comments become evidence for the notes and the verdict.' }),
      field('Jira URL', input('jiraUrl', v.jiraUrl, 'https://yourcompany.atlassian.net', (value) => (v.jiraUrl = value)), hint('Credentials are only ever sent to this address.')),
      field('Email', input('jiraEmail', v.jiraEmail, 'you@company.com', (value) => (v.jiraEmail = value)), hint('Jira Cloud only. Leave empty for Jira Data Center or Server.')),
      secretField('jiraToken', 'API token', 'JIRA_TOKEN', 'Jira Cloud: an API token from id.atlassian.com/manage-profile/security/api-tokens. Data Center or Server: a personal access token.'),
      field('Project keys', input('jiraProjects', v.jiraProjects, 'PAY, CORE (optional)', (value) => (v.jiraProjects = value)), hint('Only match these keys. Leave empty to match any ABC-123 pattern.')),
      field(
        'Ignore comments from',
        input('jiraIgnore', v.jiraIgnore, 'gitlab-bot, Jenkins (optional)', (value) => (v.jiraIgnore = value)),
        hint('Display names, usernames or emails, comma-separated. "Mentioned this issue in a commit" notices are always left out.'),
      ),
      el(
        'div',
        { class: 'row' },
        button('Test connection', 'secondary', () => {
          const result = document.getElementById('test-jira-result')!;
          result.className = 'result';
          result.textContent = 'Asking Jira…';
          (document.getElementById('test-jira') as HTMLButtonElement).disabled = true;
          vscode.postMessage({ type: 'test-jira', values: v, ...(typed.jiraToken && { token: typed.jiraToken }) });
        }, 'test-jira'),
        el('span', { class: 'result', attrs: { id: 'test-jira-result', role: 'status' } }),
      ),
    ),

    el(
      'footer',
      {},
      button('Save', 'primary', () => vscode.postMessage({ type: 'save', values: v, secrets: { ...typed } })),
      el('span', { class: 'result', attrs: { id: 'saved', role: 'status' } }),
    ),
  );
}

/**
 * Extra headers for every LLM request, one "Name: value" per line. Saved as a secret since they may
 * carry auth, so only the saved names are shown; typing replaces them all.
 */
function headersField(): HTMLElement {
  const state = typed.llmHeaders === null ? 'removed' : secrets!.llmHeaders;
  const placeholder =
    state === 'saved'
      ? `Saved: ${headerNames.join(', ')}. Type to replace them all.`
      : state === 'removed'
        ? 'Removed on save.'
        : 'X-Org-Id: 1234\nHelicone-Auth: Bearer sk-…';
  const box = el('textarea', { attrs: { id: 'llmHeaders', rows: '3', placeholder, spellcheck: 'false', autocomplete: 'off' } });
  box.value = typeof typed.llmHeaders === 'string' ? typed.llmHeaders : '';
  const problem = hint('');
  const check = () => {
    const bad = box.value
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#') && !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+\s*:/.test(l));
    problem.className = bad.length ? 'hint bad' : 'hint';
    problem.textContent = bad.length
      ? `Not a header, will be skipped: ${bad.join(' · ')}`
      : 'One per line, as Name: value. Sent with every request to the model, after the key, so they can replace its auth header. Kept in secret storage.';
  };
  box.addEventListener('input', () => {
    typed.llmHeaders = box.value.trim() ? box.value : undefined;
    check();
  });
  check();
  const remove =
    state === 'saved' &&
    button('Remove', 'link', () => {
      typed.llmHeaders = null;
      render();
    });
  return field('Extra request headers', el('div', { class: 'row' }, box, remove || ''), problem);
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
