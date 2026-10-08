// Deep import of the types only, so the webview build never pulls in Node code.
import type { Timeline } from '@code-archaeologist/core/src/types.js';

/** Where the AI story is for the timeline on screen. The story itself is `timeline.story`. */
export type AiState =
  | { status: 'reading'; message: string }
  | { status: 'writing' }
  | { status: 'ready' }
  | { status: 'no-key' }
  | { status: 'error'; message: string };

/** Extension → webview. The webview never calls git, GitHub, GitLab or the model itself. */
export type ToWebview =
  | { type: 'loading'; file: string; range: [number, number]; message: string }
  | { type: 'progress'; message: string }
  /** Sent again with the same timeline when the story arrives or fails. */
  | { type: 'timeline'; timeline: Timeline; ai: AiState }
  | { type: 'error'; message: string };

/** Webview → extension. */
export type FromWebview =
  | { type: 'ready' }
  | { type: 'set-key' }
  | { type: 'set-github-token' }
  | { type: 'set-gitlab-token' }
  | { type: 'open-settings' }
  | { type: 'retry-story' };
