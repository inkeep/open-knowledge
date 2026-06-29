import { afterEach, describe, expect, mock, test } from 'bun:test';
import {
  createDefaultFetchSnapshot,
  type ProbeDeps,
  peekClaudeDesktopIntegrationCache,
  probeClaudeDesktopIntegration,
  resetClaudeDesktopIntegrationForTest,
  runIntegrationProbe,
  subscribeClaudeDesktopIntegration,
  validateSkillInstallStateSnapshot,
} from './use-claude-desktop-integration';

const okSnapshot = (version: string) => ({
  currentVersion: version,
  targets: { 'claude-cowork': { version, recordedAt: '2026-05-12T00:00:00.000Z' } },
});

function deps(overrides: Partial<ProbeDeps> = {}): ProbeDeps {
  return {
    detectClaudeDesktop: async () => true,
    fetchSnapshot: async () => null,
    readLocalStorageGuard: () => ({ skillInstalled: false, skillVersion: null }),
    ...overrides,
  };
}

afterEach(() => {
  resetClaudeDesktopIntegrationForTest();
});

describe('probeClaudeDesktopIntegration — happy paths', () => {
  test('Electron bridge present + server reports skill installed', async () => {
    const result = await probeClaudeDesktopIntegration(
      deps({
        detectClaudeDesktop: async () => true,
        fetchSnapshot: async () => okSnapshot('2.0.0'),
      }),
    );
    expect(result).toEqual({
      desktopPresent: true,
      skillInstalled: true,
      skillVersion: '2.0.0',
    });
  });

  test('Electron bridge absent (web host) → desktopPresent defaults true', async () => {
    const result = await probeClaudeDesktopIntegration(
      deps({
        detectClaudeDesktop: undefined,
        fetchSnapshot: async () => okSnapshot('1.0.0'),
      }),
    );
    expect(result.desktopPresent).toBe(true);
    expect(result.skillInstalled).toBe(true);
    expect(result.skillVersion).toBe('1.0.0');
  });

  test('desktop detected absent → desktopPresent=false; skill probe still runs', async () => {
    const result = await probeClaudeDesktopIntegration(
      deps({
        detectClaudeDesktop: async () => false,
        fetchSnapshot: async () => okSnapshot('1.0.0'),
      }),
    );
    expect(result.desktopPresent).toBe(false);
    expect(result.skillInstalled).toBe(true);
  });

  test('server snapshot present but no claude-cowork target → skillInstalled=false', async () => {
    const result = await probeClaudeDesktopIntegration(
      deps({
        fetchSnapshot: async () => ({ currentVersion: '1.0.0', targets: {} }),
      }),
    );
    expect(result.skillInstalled).toBe(false);
    expect(result.skillVersion).toBeNull();
  });
});

describe('probeClaudeDesktopIntegration — failure modes', () => {
  test('fetchSnapshot returns null (server unreachable) → falls through to localStorage', async () => {
    const result = await probeClaudeDesktopIntegration(
      deps({
        fetchSnapshot: async () => null,
        readLocalStorageGuard: () => ({ skillInstalled: true, skillVersion: '1.5.0' }),
      }),
    );
    expect(result.skillInstalled).toBe(true);
    expect(result.skillVersion).toBe('1.5.0');
  });

  test('fetchSnapshot returns null (contract-conforming swallow) → falls through to localStorage', async () => {
    const result = await probeClaudeDesktopIntegration(
      deps({
        fetchSnapshot: async () => null,
        readLocalStorageGuard: () => ({ skillInstalled: true, skillVersion: '0.9.0' }),
      }),
    );
    expect(result.skillInstalled).toBe(true);
    expect(result.skillVersion).toBe('0.9.0');
  });

  test('detectClaudeDesktop rejects → desktopPresent defaults true (graceful degrade)', async () => {
    const result = await probeClaudeDesktopIntegration(
      deps({
        detectClaudeDesktop: async () => {
          throw new Error('IPC failed');
        },
      }),
    );
    expect(result.desktopPresent).toBe(true);
  });

  test('readLocalStorageGuard returns safe default (contract-conforming) → skillInstalled=false', async () => {
    const result = await probeClaudeDesktopIntegration(
      deps({
        fetchSnapshot: async () => null,
        readLocalStorageGuard: () => ({ skillInstalled: false, skillVersion: null }),
      }),
    );
    expect(result.skillInstalled).toBe(false);
    expect(result.skillVersion).toBeNull();
  });

  test('both fetch and localStorage miss → skillInstalled=false (safe default surfaces install affordance)', async () => {
    const result = await probeClaudeDesktopIntegration(deps());
    expect(result.skillInstalled).toBe(false);
    expect(result.skillVersion).toBeNull();
  });
});

describe('runIntegrationProbe — cache + subscriber coalescing', () => {
  test('every subscriber fires when the probe resolves (useSyncExternalStore contract: no-args)', async () => {
    const a = mock();
    const b = mock();
    const unsubA = subscribeClaudeDesktopIntegration(a);
    const unsubB = subscribeClaudeDesktopIntegration(b);
    try {
      await runIntegrationProbe(deps({ fetchSnapshot: async () => okSnapshot('3.0.0') }));
      const expected = {
        desktopPresent: true,
        skillInstalled: true,
        skillVersion: '3.0.0',
      };
      expect(a).toHaveBeenCalledTimes(1);
      expect(b).toHaveBeenCalledTimes(1);
      expect(peekClaudeDesktopIntegrationCache()).toEqual(expected);
    } finally {
      unsubA();
      unsubB();
    }
  });

  test('two concurrent probe calls share a single fetch — proves consumer-mount dedup', async () => {
    let fetchCount = 0;
    const slowFetch = async () => {
      fetchCount += 1;
      await new Promise((r) => setTimeout(r, 5));
      return okSnapshot('4.0.0');
    };
    const d = deps({ fetchSnapshot: slowFetch });
    const a = runIntegrationProbe(d);
    const b = runIntegrationProbe(d);
    await Promise.all([a, b]);
    expect(fetchCount).toBe(1);
    expect(peekClaudeDesktopIntegrationCache()?.skillVersion).toBe('4.0.0');
  });

  test('sequential probes each run their own fetch — pins the refresh() code path', async () => {
    await runIntegrationProbe(deps({ fetchSnapshot: async () => okSnapshot('1.0.0') }));
    expect(peekClaudeDesktopIntegrationCache()?.skillVersion).toBe('1.0.0');
    await runIntegrationProbe(deps({ fetchSnapshot: async () => okSnapshot('2.0.0') }));
    expect(peekClaudeDesktopIntegrationCache()?.skillVersion).toBe('2.0.0');
  });

  test('subscriber unsubscribe stops further notifications', async () => {
    const a = mock();
    const unsub = subscribeClaudeDesktopIntegration(a);
    await runIntegrationProbe(deps({ fetchSnapshot: async () => okSnapshot('6.0.0') }));
    expect(a).toHaveBeenCalledTimes(1);
    unsub();
    await runIntegrationProbe(deps({ fetchSnapshot: async () => okSnapshot('7.0.0') }));
    expect(a).toHaveBeenCalledTimes(1);
  });
});

describe('createDefaultFetchSnapshot — abort + timeout behavior', () => {
  test('aborts and resolves null when fetch exceeds the configured timeout', async () => {
    const fetchImpl: typeof fetch = (_url, init) => {
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) return; // pure timeout — never resolves
        if (signal.aborted) {
          reject(new DOMException('Aborted', 'AbortError'));
          return;
        }
        signal.addEventListener('abort', () => {
          reject(new DOMException('Aborted', 'AbortError'));
        });
      });
    };
    const fetcher = createDefaultFetchSnapshot({ timeoutMs: 5, fetchImpl });
    const result = await fetcher();
    expect(result).toBeNull();
  });

  test('returns parsed snapshot when fetch resolves in time', async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response(JSON.stringify(okSnapshot('5.0.0')), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    const fetcher = createDefaultFetchSnapshot({ timeoutMs: 100, fetchImpl });
    const result = await fetcher();
    expect(result?.currentVersion).toBe('5.0.0');
  });

  test('returns null when server responds non-OK (no parsing surprises)', async () => {
    const fetchImpl: typeof fetch = async () => new Response('boom', { status: 500 });
    const fetcher = createDefaultFetchSnapshot({ timeoutMs: 100, fetchImpl });
    expect(await fetcher()).toBeNull();
  });

  test('returns null when body has wrong shape', async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response(JSON.stringify({ noVersion: 'oops' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    const fetcher = createDefaultFetchSnapshot({ timeoutMs: 100, fetchImpl });
    expect(await fetcher()).toBeNull();
  });

  test('returns null when no fetch implementation is available', async () => {
    const fetcher = createDefaultFetchSnapshot({ timeoutMs: 100, fetchImpl: undefined });
    expect(await fetcher()).toBeNull();
  });

  test('returns null when response.json() throws a non-SyntaxError (e.g., aborted body)', async () => {
    const fetchImpl: typeof fetch = async () => {
      const response = new Response('{}', { status: 200 });
      response.json = async () => {
        throw new TypeError('body stream already consumed');
      };
      return response;
    };
    const fetcher = createDefaultFetchSnapshot({ timeoutMs: 100, fetchImpl });
    expect(await fetcher()).toBeNull();
  });

  test('returns null when server responds with empty-string version (validator tightening)', async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response(JSON.stringify({ currentVersion: '' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    const fetcher = createDefaultFetchSnapshot({ timeoutMs: 100, fetchImpl });
    expect(await fetcher()).toBeNull();
  });

  test('returns null when target.version is empty string', async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response(
        JSON.stringify({
          currentVersion: '1.0.0',
          targets: { 'claude-cowork': { version: '' } },
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      );
    const fetcher = createDefaultFetchSnapshot({ timeoutMs: 100, fetchImpl });
    expect(await fetcher()).toBeNull();
  });
});

describe('useClaudeDesktopIntegration — module surface', () => {
  test('exports the hook + pure primitives', async () => {
    const mod = await import('./use-claude-desktop-integration');
    expect(typeof mod.useClaudeDesktopIntegration).toBe('function');
    expect(typeof mod.probeClaudeDesktopIntegration).toBe('function');
    expect(typeof mod.runIntegrationProbe).toBe('function');
    expect(typeof mod.createDefaultFetchSnapshot).toBe('function');
    expect(typeof mod.defaultReadLocalStorageGuard).toBe('function');
    expect(typeof mod.subscribeClaudeDesktopIntegration).toBe('function');
    expect(typeof mod.getClaudeDesktopIntegrationSnapshot).toBe('function');
  });
});

describe('defaultReadLocalStorageGuard — production scanner', () => {
  const realLocalStorage = (globalThis as { localStorage?: Storage }).localStorage;

  function installMemoryStorage(entries: Record<string, string>): void {
    const keys = Object.keys(entries);
    const store: Storage = {
      get length() {
        return keys.length;
      },
      key(i: number) {
        return keys[i] ?? null;
      },
      getItem(k: string) {
        return entries[k] ?? null;
      },
      setItem() {},
      removeItem() {},
      clear() {},
    };
    Object.defineProperty(globalThis, 'localStorage', {
      value: store,
      configurable: true,
      writable: true,
    });
  }

  function installThrowingStorage(): void {
    Object.defineProperty(globalThis, 'localStorage', {
      value: new Proxy(
        {},
        {
          get() {
            throw new Error('SecurityError: localStorage denied');
          },
        },
      ),
      configurable: true,
      writable: true,
    });
  }

  function restoreLocalStorage(): void {
    if (realLocalStorage) {
      Object.defineProperty(globalThis, 'localStorage', {
        value: realLocalStorage,
        configurable: true,
        writable: true,
      });
    } else {
      delete (globalThis as { localStorage?: Storage }).localStorage;
    }
  }

  afterEach(() => {
    restoreLocalStorage();
  });

  test('matching guard key → skillInstalled=true and version extracted from suffix', async () => {
    installMemoryStorage({
      'ok:skill:cowork:installed:v2.5.0': '1',
      'unrelated:key': 'whatever',
    });
    const { defaultReadLocalStorageGuard } = await import('./use-claude-desktop-integration');
    expect(defaultReadLocalStorageGuard()).toEqual({
      skillInstalled: true,
      skillVersion: '2.5.0',
    });
  });

  test('no matching guard key → safe default skillInstalled=false', async () => {
    installMemoryStorage({
      'unrelated:foo': 'a',
      'something:else': 'b',
    });
    const { defaultReadLocalStorageGuard } = await import('./use-claude-desktop-integration');
    expect(defaultReadLocalStorageGuard()).toEqual({
      skillInstalled: false,
      skillVersion: null,
    });
  });

  test('empty localStorage → safe default', async () => {
    installMemoryStorage({});
    const { defaultReadLocalStorageGuard } = await import('./use-claude-desktop-integration');
    expect(defaultReadLocalStorageGuard()).toEqual({
      skillInstalled: false,
      skillVersion: null,
    });
  });

  test('localStorage access throws (sandboxed iframe / private browsing) → safe default', async () => {
    installThrowingStorage();
    const { defaultReadLocalStorageGuard } = await import('./use-claude-desktop-integration');
    expect(defaultReadLocalStorageGuard()).toEqual({
      skillInstalled: false,
      skillVersion: null,
    });
  });

  test('cross-module prefix contract holds — writer key shape matches reader prefix', async () => {
    const { buildCoworkSkillGuardKey } = await import('./cowork-skill-install');
    const key = buildCoworkSkillGuardKey('1.2.3');
    expect(key).toBe('ok:skill:cowork:installed:v1.2.3');
    installMemoryStorage({ [key]: '1' });
    const { defaultReadLocalStorageGuard } = await import('./use-claude-desktop-integration');
    expect(defaultReadLocalStorageGuard()).toEqual({
      skillInstalled: true,
      skillVersion: '1.2.3',
    });
  });
});

describe('validateSkillInstallStateSnapshot — shape-drift defense', () => {
  test('null body → null (not an object)', () => {
    expect(validateSkillInstallStateSnapshot(null)).toBeNull();
  });

  test('primitive body → null (not an object)', () => {
    expect(validateSkillInstallStateSnapshot('oops')).toBeNull();
    expect(validateSkillInstallStateSnapshot(42)).toBeNull();
    expect(validateSkillInstallStateSnapshot(true)).toBeNull();
  });

  test('missing currentVersion → null', () => {
    expect(validateSkillInstallStateSnapshot({ targets: {} })).toBeNull();
  });

  test('currentVersion not string → null', () => {
    expect(validateSkillInstallStateSnapshot({ currentVersion: 1 })).toBeNull();
    expect(validateSkillInstallStateSnapshot({ currentVersion: null })).toBeNull();
  });

  test('currentVersion empty string → null (tightened: empty is not a valid version)', () => {
    expect(validateSkillInstallStateSnapshot({ currentVersion: '' })).toBeNull();
  });

  test('targets present but not an object → null', () => {
    expect(
      validateSkillInstallStateSnapshot({ currentVersion: '1.0.0', targets: 'oops' }),
    ).toBeNull();
    expect(
      validateSkillInstallStateSnapshot({ currentVersion: '1.0.0', targets: null }),
    ).toBeNull();
  });

  test('target entry not an object → null', () => {
    expect(
      validateSkillInstallStateSnapshot({
        currentVersion: '1.0.0',
        targets: { 'claude-cowork': 'oops' },
      }),
    ).toBeNull();
  });

  test('target.version not a string → null', () => {
    expect(
      validateSkillInstallStateSnapshot({
        currentVersion: '1.0.0',
        targets: { 'claude-cowork': { version: 42 } },
      }),
    ).toBeNull();
  });

  test('target.version empty string → null (tightened)', () => {
    expect(
      validateSkillInstallStateSnapshot({
        currentVersion: '1.0.0',
        targets: { 'claude-cowork': { version: '' } },
      }),
    ).toBeNull();
  });

  test('null target entry is permitted (skip — matches optional schema)', () => {
    const result = validateSkillInstallStateSnapshot({
      currentVersion: '1.0.0',
      targets: { 'claude-cowork': null },
    });
    expect(result).not.toBeNull();
    expect(result?.currentVersion).toBe('1.0.0');
  });

  test('happy path — fully populated snapshot', () => {
    const body = {
      currentVersion: '2.0.0',
      targets: { 'claude-cowork': { version: '2.0.0', recordedAt: '2026-05-12T00:00:00Z' } },
    };
    expect(validateSkillInstallStateSnapshot(body)).toEqual(body);
  });

  test('happy path — targets field absent', () => {
    const body = { currentVersion: '1.0.0' };
    expect(validateSkillInstallStateSnapshot(body)).toEqual(body);
  });
});
