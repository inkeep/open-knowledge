// The seam between `provider-pool.test.ts` (which verifies the key-scoping
// MECHANISM, but hands `storageNamespace` in by hand) and production. This
// file pins the one line that supplies it for real: a regression there —
// `.contentDir` swapped for a sibling field, the `storageNamespace` option
// dropped from the call, a fresh-per-launch fallback reintroduced — is
// type-clean and silent, so it ships with a fully green suite and
// reproduces the wedge the scoping exists to prevent.
//
// Lives in its own file on purpose. `pool` is a module-level singleton, so
// whichever test constructs it first freezes it for the rest of the file;
// `vi.resetModules()` plus a dynamic import gives each case a fresh one.
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
