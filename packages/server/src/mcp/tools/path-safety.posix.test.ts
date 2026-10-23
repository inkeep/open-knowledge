import { describe, expect, test, vi } from 'vitest';
import { resolveWithinRoot } from './path-safety.ts';

vi.mock('node:path', async (importOriginal) => {
  const path = await importOriginal<typeof import('node:path')>();
  return { ...path, ...path.posix };
});

describe('resolveWithinRoot with Node posix path operations', () => {
  test('preserves a literal backslash in the native target and logical identifier', () => {
    expect(resolveWithinRoot('/project', 'Setup\\Results')).toEqual({
      ok: true,
      abs: '/project/Setup\\Results',
      rel: 'Setup\\Results',
    });
  });
});
