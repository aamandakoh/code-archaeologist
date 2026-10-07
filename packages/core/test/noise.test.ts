import { describe, expect, test } from 'vitest';
import { classifyNoise, type Hunk } from '../src/index.js';

function hunk(before: string[], after: string[], context: string[] = []): Hunk[] {
  return [
    {
      oldStart: 1,
      oldCount: before.length + context.length,
      newStart: 1,
      newCount: after.length + context.length,
      lines: [
        ...context.map((text) => ({ kind: 'context' as const, text })),
        ...before.map((text) => ({ kind: 'removed' as const, text })),
        ...after.map((text) => ({ kind: 'added' as const, text })),
      ],
    },
  ];
}

describe('classifyNoise', () => {
  test('re-indentation and line wrapping are whitespace', () => {
    expect(classifyNoise(hunk(['  if (a && b) return x;'], ['  if (a &&', '      b) return x;']))).toBe('whitespace');
  });

  test('quote style, semicolons and trailing commas are formatting', () => {
    expect(classifyNoise(hunk(['foo("a", [1, 2,])'], ["foo('a', [1, 2]);"]))).toBe('formatting');
    expect(classifyNoise(hunk(['xs.map((x) => x)'], ['xs.map(x => x)']))).toBe('formatting');
  });

  test('switching to a template literal is a real change', () => {
    expect(classifyNoise(hunk(["log('${x}')"], ['log(`${x}`)']))).toBeUndefined();
  });

  test('license header edits are noise', () => {
    expect(
      classifyNoise(hunk([' * Copyright Google Inc. All Rights Reserved.'], [' * Copyright Google LLC All Rights Reserved.'])),
    ).toBe('license-header');
  });

  test('other comment edits are not license noise', () => {
    expect(classifyNoise(hunk(['// see https://old'], ['// see https://new']))).toBeUndefined();
  });

  test('code changes are real', () => {
    expect(classifyNoise(hunk(['const a = 1;'], ['const a = 2;']))).toBeUndefined();
  });
});
