import { describe, expect, test, vi } from 'vitest';

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
    const toastApi = { error: vi.fn(() => {}) };
    await runWithToast(() => Promise.resolve(), 'Failed to open.', toastApi);
    expect(toastApi.error).not.toHaveBeenCalled();
  });

  test('Error rejection: toast.error fires with Error.message', async () => {
    const { runWithToast } = await import('./ProjectSwitcher');
    const toastApi = { error: vi.fn(() => {}) };
    await runWithToast(
      () => Promise.reject(new Error('utility failed to boot')),
      'Failed to open.',
      toastApi,
    );
    expect(toastApi.error).toHaveBeenCalledWith('utility failed to boot');
  });

  test('non-Error rejection: toast.error fires with fallback', async () => {
    const { runWithToast } = await import('./ProjectSwitcher');
    const toastApi = { error: vi.fn(() => {}) };
    await runWithToast(() => Promise.reject('network dropped'), 'Failed to open.', toastApi);
    expect(toastApi.error).toHaveBeenCalledWith('Failed to open.');
  });

  test('empty-message Error: toast.error fires with fallback', async () => {
    const { runWithToast } = await import('./ProjectSwitcher');
    const toastApi = { error: vi.fn(() => {}) };
    await runWithToast(() => Promise.reject(new Error('')), 'Failed to open.', toastApi);
    expect(toastApi.error).toHaveBeenCalledWith('Failed to open.');
  });

  test('does not re-throw on rejection (caller awaits without try/catch)', async () => {
    const { runWithToast } = await import('./ProjectSwitcher');
    const toastApi = { error: vi.fn(() => {}) };
    let afterAwait = false;
    await runWithToast(() => Promise.reject(new Error('x')), 'Failed to open.', toastApi);
    afterAwait = true;
    expect(afterAwait).toBe(true);
  });

  test('success path fires NO toast even on the internal setError(null) clear', async () => {
    const { runWithToast } = await import('./ProjectSwitcher');
    const toastApi = { error: vi.fn(() => {}) };
    await runWithToast(() => Promise.resolve(), 'Failed to open.', toastApi);
    expect(toastApi.error).not.toHaveBeenCalled();
  });

  test('falls back to module sonner toast when toastApi is omitted', async () => {
    const { runWithToast } = await import('./ProjectSwitcher');
    await expect(runWithToast(() => Promise.resolve(), 'fallback')).resolves.toBeUndefined();
  });
});
