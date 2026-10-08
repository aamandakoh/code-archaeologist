/** What the settings form edits. Empty strings mean the default. */
export type SettingsValues = {
  provider: 'gemini' | 'openai';
  baseUrl: string;
  model: string;
  gitlabUrl: string;
  jiraUrl: string;
  /** Jira Cloud only: the Atlassian account email that goes with the API token. */
  jiraEmail: string;
  /** Comma-separated project keys to match, e.g. "PAY, CORE". Empty matches any key. */
  jiraProjects: string;
};

/** `llmHeaders` is extra headers for LLM requests, "Name: value" per line: they may carry auth, so they are kept as a secret. */
export type SecretName = 'apiKey' | 'githubToken' | 'gitlabToken' | 'jiraToken' | 'llmHeaders';

/** Where each key or token comes from now. The values themselves never reach the page. */
export type SecretState = Record<SecretName, 'saved' | 'env' | 'none'>;

/** Extension → settings page. */
export type ToSettings =
  /** `headerNames` are the names of the saved LLM headers, never their values. */
  | { type: 'state'; values: SettingsValues; secrets: SecretState; headerNames: string[] }
  | { type: 'saved' }
  /** `target` says which Test connection button this answers. */
  | { type: 'test-result'; target: 'llm' | 'jira'; ok: boolean; message: string };

/**
 * Settings page → extension. In `secrets`, a string replaces the stored value and null removes
 * it; a name left out stays as it is.
 */
export type FromSettings =
  | { type: 'ready' }
  | { type: 'save'; values: SettingsValues; secrets: Partial<Record<SecretName, string | null>> }
  | { type: 'test'; values: SettingsValues; apiKey?: string; headers?: string }
  /** Checks the Jira URL and credentials, with a typed token when there is one. */
  | { type: 'test-jira'; values: SettingsValues; token?: string };
