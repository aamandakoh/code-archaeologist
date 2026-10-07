import type { NoiseReason } from './types.js';
import { preImage, postImage, type Hunk } from './lineLog.js';

/**
 * Decides whether a commit only touched whitespace, formatting or license headers in
 * the traced lines. Returns undefined for a real change.
 */
export function classifyNoise(hunks: Hunk[]): NoiseReason | undefined {
  const changed = hunks.flatMap((h) => h.lines.filter((l) => l.kind !== 'context'));
  if (changed.length === 0) return undefined;

  const before = preImage(hunks).join('\n');
  const after = postImage(hunks).lines.join('\n');

  if (stripWhitespace(before) === stripWhitespace(after)) return 'whitespace';
  if (normalizeFormatting(before) === normalizeFormatting(after)) return 'formatting';
  if (changed.every((l) => isCommentLine(l.text)) && changed.some((l) => LICENSE.test(l.text))) {
    return 'license-header';
  }
  return undefined;
}

const LICENSE = /\b(license|licence|copyright|spdx-license-identifier)\b/i;

function stripWhitespace(text: string): string {
  return text.replace(/\s+/g, '');
}

/** What a formatter like Prettier may change without changing behaviour. */
function normalizeFormatting(text: string): string {
  return stripWhitespace(text)
    .replace(/"/g, "'")
    .replace(/,(?=[)\]}>])/g, '') // trailing commas
    .replace(/;/g, '')
    .replace(/\(([A-Za-z_$][\w$]*)\)=>/g, '$1=>'); // (x) => vs x =>
}

function isCommentLine(text: string): boolean {
  const t = text.trim();
  return t === '' || t.startsWith('//') || t.startsWith('/*') || t.startsWith('*') || t.startsWith('#');
}
