import { describe, expect, test } from 'vitest';
import { resolveSyncWorkspace } from './use-workspace';

describe('resolveSyncWorkspace', () => {
  test('no window (SSR): returns null', () => {
    expect(resolveSyncWorkspace(undefined)).toBeNull();
  });

  test('no okDesktop bridge: returns null', () => {
    const windowLike = {} as Window;
    expect(resolveSyncWorkspace(windowLike)).toBeNull();
  });

  test('Electron macOS: forward-slash separator + projectPath pass-through', () => {
    const windowLike = {
      okDesktop: {
        config: { projectPath: '/Users/andrew/repo' },
        platform: 'darwin',
      },
    } as unknown as Window;
    expect(resolveSyncWorkspace(windowLike)).toEqual({
      contentDir: '/Users/andrew/repo',
      pathSeparator: '/',
    });
  });

  test('Electron Windows: backslash separator', () => {
    const windowLike = {
      okDesktop: {
        config: { projectPath: 'C:\\repo' },
        platform: 'win32',
      },
    } as unknown as Window;
    expect(resolveSyncWorkspace(windowLike)).toEqual({
      contentDir: 'C:\\repo',
      pathSeparator: '\\',
    });
  });

  test('Electron Linux: forward-slash separator', () => {
    const windowLike = {
      okDesktop: {
        config: { projectPath: '/home/u/repo' },
        platform: 'linux',
      },
    } as unknown as Window;
    expect(resolveSyncWorkspace(windowLike)).toEqual({
      contentDir: '/home/u/repo',
      pathSeparator: '/',
    });
  });
});

describe('useWorkspace module surface', () => {
  test('exports resolveSyncWorkspace', async () => {
    const mod = await import('./use-workspace');
    expect(typeof mod.resolveSyncWorkspace).toBe('function');
    expect(typeof mod.useWorkspace).toBe('function');
  });
});
