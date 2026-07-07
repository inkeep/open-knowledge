/**
 * CommandPalette unit tests — mirrors `ProjectSwitcher.test.ts`'s shape.
 *
 * Repo convention (see `EditorActivityPool.test.ts`) is no
 * @testing-library/react; full DOM + keyboard interaction is exercised by
 * Playwright. These tests assert the pure error-handling surface that
 * the shared `runWithToast` helper exposes (success / Error-rejection /
 * non-Error / empty-message / non-rethrow / internal-clear-regression-
 * guard), keeping the silent-error class of bug out of future diffs.
 *
 * DOM-level command visibility, routing, and overlay-prop contracts live in
 * `CommandPalette.dom.test.tsx`.
 */
import { describe, expect, mock, test } from 'bun:test';

describe('CommandPalette module', () => {
  test('Component module imports cleanly', async () => {
    const mod = await import('./CommandPalette');
    expect(typeof mod.CommandPalette).toBe('function');
    expect(typeof mod.runWithToast).toBe('function');
  });
});

describe('CommandPalette.runWithToast (IPC rejection → toast feedback)', () => {
  test('success: no toast.error fires', async () => {
    const { runWithToast } = await import('./CommandPalette');
    const toastApi = { error: mock(() => {}) };
    await runWithToast(() => Promise.resolve(), 'Command failed.', toastApi);
    expect(toastApi.error).not.toHaveBeenCalled();
  });

  test('Error rejection: toast.error fires with Error.message', async () => {
    const { runWithToast } = await import('./CommandPalette');
    const toastApi = { error: mock(() => {}) };
    await runWithToast(
      () => Promise.reject(new Error('utility failed to boot')),
      'Command failed.',
      toastApi,
    );
    expect(toastApi.error).toHaveBeenCalledWith('utility failed to boot');
  });

  test('non-Error rejection: toast.error fires with fallback', async () => {
    const { runWithToast } = await import('./CommandPalette');
    const toastApi = { error: mock(() => {}) };
    await runWithToast(() => Promise.reject('network dropped'), 'Command failed.', toastApi);
    expect(toastApi.error).toHaveBeenCalledWith('Command failed.');
  });

  test('empty-message Error: toast.error fires with fallback', async () => {
    const { runWithToast } = await import('./CommandPalette');
    const toastApi = { error: mock(() => {}) };
    await runWithToast(() => Promise.reject(new Error('')), 'Command failed.', toastApi);
    expect(toastApi.error).toHaveBeenCalledWith('Command failed.');
  });

  test('does not re-throw on rejection (runAction continues)', async () => {
    const { runWithToast } = await import('./CommandPalette');
    const toastApi = { error: mock(() => {}) };
    let afterAwait = false;
    await runWithToast(() => Promise.reject(new Error('x')), 'Command failed.', toastApi);
    afterAwait = true;
    expect(afterAwait).toBe(true);
  });

  test('success path fires NO toast even on the internal setError(null) clear', async () => {
    // Regression guard — the shared runWithErrorStatePure calls setError(null)
    // first to clear stale state; our adapter must filter the null rather
    // than passing it to toast.error(null).
    const { runWithToast } = await import('./CommandPalette');
    const toastApi = { error: mock(() => {}) };
    await runWithToast(() => Promise.resolve(), 'Command failed.', toastApi);
    expect(toastApi.error).not.toHaveBeenCalled();
  });

  test('falls back to module sonner toast when toastApi is omitted', async () => {
    // Smoke — calling runWithToast without the test double must not throw.
    const { runWithToast } = await import('./CommandPalette');
    await expect(runWithToast(() => Promise.resolve(), 'fallback')).resolves.toBeUndefined();
  });
});
