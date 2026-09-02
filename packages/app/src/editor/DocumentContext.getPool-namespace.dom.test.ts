import { fnv1aDigest } from '@inkeep/open-knowledge-core';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const WS_URL = 'ws://localhost:1/collab';

function setDesktopBridge(projectPath: string): void {
  window.okDesktop = {
    config: { projectPath },
    platform: 'darwin',
  } as unknown as Window['okDesktop'];
}

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  delete window.okDesktop;
  window.localStorage.clear();
});

describe('getPool storage-namespace wiring', () => {
  test('scopes keys to the Electron project reported by resolveSyncWorkspace', async () => {
    setDesktopBridge('/tmp/project-a');
    const { getPool } = await import('./DocumentContext');
    const pool = getPool(WS_URL);
    try {
      pool.setObservedBranch('main');
      expect(window.localStorage.getItem('ok-last-observed-branch')).toBeNull();
      expect(
        window.localStorage.getItem(`ok-last-observed-branch:${fnv1aDigest('/tmp/project-a')}`),
      ).toBe('main');
    } finally {
      pool.dispose();
    }
  });

  test('web host with no bridge keeps the bare key — the per-port origin isolates it', async () => {
    const { getPool } = await import('./DocumentContext');
    const pool = getPool(WS_URL);
    try {
      pool.setObservedBranch('main');
      expect(window.localStorage.getItem('ok-last-observed-branch')).toBe('main');
    } finally {
      pool.dispose();
    }
  });
});
