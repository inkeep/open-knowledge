import { describe, expect, test } from 'bun:test';
import { runBootstrap } from '../../src/main/bootstrap.ts';
import { emptyState } from '../../src/main/state-store.ts';
import type { OkThemeSource } from '../../src/shared/bridge-contract.ts';

interface CallTrace {
  step: string;
  args?: unknown;
}

function makeTracingDeps(overrides?: {
  appStateOverride?: Partial<ReturnType<typeof emptyState>>;
  schemaCompatStatus?: 'ok' | 'incompatible';
}) {
  const calls: CallTrace[] = [];
  const warns: Array<{ msg: string; obj?: unknown }> = [];
  const baseState = { ...emptyState(), ...overrides?.appStateOverride };

  return {
    calls,
    warns,
    deps: {
      loadAppState: () => {
        calls.push({ step: 'loadAppState' });
        return baseState;
      },
      evaluateSchemaCompatibility: (
        state: typeof baseState,
        maxSupported: number,
        currentBuild: string,
      ) => {
        calls.push({
          step: 'evaluateSchemaCompatibility',
          args: { schemaVersion: state.schemaVersion, maxSupported, currentBuild },
        });
        if (overrides?.schemaCompatStatus === 'incompatible') {
          return {
            status: 'incompatible' as const,
            diagnostic: {
              currentBuild,
              persistedSchemaVersion: state.schemaVersion,
              maxSupported,
            },
          };
        }
        return { status: 'ok' as const };
      },
      installLocalhostCorsInjector: () => {
        calls.push({ step: 'installLocalhostCorsInjector' });
      },
      installEmbedRefererRewriter: () => {
        calls.push({ step: 'installEmbedRefererRewriter' });
      },
      registerIpcHandlers: () => {
        calls.push({ step: 'registerIpcHandlers' });
      },
      setNativeThemeSource: (source: OkThemeSource) => {
        calls.push({ step: 'setNativeThemeSource', args: { source } });
      },
      refreshApplicationMenu: () => {
        calls.push({ step: 'refreshApplicationMenu' });
      },
      installDockIcon: () => {
        calls.push({ step: 'installDockIcon' });
      },
      log: {
        warn: (msg: string, obj?: unknown) => {
          warns.push({ msg, obj });
        },
      },
      appVersion: '0.99.0',
      maxSupportedSchemaVersion: 1,
    },
  };
}

describe('runBootstrap order-of-operations', () => {
  test('IPC handlers register before nativeTheme.themeSource is set', async () => {
    const { calls, deps } = makeTracingDeps();
    await runBootstrap(deps);

    const ipcIdx = calls.findIndex((c) => c.step === 'registerIpcHandlers');
    const themeIdx = calls.findIndex((c) => c.step === 'setNativeThemeSource');
    expect(ipcIdx).toBeGreaterThanOrEqual(0);
    expect(themeIdx).toBeGreaterThanOrEqual(0);
    expect(ipcIdx).toBeLessThan(themeIdx);
  });

  test('nativeTheme.themeSource is set to "system" exactly once', async () => {
    const { calls, deps } = makeTracingDeps();
    await runBootstrap(deps);

    const themeCalls = calls.filter((c) => c.step === 'setNativeThemeSource');
    expect(themeCalls).toHaveLength(1);
    expect(themeCalls[0]?.args).toEqual({ source: 'system' });
  });

  test('runBootstrap does not invoke any window-creation surface', async () => {
    const { calls, deps } = makeTracingDeps();
    await runBootstrap(deps);

    const allowedSteps = new Set([
      'loadAppState',
      'evaluateSchemaCompatibility',
      'installLocalhostCorsInjector',
      'installEmbedRefererRewriter',
      'registerIpcHandlers',
      'setNativeThemeSource',
      'refreshApplicationMenu',
      'installDockIcon',
    ]);
    for (const c of calls) {
      expect(allowedSteps.has(c.step)).toBe(true);
    }
  });

  test('full call sequence matches documented boot-order contract', async () => {
    const { calls, deps } = makeTracingDeps();
    await runBootstrap(deps);

    expect(calls.map((c) => c.step)).toEqual([
      'loadAppState',
      'evaluateSchemaCompatibility',
      'installLocalhostCorsInjector',
      'installEmbedRefererRewriter',
      'registerIpcHandlers',
      'setNativeThemeSource',
      'refreshApplicationMenu',
      'installDockIcon',
    ]);
  });
});

describe('runBootstrap return shape', () => {
  test('returns loaded appState and null diagnostic on the happy path', async () => {
    const { deps } = makeTracingDeps();
    const result = await runBootstrap(deps);
    expect(result.appState.schemaVersion).toBe(1);
    expect(result.pendingSchemaIncompatibility).toBeNull();
  });

  test('returns the schema diagnostic when persisted schema is too new', async () => {
    const { warns, deps } = makeTracingDeps({
      appStateOverride: { schemaVersion: 99 },
      schemaCompatStatus: 'incompatible',
    });
    const result = await runBootstrap(deps);
    expect(result.pendingSchemaIncompatibility).toEqual({
      currentBuild: '0.99.0',
      persistedSchemaVersion: 99,
      maxSupported: 1,
    });
    expect(warns.some((w) => w.msg.includes('schemaVersion'))).toBe(true);
  });
});
