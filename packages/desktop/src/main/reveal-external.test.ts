import { describe, expect, test, vi } from 'vitest';
import { handleRevealExternal, type RevealExternalDeps } from './reveal-external.ts';

function makeDeps(overrides: Partial<RevealExternalDeps> = {}) {
  const showItemInFolder = vi.fn((_p: string) => {});
  const confirmReveal = vi.fn(async (_p: string) => true);
  const deps: RevealExternalDeps = {
    probe: () => 'exists',
    confirmReveal,
    showItemInFolder,
    ...overrides,
  };
  return { deps, showItemInFolder, confirmReveal };
}

describe('handleRevealExternal', () => {
  test('rejects a non-absolute or malformed path before touching disk', async () => {
    const { deps, showItemInFolder, confirmReveal } = makeDeps();
    expect(await handleRevealExternal('relative/x.md', deps)).toEqual({
      ok: false,
      reason: 'invalid-path',
    });
    expect(await handleRevealExternal('', deps)).toEqual({ ok: false, reason: 'invalid-path' });
    expect(await handleRevealExternal('/a\0b', deps)).toEqual({
      ok: false,
      reason: 'invalid-path',
    });
    // Other C0 controls (newline/CR/tab) are rejected too — they'd inject extra
    // lines into the confirmation dialog's interpolated path.
    expect(await handleRevealExternal('/a\nb', deps)).toEqual({
      ok: false,
      reason: 'invalid-path',
    });
    expect(await handleRevealExternal('/a\tb', deps)).toEqual({
      ok: false,
      reason: 'invalid-path',
    });
    expect(await handleRevealExternal(42, deps)).toEqual({ ok: false, reason: 'invalid-path' });
    expect(confirmReveal).not.toHaveBeenCalled();
    expect(showItemInFolder).not.toHaveBeenCalled();
  });

  test('reports not-found for a missing path and shows no dialog', async () => {
    const { deps, showItemInFolder, confirmReveal } = makeDeps({ probe: () => 'missing' });
    expect(await handleRevealExternal('/tmp/gone.pdf', deps)).toEqual({
      ok: false,
      reason: 'not-found',
    });
    expect(confirmReveal).not.toHaveBeenCalled();
    expect(showItemInFolder).not.toHaveBeenCalled();
  });

  test('maps an unreadable probe to error', async () => {
    const { deps } = makeDeps({ probe: () => 'unreadable' });
    expect(await handleRevealExternal('/root/secret', deps)).toEqual({
      ok: false,
      reason: 'error',
    });
  });

  test('reveals on confirm', async () => {
    const { deps, showItemInFolder } = makeDeps({ confirmReveal: async () => true });
    expect(await handleRevealExternal('/tmp/out/report.pdf', deps)).toEqual({
      ok: true,
      outcome: 'revealed',
    });
    expect(showItemInFolder).toHaveBeenCalledWith('/tmp/out/report.pdf');
  });

  test('does not reveal when the user dismisses the dialog', async () => {
    const { deps, showItemInFolder } = makeDeps({ confirmReveal: async () => false });
    expect(await handleRevealExternal('/tmp/out/report.pdf', deps)).toEqual({
      ok: true,
      outcome: 'dismissed',
    });
    expect(showItemInFolder).not.toHaveBeenCalled();
  });
});
