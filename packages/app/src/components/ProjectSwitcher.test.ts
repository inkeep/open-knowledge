/**
 * ProjectSwitcher unit tests — mirrors the pattern established in
 * `NavigatorApp.test.ts`: test the extracted pure helpers + the module's
 * bridge-contract consumption without mounting React. Repo convention (see
 * `EditorActivityPool.test.ts`) is no @testing-library/react; full DOM
 * interaction is exercised by Playwright.
 *
 * Coverage surface:
 *   - `runWithToast` success path (no toast fired, no error surfaced)
 *   - `runWithToast` rejection path (toast.error called with resolved message)
 *   - `runWithToast` non-Error rejection falls back to the provided fallback
 *   - setError(null) clear-at-start does NOT surface as a toast
 */
import { describe, expect, mock, test } from 'bun:test';

describe('ProjectSwitcher module', () => {
  test('Component module imports cleanly', async () => {
    const mod = await import('./ProjectSwitcher');
    expect(typeof mod.ProjectSwitcher).toBe('function');
    expect(typeof mod.runWithToast).toBe('function');
  });
});

describe('runWithToast (IPC rejection → toast feedback)', () => {
  test('success: no toast.error fires', async () => {
    const { runWithToast } = await import('./ProjectSwitcher');
    const toastApi = { error: mock(() => {}) };
    await runWithToast(() => Promise.resolve(), 'Failed to open.', toastApi);
    expect(toastApi.error).not.toHaveBeenCalled();
  });

  test('Error rejection: toast.error fires with Error.message', async () => {
    const { runWithToast } = await import('./ProjectSwitcher');
    const toastApi = { error: mock(() => {}) };
    await runWithToast(
      () => Promise.reject(new Error('utility failed to boot')),
      'Failed to open.',
      toastApi,
    );
    expect(toastApi.error).toHaveBeenCalledWith('utility failed to boot');
  });

  test('non-Error rejection: toast.error fires with fallback', async () => {
    const { runWithToast } = await import('./ProjectSwitcher');
    const toastApi = { error: mock(() => {}) };
    await runWithToast(() => Promise.reject('network dropped'), 'Failed to open.', toastApi);
    expect(toastApi.error).toHaveBeenCalledWith('Failed to open.');
  });

  test('empty-message Error: toast.error fires with fallback', async () => {
    const { runWithToast } = await import('./ProjectSwitcher');
    const toastApi = { error: mock(() => {}) };
    await runWithToast(() => Promise.reject(new Error('')), 'Failed to open.', toastApi);
    expect(toastApi.error).toHaveBeenCalledWith('Failed to open.');
  });

  test('does not re-throw on rejection (caller awaits without try/catch)', async () => {
    const { runWithToast } = await import('./ProjectSwitcher');
    const toastApi = { error: mock(() => {}) };
    let afterAwait = false;
    await runWithToast(() => Promise.reject(new Error('x')), 'Failed to open.', toastApi);
    afterAwait = true;
    expect(afterAwait).toBe(true);
  });

  test('success path fires NO toast even on the internal setError(null) clear', async () => {
    // Regression guard — runWithErrorStatePure calls setError(null) first to
    // clear stale state; our adapter must filter the null out rather than
    // passing it to toast.error(null).
    const { runWithToast } = await import('./ProjectSwitcher');
    const toastApi = { error: mock(() => {}) };
    await runWithToast(() => Promise.resolve(), 'Failed to open.', toastApi);
    expect(toastApi.error).not.toHaveBeenCalled();
  });

  test('falls back to module sonner toast when toastApi is omitted', async () => {
    // Smoke — calling runWithToast without the test double must not throw.
    // The default branch uses `toast` from the `sonner` module; we rely on
    // sonner's no-op-when-no-Toaster-mounted behavior in bun test.
    const { runWithToast } = await import('./ProjectSwitcher');
    await expect(runWithToast(() => Promise.resolve(), 'fallback')).resolves.toBeUndefined();
  });
});
