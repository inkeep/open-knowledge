
import { describe, expect, test } from 'bun:test';

describe('useInstalledAgents module surface', () => {
  test('exports the hook + classifier + deps factory', async () => {
    const mod = await import('./useInstalledAgents');
    expect(typeof mod.useInstalledAgents).toBe('function');
    expect(typeof mod.isElectronHostDefault).toBe('function');
    expect(typeof mod.defaultProbeDeps).toBe('function');
  });
});

describe('isElectronHostDefault — pure host classifier', () => {
  test('returns false when windowLike is undefined (SSR / non-browser)', async () => {
    const { isElectronHostDefault } = await import('./useInstalledAgents');
    expect(isElectronHostDefault(undefined)).toBe(false);
  });

  test('returns false when okDesktop is absent (web / CLI distribution)', async () => {
    const { isElectronHostDefault } = await import('./useInstalledAgents');
    expect(isElectronHostDefault({})).toBe(false);
  });

  test('returns false when okDesktop is explicitly undefined', async () => {
    const { isElectronHostDefault } = await import('./useInstalledAgents');
    expect(isElectronHostDefault({ okDesktop: undefined })).toBe(false);
  });

  test('returns true when okDesktop is any non-nullish object (Electron preload populated)', async () => {
    const { isElectronHostDefault } = await import('./useInstalledAgents');
    expect(isElectronHostDefault({ okDesktop: { shell: {} } })).toBe(true);
  });
});
