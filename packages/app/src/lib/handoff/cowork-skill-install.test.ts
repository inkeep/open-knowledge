/**
 * Unit tests for the lazy Claude Cowork skill-install gate. Exercises the
 * pure `ensureCoworkSkillInstalled` helper with in-memory storage + installer
 * doubles. No DOM, no React — matches the repo convention.
 *
 * Installer-specific behavior (Electron bridge, HTTP endpoint) is tested in
 * `skill-installer.test.ts`. This file covers the guard policy.
 */

import { describe, expect, mock, test } from 'bun:test';
import {
  buildCoworkSkillGuardKey,
  type EnsureCoworkSkillDeps,
  ensureCoworkSkillInstalled,
  type SkillInstallStorage,
} from './cowork-skill-install';
import type { SkillInstaller, SkillInstallResult } from './skill-installer';

function memoryStorage(initial: Record<string, string> = {}): SkillInstallStorage & {
  readonly snapshot: () => Record<string, string>;
} {
  const data = new Map(Object.entries(initial));
  return {
    getItem(key) {
      return data.get(key) ?? null;
    },
    setItem(key, value) {
      data.set(key, value);
    },
    snapshot() {
      return Object.fromEntries(data);
    },
  };
}

function fakeInstaller(result: SkillInstallResult): SkillInstaller {
  return { install: mock(async () => result) };
}

function deps(overrides: Partial<EnsureCoworkSkillDeps> = {}): EnsureCoworkSkillDeps {
  return {
    // Default snapshot fetcher returns null — simulates server unreachable,
    // ladder falls through to localStorage. Individual tests can inject
    // a real snapshot to exercise the server-check path.
    fetchSnapshot: async () => null,
    fallbackSkillVersion: '1.2.3',
    installer: fakeInstaller({ ok: true, path: '/tmp/openknowledge.skill' }),
    storage: memoryStorage(),
    ...overrides,
  };
}

describe('buildCoworkSkillGuardKey', () => {
  test('namespaces and versions the localStorage key', () => {
    expect(buildCoworkSkillGuardKey('1.2.3')).toBe('ok:skill:cowork:installed:v1.2.3');
    expect(buildCoworkSkillGuardKey('0.0.0-dev')).toBe('ok:skill:cowork:installed:v0.0.0-dev');
  });
});

describe('ensureCoworkSkillInstalled — first run', () => {
  test('installer present + ok: invokes it, sets guard, returns installed-now', async () => {
    const storage = memoryStorage();
    const installer = fakeInstaller({ ok: true, path: '/tmp/openknowledge.skill' });

    const result = await ensureCoworkSkillInstalled(deps({ storage, installer }));

    expect(result).toEqual({
      kind: 'installed-now',
      path: '/tmp/openknowledge.skill',
      handoffWarning: undefined,
    });
    expect(installer.install).toHaveBeenCalledTimes(1);
    expect(storage.snapshot()).toEqual({ 'ok:skill:cowork:installed:v1.2.3': '1' });
  });

  test('installer ok with handoffWarning: surfaces warning, still sets guard', async () => {
    const storage = memoryStorage();
    const installer = fakeInstaller({
      ok: true,
      path: '/tmp/openknowledge.skill',
      handoffWarning: "Couldn't open in Claude Desktop",
    });

    const result = await ensureCoworkSkillInstalled(deps({ storage, installer }));

    expect(result).toEqual({
      kind: 'installed-now',
      path: '/tmp/openknowledge.skill',
      handoffWarning: "Couldn't open in Claude Desktop",
    });
    expect(storage.snapshot()).toEqual({ 'ok:skill:cowork:installed:v1.2.3': '1' });
  });

  test('installer === null: returns host-unsupported, never touches storage', async () => {
    const storage = memoryStorage();
    const result = await ensureCoworkSkillInstalled(deps({ storage, installer: null }));

    expect(result).toEqual({ kind: 'host-unsupported' });
    expect(storage.snapshot()).toEqual({});
  });

  test('installer fails: returns install-failed with reason + message, no guard set', async () => {
    const storage = memoryStorage();
    const installer = fakeInstaller({
      ok: false,
      reason: 'open-failed',
      message: 'Claude Desktop not found',
    });
    const result = await ensureCoworkSkillInstalled(deps({ storage, installer }));

    expect(result).toEqual({
      kind: 'install-failed',
      reason: 'open-failed',
      message: 'Claude Desktop not found',
    });
    expect(storage.snapshot()).toEqual({});
  });
});

describe('ensureCoworkSkillInstalled — guard semantics', () => {
  test('guard set for current skillVersion: short-circuits to already-installed (local source)', async () => {
    const storage = memoryStorage({ 'ok:skill:cowork:installed:v1.2.3': '1' });
    const installer = fakeInstaller({ ok: true, path: '/tmp/skill' });

    const result = await ensureCoworkSkillInstalled(deps({ storage, installer }));

    expect(result).toEqual({ kind: 'already-installed', source: 'local' });
    expect(installer.install).not.toHaveBeenCalled();
  });

  test('guard set for a *different* skillVersion: installer re-runs (auto-invalidation)', async () => {
    const storage = memoryStorage({ 'ok:skill:cowork:installed:v1.0.0': '1' });
    const installer = fakeInstaller({ ok: true, path: '/tmp/skill' });

    const result = await ensureCoworkSkillInstalled(
      deps({ fallbackSkillVersion: '1.2.3', storage, installer }),
    );

    expect(result.kind).toBe('installed-now');
    expect(installer.install).toHaveBeenCalledTimes(1);
    expect(storage.snapshot()).toEqual({
      'ok:skill:cowork:installed:v1.0.0': '1',
      'ok:skill:cowork:installed:v1.2.3': '1',
    });
  });

  test('server snapshot matches: short-circuits to already-installed (server source)', async () => {
    const storage = memoryStorage();
    const installer = fakeInstaller({ ok: true, path: '/tmp/skill' });

    const result = await ensureCoworkSkillInstalled(
      deps({
        fetchSnapshot: async () => ({
          currentVersion: '2.0.0',
          targets: {
            'claude-cowork': { version: '2.0.0', recordedAt: '2026-05-04T12:00:00.000Z' },
          },
        }),
        storage,
        installer,
      }),
    );

    expect(result).toEqual({ kind: 'already-installed', source: 'server' });
    expect(installer.install).not.toHaveBeenCalled();
    // Server check skipped both localStorage read and write — no implicit heal.
    expect(storage.snapshot()).toEqual({});
  });

  test('server snapshot mismatch: falls through to localStorage / install', async () => {
    const storage = memoryStorage();
    const installer = fakeInstaller({ ok: true, path: '/tmp/skill' });

    const result = await ensureCoworkSkillInstalled(
      deps({
        fetchSnapshot: async () => ({
          currentVersion: '2.0.0',
          targets: {
            'claude-cowork': { version: '1.5.0', recordedAt: '2026-04-01T00:00:00.000Z' },
          },
        }),
        storage,
        installer,
      }),
    );

    expect(result.kind).toBe('installed-now');
    expect(installer.install).toHaveBeenCalledTimes(1);
    // localStorage key uses the server-supplied currentVersion, NOT the
    // fallback — so re-running with the same server snapshot would short-
    // circuit at step 2 instead of triggering another install.
    expect(storage.snapshot()).toEqual({ 'ok:skill:cowork:installed:v2.0.0': '1' });
  });

  test('force=true bypasses both server gate and localStorage gate', async () => {
    const storage = memoryStorage({ 'ok:skill:cowork:installed:v1.2.3': '1' });
    const installer = fakeInstaller({ ok: true, path: '/tmp/skill' });

    const result = await ensureCoworkSkillInstalled(
      deps({
        fetchSnapshot: async () => ({
          currentVersion: '1.2.3',
          targets: { 'claude-cowork': { version: '1.2.3', recordedAt: '2026-05-04T00:00:00Z' } },
        }),
        storage,
        installer,
      }),
      { force: true },
    );

    expect(result.kind).toBe('installed-now');
    expect(installer.install).toHaveBeenCalledTimes(1);
    // Verify force flag was forwarded to the installer.
    expect(installer.install).toHaveBeenCalledWith({ force: true });
  });

  test('storage explicitly null: installer runs every time, guard never sets', async () => {
    const installer = fakeInstaller({ ok: true, path: '/tmp/skill' });
    await ensureCoworkSkillInstalled(deps({ storage: null, installer }));
    await ensureCoworkSkillInstalled(deps({ storage: null, installer }));
    expect(installer.install).toHaveBeenCalledTimes(2);
  });

  test('storage.setItem throws (QuotaExceededError): install still reports installed-now', async () => {
    const installer = fakeInstaller({ ok: true, path: '/tmp/skill' });
    const throwingStorage = {
      getItem: () => null,
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
    };

    const originalWarn = console.warn;
    console.warn = () => {};
    try {
      const result = await ensureCoworkSkillInstalled(
        deps({ storage: throwingStorage, installer }),
      );
      expect(result.kind).toBe('installed-now');
      expect(installer.install).toHaveBeenCalledTimes(1);
    } finally {
      console.warn = originalWarn;
    }
  });
});

describe('ensureCoworkSkillInstalled — concurrency', () => {
  test('two concurrent calls share one in-flight install (FR11 coalescing)', async () => {
    const storage = memoryStorage();
    let installInvocationCount = 0;
    type Resolver = (r: SkillInstallResult) => void;
    let resolver: Resolver | null = null;

    const installer: SkillInstaller = {
      install: () => {
        installInvocationCount += 1;
        return new Promise<SkillInstallResult>((resolve: Resolver) => {
          resolver = resolve;
        });
      },
    };

    const a = ensureCoworkSkillInstalled(deps({ storage, installer }));
    const b = ensureCoworkSkillInstalled(deps({ storage, installer }));

    // Flush microtasks so runEnsure progresses through the server check,
    // localStorage check, and the install call. After this `resolver` is
    // populated by the in-flight installer.install() invocation.
    for (let i = 0; i < 10; i += 1) {
      await Promise.resolve();
    }

    expect(resolver).not.toBeNull();
    (resolver as Resolver | null)?.({ ok: true, path: '/tmp/skill' });

    const [resultA, resultB] = await Promise.all([a, b]);
    expect(resultA.kind).toBe('installed-now');
    expect(resultB.kind).toBe('installed-now');
    expect(installInvocationCount).toBe(1);
  });
});
