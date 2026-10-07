// Deep import of the types only, so the webview build never pulls in Node code.
import type { Timeline } from '@code-archaeologist/core/src/types.js';

/** Extension → webview. The webview never calls git, GitHub or the model itself. */
export type ToWebview =
  | { type: 'loading'; file: string; range: [number, number]; message: string }
  | { type: 'progress'; message: string }
  | { type: 'timeline'; timeline: Timeline }
  | { type: 'error'; message: string };

/** Webview → extension. */
export type FromWebview = { type: 'ready' };
