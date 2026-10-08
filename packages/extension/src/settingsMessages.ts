/** What the settings form edits. Empty strings mean the default. */
export type SettingsValues = { provider: 'gemini' | 'openai'; baseUrl: string; model: string; gitlabUrl: string };

export type SecretName = 'apiKey' | 'githubToken' | 'gitlabToken';

/** Where each key or token comes from now. The values themselves never reach the page. */
export type SecretState = Record<SecretName, 'saved' | 'env' | 'none'>;

/** Extension → settings page. */
export type ToSettings =
  | { type: 'state'; values: SettingsValues; secrets: SecretState }
  | { type: 'saved' }
  | { type: 'test-result'; ok: boolean; message: string };

/**
 * Settings page → extension. In `secrets`, a string replaces the stored value and null removes
 * it; a name left out stays as it is.
 */
export type FromSettings =
  | { type: 'ready' }
  | { type: 'save'; values: SettingsValues; secrets: Partial<Record<SecretName, string | null>> }
  | { type: 'test'; values: SettingsValues; apiKey?: string };
