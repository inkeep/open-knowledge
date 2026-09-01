import { describe, expect, test, vi } from 'vitest';

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
    const toastApi = { error: vi.fn(() => {}) };
    await runWithToast(() => Promise.resolve(), 'Command failed.', toastApi);
    expect(toastApi.error).not.toHaveBeenCalled();
  });

  test('Error rejection: toast.error fires with Error.message', async () => {
    const { runWithToast } = await import('./CommandPalette');
    const toastApi = { error: vi.fn(() => {}) };
    await runWithToast(
      () => Promise.reject(new Error('utility failed to boot')),
      'Command failed.',
      toastApi,
    );
    expect(toastApi.error).toHaveBeenCalledWith('utility failed to boot');
  });

  test('non-Error rejection: toast.error fires with fallback', async () => {
    const { runWithToast } = await import('./CommandPalette');
    const toastApi = { error: vi.fn(() => {}) };
    await runWithToast(() => Promise.reject('network dropped'), 'Command failed.', toastApi);
    expect(toastApi.error).toHaveBeenCalledWith('Command failed.');
  });

  test('empty-message Error: toast.error fires with fallback', async () => {
    const { runWithToast } = await import('./CommandPalette');
    const toastApi = { error: vi.fn(() => {}) };
    await runWithToast(() => Promise.reject(new Error('')), 'Command failed.', toastApi);
    expect(toastApi.error).toHaveBeenCalledWith('Command failed.');
  });

  test('does not re-throw on rejection (runAction continues)', async () => {
    const { runWithToast } = await import('./CommandPalette');
    const toastApi = { error: vi.fn(() => {}) };
    let afterAwait = false;
    await runWithToast(() => Promise.reject(new Error('x')), 'Command failed.', toastApi);
    afterAwait = true;
    expect(afterAwait).toBe(true);
  });

  test('success path fires NO toast even on the internal setError(null) clear', async () => {
    const { runWithToast } = await import('./CommandPalette');
    const toastApi = { error: vi.fn(() => {}) };
    await runWithToast(() => Promise.resolve(), 'Command failed.', toastApi);
    expect(toastApi.error).not.toHaveBeenCalled();
  });

  test('falls back to module sonner toast when toastApi is omitted', async () => {
    const { runWithToast } = await import('./CommandPalette');
    await expect(runWithToast(() => Promise.resolve(), 'fallback')).resolves.toBeUndefined();
  });
});
