import { describe, expect, test, vi } from 'vitest';
import { resolveWithinRoot } from './path-safety.ts';

vi.mock('node:path', async (importOriginal) => {
  const path = await importOriginal<typeof import('node:path')>();
  return { ...path, ...path.win32 };
});

describe('resolveWithinRoot with Node win32 path operations', () => {
  test.each([
    { label: 'slash input', root: 'C:\\project', input: 'Setup/Results' },
    { label: 'backslash input', root: 'C:\\project', input: 'Setup\\Results' },
    { label: 'absolute input', root: 'C:\\project', input: 'C:\\project\\Setup\\Results' },
    { label: 'UNC root', root: '\\\\server\\share', input: 'Setup/Results' },
  ])('returns a slash content identifier for $label', ({ root, input }) => {
    expect(resolveWithinRoot(root, input)).toEqual({
      ok: true,
      abs: `${root}\\Setup\\Results`,
      rel: 'Setup/Results',
    });
  });

  test('keeps the project root identifier empty', () => {
    expect(resolveWithinRoot('C:\\project', '.')).toEqual({
      ok: true,
      abs: 'C:\\project',
      rel: '',
    });
  });

  test.each([
    { label: 'parent traversal', input: '..\\outside' },
    { label: 'different drive', input: 'D:\\outside' },
    { label: 'different UNC share', input: '\\\\server\\other\\outside' },
  ])('rejects $label', ({ input }) => {
    expect(resolveWithinRoot('C:\\project', input)).toMatchObject({ ok: false });
  });
});
