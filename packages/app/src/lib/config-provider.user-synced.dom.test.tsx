/**
 * RTL mount test for the userSynced state-wiring integration.
 *
 * Pins the behavioral contract that the source-string guards in
 * `config-provider.test.tsx` cannot reach: the binding's `subscribeSynced`
 * callback actually flips React state, the mount-time `hasSynced()` seed
 * lands in the rendered context value, and the false→true transition
 * propagates to consumers. A refactor preserving the literal source text
 * (e.g. the subscription callback fails to call `setUserState`, or the
 * `prev?.binding === userScoped.binding` identity guard silently no-ops)
 * could ship a regression — Settings would render an empty body on every
 * open with no error, because `userBinding={userSynced ? userBinding : null}`
 * would stay false forever.
 *
 * Sibling to `config-provider.dom.test.tsx`, which only exercises the
 * `collabUrl: null` cold-start path. That file's module-level mocks
 * intentionally stay shallow; full provider/binding mocking lives here so
 * the two test files don't fight each other (Bun's `--isolate` flag in
 * `test:dom` keeps the mock graphs independent per file).
 */

import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import type { ConfigBinding, OkignoreBinding, WriteScope } from '@inkeep/open-knowledge-core';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { __resetServerInstanceStoreForTests, setServerInstanceId } from './server-instance-store';

// One captured listener per binding scope so the test can fire the synced
// transition manually. Reset per-test via the helper below.
type SyncedListener = () => void;
type ScopeKey = WriteScope;
type FakeConfig = { scope: ScopeKey; appearance?: { theme?: 'light' | 'dark' | 'system' } };
type ProviderEvent = { event?: { code: number; reason: string } };
type ProviderOptions = {
  name: string;
  onDisconnect?: (payload: ProviderEvent) => void;
  onClose?: (payload: ProviderEvent) => void;
};
type ProviderRecord = {
  name: string;
  options: ProviderOptions;
  destroyed: boolean;
};

const captures = new Map<
  ScopeKey,
  {
    syncedListener: SyncedListener | null;
    hasSyncedSeed: boolean;
    config: FakeConfig;
    disposed: boolean;
    syncedUnsubscribed: boolean;
  }
>();

let okignoreSyncedHandler: (() => void) | null = null;
let okignoreDisposed = false;
let providerRecords: ProviderRecord[] = [];
let mergeLayeredCalls: Array<[unknown, unknown, unknown]> = [];
let mergedConfig: unknown = {};
let useThemeBridgeCalls: Array<[unknown, string]> = [];
let setThemeCalls: string[] = [];
const buildAuthTokenCalls: Array<readonly unknown[]> = [];

function resetCaptures() {
  captures.clear();
  okignoreSyncedHandler = null;
  okignoreDisposed = false;
  providerRecords = [];
  mergeLayeredCalls = [];
  mergedConfig = {};
  useThemeBridgeCalls = [];
  setThemeCalls = [];
  buildAuthTokenCalls.length = 0;
}

function makeFakeConfigBinding(scope: ScopeKey, hasSyncedSeed: boolean): ConfigBinding {
  const config: FakeConfig = { scope };
  captures.set(scope, {
    syncedListener: null,
    hasSyncedSeed,
    config,
    disposed: false,
    syncedUnsubscribed: false,
  });
  return {
    current: () => config as never,
    patch: () => ({ ok: true, value: { applied: [], effective: {} } }) as never,
    subscribe: () => () => {},
    hasSynced: () => captures.get(scope)?.hasSyncedSeed ?? false,
    subscribeSynced: (listener) => {
      const entry = captures.get(scope);
      if (entry) entry.syncedListener = listener;
      return () => {
        const e = captures.get(scope);
        if (e?.syncedListener === listener) e.syncedListener = null;
        if (e) e.syncedUnsubscribed = true;
      };
    },
    dispose: () => {
      const entry = captures.get(scope);
      if (entry) entry.disposed = true;
    },
  };
}

function makeFakeOkignoreBinding(): OkignoreBinding {
  return {
    current: () => ({}) as never,
    patch: () => ({ ok: true, value: { applied: [], effective: {} } }) as never,
    subscribe: () => () => {},
    dispose: () => {
      okignoreDisposed = true;
    },
  } as unknown as OkignoreBinding;
}

mock.module('@/hooks/use-theme-bridge', () => ({
  useThemeBridge: (bridge: unknown, theme: string) => {
    useThemeBridgeCalls.push([bridge, theme]);
  },
}));

// `next-themes` is a real dependency; `useTheme()` returns `{ setTheme }`
// inside ConfigProvider's effect. Provide a no-op shim so the effect's
// `setTheme(themeValue)` call inside the merged-config bridge does not
// throw when run outside a `ThemeProvider`.
mock.module('next-themes', () => ({
  useTheme: () => ({
    setTheme: (theme: string) => {
      setThemeCalls.push(theme);
    },
  }),
}));

// `HocuspocusProvider` opens a real WebSocket on construction; the
// network is not available under the Tier-3 substrate (and even if it
// were, the network-side `'synced'` event is exactly the timing we want
// to control deterministically). The fake captures the okignore
// 'synced' handler so test cases can drive it directly; ConfigBinding
// 'synced' wiring is captured via the bindConfigDoc mock below.
mock.module('@hocuspocus/provider', () => {
  class FakeHocuspocusProvider {
    private readonly record: ProviderRecord;

    constructor(options: ProviderOptions) {
      this.record = { name: options.name, options, destroyed: false };
      providerRecords.push(this.record);
    }

    on(event: string, handler: () => void) {
      if (event === 'synced') okignoreSyncedHandler = handler;
    }
    off(event: string, handler: () => void) {
      if (event === 'synced' && okignoreSyncedHandler === handler) {
        okignoreSyncedHandler = null;
      }
    }
    destroy() {
      this.record.destroyed = true;
    }
  }
  return { HocuspocusProvider: FakeHocuspocusProvider };
});

mock.module('@/lib/auth-token', () => ({
  buildAuthToken: (...args: readonly unknown[]) => {
    buildAuthTokenCalls.push(args);
    return 'test-auth-token';
  },
}));

// `bindConfigDoc` and `bindOkignoreDoc` are the seams ConfigProvider
// calls to produce the binding objects it then subscribes to. The fakes
// return ConfigBindings whose `subscribeSynced` listener is captured per
// scope so the test can trigger the false→true transition by hand.
mock.module('@inkeep/open-knowledge-core', () => ({
  bindConfigDoc: (_provider: unknown, scope: WriteScope) =>
    makeFakeConfigBinding(scope, scope === 'user' ? userHasSyncedSeed : false),
  bindOkignoreDoc: () => makeFakeOkignoreBinding(),
  CONFIG_DOC_NAME_USER: '__user__/config.yml',
  CONFIG_DOC_NAME_PROJECT: '__config__/project',
  CONFIG_DOC_NAME_PROJECT_LOCAL: '__local__/project',
  CONFIG_DOC_NAME_OKIGNORE: '__config__/okignore',
  mergeLayered: (user: unknown, project: unknown, projectLocal: unknown) => {
    mergeLayeredCalls.push([user, project, projectLocal]);
    return mergedConfig;
  },
}));

// Module-level toggle for the second case (mount-time pre-synced seed).
// Bun module mocks resolve once at import time, but the factory closes
// over this variable so each test can flip the value via the helper
// before the dynamic import below.
let userHasSyncedSeed = false;

const { ConfigProvider, useConfigContext } = await import('./config-provider');

let lastContext: ReturnType<typeof useConfigContext> | null = null;

function UserSyncedConsumer() {
  const ctx = useConfigContext();
  return <span data-testid="user-synced">{String(ctx.userSynced)}</span>;
}

function ConfigContextProbe() {
  const ctx = useConfigContext();
  lastContext = ctx;
  return (
    <div>
      <span data-testid="user-synced">{String(ctx.userSynced)}</span>
      <span data-testid="project-local-synced">{String(ctx.projectLocalSynced)}</span>
      <span data-testid="has-project-local-binding">
        {String(ctx.projectLocalBinding !== null)}
      </span>
      <span data-testid="has-project-local-config">{String(ctx.projectLocalConfig !== null)}</span>
      <span data-testid="has-merged-config">{String(ctx.merged === mergedConfig)}</span>
    </div>
  );
}

describe('ConfigProvider — userSynced behavioral wiring (Tier-3)', () => {
  let consoleErrorSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    resetCaptures();
    lastContext = null;
    userHasSyncedSeed = false;
    __resetServerInstanceStoreForTests();
    consoleErrorSpy = spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    cleanup();
    consoleErrorSpy.mockRestore();
    Reflect.deleteProperty(window, 'okDesktop');
  });

  test('userSynced reads false until the binding fires its synced listener, then flips to true', () => {
    render(
      <ConfigProvider collabUrl="ws://test.invalid">
        <UserSyncedConsumer />
      </ConfigProvider>,
    );

    // Pre-sync: the binding's `hasSynced()` returned false at mount time
    // (the default seed), so the initial context value carries userSynced
    // = false. Pinned here to prove the cold-start window is observable
    // through the public Context surface — not just through the source.
    expect(screen.getByTestId('user-synced').textContent).toBe('false');

    const userEntry = captures.get('user');
    expect(userEntry?.syncedListener).not.toBeNull();

    // Fire the synced transition the way the real binding would after
    // the Hocuspocus provider's first 'synced' event. `act(...)` wraps
    // the listener call so React commits the setState before assertion.
    act(() => {
      userEntry?.syncedListener?.();
    });

    expect(screen.getByTestId('user-synced').textContent).toBe('true');
  });

  test('userSynced reads true on first render when the binding has already synced at mount time', () => {
    // Mount-time seed via the `hasSynced()` short-circuit in
    // `ConfigProvider`'s `setUserState` initializer. Mirrors the
    // StrictMode double-invocation case where the binding was already
    // synced before the effect ran.
    userHasSyncedSeed = true;

    render(
      <ConfigProvider collabUrl="ws://test.invalid">
        <UserSyncedConsumer />
      </ConfigProvider>,
    );

    expect(screen.getByTestId('user-synced').textContent).toBe('true');
  });

  test('opens user, project, and project-local bindings and exposes the merged context shape', async () => {
    render(
      <ConfigProvider collabUrl="ws://test.invalid">
        <ConfigContextProbe />
      </ConfigProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('has-project-local-binding').textContent).toBe('true');
    });

    expect(providerRecords.map((record) => record.name)).toEqual([
      '__user__/config.yml',
      '__config__/project',
      '__local__/project',
      '__config__/okignore',
    ]);
    expect([...captures.keys()]).toEqual(['user', 'project', 'project-local']);

    const latestMerge = mergeLayeredCalls.at(-1);
    expect(latestMerge?.[0]).toBe(captures.get('user')?.config);
    expect(latestMerge?.[1]).toBe(captures.get('project')?.config);
    expect(latestMerge?.[2]).toBe(captures.get('project-local')?.config);

    expect(lastContext?.projectLocalBinding).not.toBeNull();
    expect(lastContext?.projectLocalConfig).toBe(captures.get('project-local')?.config);
    expect(lastContext?.projectLocalSynced).toBe(false);
    expect(lastContext?.merged).toBe(mergedConfig);
    expect(screen.getByTestId('has-project-local-config').textContent).toBe('true');
    expect(screen.getByTestId('has-merged-config').textContent).toBe('true');
  });

  test('projectLocalSynced flips from its hasSynced seed and cleans up on unmount', async () => {
    const { unmount } = render(
      <ConfigProvider collabUrl="ws://test.invalid">
        <ConfigContextProbe />
      </ConfigProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('project-local-synced').textContent).toBe('false');
    });

    const projectLocalEntry = captures.get('project-local');
    expect(projectLocalEntry?.syncedListener).not.toBeNull();

    act(() => {
      projectLocalEntry?.syncedListener?.();
    });

    expect(screen.getByTestId('project-local-synced').textContent).toBe('true');

    unmount();

    expect(projectLocalEntry?.syncedListener).toBeNull();
    expect(projectLocalEntry?.syncedUnsubscribed).toBe(true);
    expect(projectLocalEntry?.disposed).toBe(true);
    expect(okignoreSyncedHandler).toBeNull();
    expect(okignoreDisposed).toBe(true);
    expect(providerRecords.find((record) => record.name === '__local__/project')?.destroyed).toBe(
      true,
    );
  });

  test('passes the Electron theme bridge a system fallback when merged config has no theme', async () => {
    const bridge = { nativeTheme: {} };
    Object.defineProperty(window, 'okDesktop', {
      configurable: true,
      value: bridge,
    });

    mergedConfig = { appearance: {} };

    render(
      <ConfigProvider collabUrl="ws://test.invalid">
        <ConfigContextProbe />
      </ConfigProvider>,
    );

    await waitFor(() => {
      expect(mergeLayeredCalls.length).toBeGreaterThan(0);
    });

    expect(useThemeBridgeCalls.at(-1)).toEqual([bridge, 'system']);
    expect(setThemeCalls).toEqual([]);
  });

  test('threads the server epoch from the store into every provider auth-token claim', async () => {
    setServerInstanceId('epoch-threading-test');

    render(
      <ConfigProvider collabUrl="ws://test.invalid">
        <ConfigContextProbe />
      </ConfigProvider>,
    );

    await waitFor(() => {
      expect(providerRecords.length).toBe(4);
    });
    expect(buildAuthTokenCalls.length).toBe(4);
    expect(
      buildAuthTokenCalls.every((args) => args[0] === null && args[1] === 'epoch-threading-test'),
    ).toBe(true);
  });

  test('provider disconnect and close callbacks emit structured role logs', async () => {
    const consoleWarnSpy = spyOn(console, 'warn').mockImplementation(() => {});

    render(
      <ConfigProvider collabUrl="ws://test.invalid">
        <ConfigContextProbe />
      </ConfigProvider>,
    );

    await waitFor(() => {
      expect(providerRecords.length).toBe(4);
    });

    providerRecords
      .find((record) => record.name === '__user__/config.yml')
      ?.options.onDisconnect?.({ event: { code: 4001, reason: 'network down' } });
    providerRecords
      .find((record) => record.name === '__config__/okignore')
      ?.options.onClose?.({ event: { code: 1006, reason: 'socket closed' } });

    const payloads = consoleWarnSpy.mock.calls.map(([line]) => JSON.parse(String(line)));
    expect(payloads).toContainEqual({
      event: 'ok-config-provider-disconnect',
      docName: '__user__/config.yml',
      code: 4001,
      reason: 'network down',
    });
    expect(payloads).toContainEqual({
      event: 'ok-okignore-provider-close',
      docName: '__config__/okignore',
      code: 1006,
      reason: 'socket closed',
    });

    consoleWarnSpy.mockRestore();
  });
});
