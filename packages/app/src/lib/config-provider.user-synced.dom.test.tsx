import type { ConfigBinding, OkignoreBinding, WriteScope } from '@inkeep/open-knowledge-core';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { createServedBindingLog } from '@/test-utils/served-binding.test-helper';
import { dynamicActivate } from './activate-locale';
import { i18n } from './i18n';
import { __resetServerInstanceStoreForTests, setServerInstanceId } from './server-instance-store';

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
let useThemeBridgeCalls: Array<[unknown, string | undefined, string | undefined]> = [];
let useLanguageBridgeCalls: Array<[unknown, unknown, boolean]> = [];
let setThemeCalls: string[] = [];
let systemTheme: 'light' | 'dark' = 'light';
let browserLanguages: readonly string[] = [];
const buildAuthTokenCalls: Array<readonly unknown[]> = [];
const originalFetch = globalThis.fetch;

function resetCaptures() {
  captures.clear();
  okignoreSyncedHandler = null;
  okignoreDisposed = false;
  providerRecords = [];
  mergeLayeredCalls = [];
  mergedConfig = {};
  useThemeBridgeCalls = [];
  useLanguageBridgeCalls = [];
  setThemeCalls = [];
  systemTheme = 'light';
  browserLanguages = [];
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
    current: () => captures.get(scope)?.config as never,
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

vi.doMock('@/hooks/use-theme-bridge', () => ({
  useThemeBridge: (bridge: unknown, theme: string | undefined, colorThemeKey?: string) => {
    useThemeBridgeCalls.push([bridge, theme, colorThemeKey]);
  },
}));

vi.doMock('@/hooks/use-language-bridge', () => ({
  useLanguageBridge: (bridge: unknown, preference: unknown, synced: boolean) => {
    useLanguageBridgeCalls.push([bridge, preference, synced]);
  },
}));

vi.doMock('next-themes', () => ({
  useTheme: () => ({
    systemTheme,
    setTheme: (theme: string) => {
      setThemeCalls.push(theme);
    },
  }),
}));

vi.doMock('@hocuspocus/provider', () => {
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

vi.doMock('@/lib/auth-token', () => ({
  buildAuthToken: (...args: readonly unknown[]) => {
    buildAuthTokenCalls.push(args);
    return 'test-auth-token';
  },
}));

const servedCore = createServedBindingLog();

vi.doMock('@inkeep/open-knowledge-core/config/bind-config-doc', () =>
  servedCore.serve('@inkeep/open-knowledge-core/config/bind-config-doc', {
    bindConfigDoc: (_provider: unknown, scope: WriteScope) =>
      makeFakeConfigBinding(scope, scope === 'user' ? userHasSyncedSeed : false),
  }),
);

vi.doMock('@inkeep/open-knowledge-core/config/bind-okignore-doc', () =>
  servedCore.serve('@inkeep/open-knowledge-core/config/bind-okignore-doc', {
    bindOkignoreDoc: () => makeFakeOkignoreBinding(),
  }),
);

vi.doMock('@inkeep/open-knowledge-core/constants/cc1', () =>
  servedCore.serve('@inkeep/open-knowledge-core/constants/cc1', {
    CONFIG_DOC_NAME_USER: '__user__/config.yml',
    CONFIG_DOC_NAME_PROJECT: '__config__/project',
    CONFIG_DOC_NAME_PROJECT_LOCAL: '__local__/project',
    CONFIG_DOC_NAME_OKIGNORE: '__config__/okignore',
  }),
);

vi.doMock('@inkeep/open-knowledge-core/config/merge-layered', () =>
  servedCore.serve('@inkeep/open-knowledge-core/config/merge-layered', {
    mergeLayered: (user: unknown, project: unknown, projectLocal: unknown) => {
      mergeLayeredCalls.push([user, project, projectLocal]);
      return mergedConfig;
    },
  }),
);

vi.doMock('@inkeep/open-knowledge-core/i18n/browser-locale-provider', () =>
  servedCore.serve('@inkeep/open-knowledge-core/i18n/browser-locale-provider', {
    readBrowserLanguages: () => browserLanguages,
  }),
);

vi.doMock('@inkeep/open-knowledge-core/i18n/direction', () =>
  servedCore.serve('@inkeep/open-knowledge-core/i18n/direction', {
    localeDirection: (locale: string) => (locale === 'ar' || locale === 'ur' ? 'rtl' : 'ltr'),
  }),
);

vi.doMock('@inkeep/open-knowledge-core/i18n/locales', () =>
  servedCore.serve('@inkeep/open-knowledge-core/i18n/locales', {
    SUPPORTED_LOCALES: ['en', 'es'],
    AUTO_DETECTABLE_LOCALES: ['en', 'es'],
  }),
);

vi.doMock('@inkeep/open-knowledge-core/theme/theme-plugins', () =>
  servedCore.serve('@inkeep/open-knowledge-core/theme/theme-plugins', {
    resolveColorThemeSelection: (
      appearance?: { colorTheme?: string; colorThemeLight?: string; colorThemeDark?: string },
      themes: readonly { id: string }[] = [],
    ) => {
      const ids = new Set(themes.map((theme) => theme.id));
      const legacy = appearance?.colorTheme;
      const fallback = legacy && ids.has(legacy) ? legacy : 'default';
      const pick = (value: string | undefined) =>
        value === undefined ? fallback : ids.has(value) ? value : 'default';
      return {
        light: pick(appearance?.colorThemeLight),
        dark: pick(appearance?.colorThemeDark),
      };
    },
    renderThemeBlock: (selector: string, variant: string, tokens: Record<string, string>) =>
      `${selector}{color-scheme:${variant};${Object.entries(tokens)
        .map(([name, value]) => `--${name}:${value}`)
        .join(';')}}`,
    resolveModePreference: (preference?: string, prefersDark?: boolean) =>
      preference === 'light' || preference === 'dark' ? preference : prefersDark ? 'dark' : 'light',
    generateColorThemesCss: () => '',
    isDarkTheme: (id?: string) => Boolean(id) && id !== 'default' && id !== 'custom',
    resolveThemePlugin: (id?: string) => ({
      id: id ?? 'default',
      label: 'Default',
      kind: 'system',
    }),
    THEME_PLUGINS: [{ id: 'builtin-dusk', label: 'Dusk', kind: 'dark' }],
  }),
);

vi.doMock('@inkeep/open-knowledge-core/schemas/api', () =>
  servedCore.serve('@inkeep/open-knowledge-core/schemas/api', {
    SavedThemesListSuccessSchema: {
      safeParse: (value: unknown) => ({ success: true, data: value }),
    },
  }),
);

vi.doMock('@inkeep/open-knowledge-core/theme/base16', () =>
  servedCore.serve('@inkeep/open-knowledge-core/theme/base16', {
    base16ToTokens: (scheme: { palette: Record<string, string> }) => ({
      background: scheme.palette.base00,
      foreground: scheme.palette.base05,
    }),
  }),
);

let userHasSyncedSeed = false;

const { ConfigProvider, useConfigContext } = await import('./config-provider');
const { useSavedThemes } = await import('./saved-themes-client');
const { COLOR_THEME_PAIR_STORAGE_KEY, SAVED_THEME_STYLE_ID } = await import(
  './use-apply-config-color-theme'
);

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

let refreshSavedThemes: (() => Promise<void>) | null = null;

function SavedThemesRefreshProbe() {
  refreshSavedThemes = useSavedThemes().refresh;
  return null;
}

function syncAllConfigBindings(): void {
  act(() => {
    captures.get('user')?.syncedListener?.();
    captures.get('project')?.syncedListener?.();
    captures.get('project-local')?.syncedListener?.();
  });
}

describe('ConfigProvider — userSynced behavioral wiring (Tier-3)', () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeAll(async () => {
    await dynamicActivate('es');
    await dynamicActivate('en');
  });

  beforeEach(() => {
    resetCaptures();
    lastContext = null;
    refreshSavedThemes = null;
    userHasSyncedSeed = false;
    localStorage.clear();
    document.documentElement.className = '';
    document.documentElement.removeAttribute('data-color-theme');
    document.getElementById(SAVED_THEME_STYLE_ID)?.remove();
    __resetServerInstanceStoreForTests();
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(async () => {
    cleanup();
    consoleErrorSpy.mockRestore();
    globalThis.fetch = originalFetch;
    Reflect.deleteProperty(window, 'okDesktop');
    await dynamicActivate('en');
  });

  test('userSynced reads false until the binding fires its synced listener, then flips to true', () => {
    render(
      <ConfigProvider collabUrl="ws://test.invalid">
        <UserSyncedConsumer />
      </ConfigProvider>,
    );

    expect(screen.getByTestId('user-synced').textContent).toBe('false');

    const userEntry = captures.get('user');
    expect(userEntry?.syncedListener).not.toBeNull();

    act(() => {
      userEntry?.syncedListener?.();
    });

    expect(screen.getByTestId('user-synced').textContent).toBe('true');
  });

  test('the synced transition publishes the binding’s authoritative config atomically', () => {
    render(
      <ConfigProvider collabUrl="ws://test.invalid">
        <ConfigContextProbe />
      </ConfigProvider>,
    );

    const userEntry = captures.get('user');
    if (!userEntry) throw new Error('user binding capture missing');
    userEntry.config = { scope: 'user', appearance: { theme: 'dark' } };

    act(() => {
      userEntry.syncedListener?.();
    });

    expect(lastContext?.userSynced).toBe(true);
    expect(lastContext?.userConfig).toBe(userEntry.config);
  });

  test('userSynced reads true on first render when the binding has already synced at mount time', () => {
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

  test('withholds the Electron show-gate signal until config is authoritative', async () => {
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

    expect(useThemeBridgeCalls.at(-1)?.slice(0, 2)).toEqual([undefined, undefined]);

    syncAllConfigBindings();

    await waitFor(() => {
      expect(useThemeBridgeCalls.at(-1)?.slice(0, 2)).toEqual([bridge, 'system']);
    });

    expect(setThemeCalls).toEqual(['system']);
  });

  test('preserves the renderer theme while collaboration discovery is pending', () => {
    render(
      <ConfigProvider collabUrl={null}>
        <ConfigContextProbe />
      </ConfigProvider>,
    );

    expect(setThemeCalls).toEqual([]);
  });

  test.each([
    { preference: 'light', system: 'dark', slot: 'light', paletteMode: 'dark' },
    { preference: 'dark', system: 'light', slot: 'dark', paletteMode: 'light' },
    { preference: 'system', system: 'light', slot: 'light', paletteMode: 'dark' },
    { preference: 'system', system: 'dark', slot: 'dark', paletteMode: 'light' },
    { preference: undefined, system: 'light', slot: 'light', paletteMode: 'dark' },
    { preference: undefined, system: 'dark', slot: 'dark', paletteMode: 'light' },
  ] as const)(
    'keeps native preference $preference with system $system when the $slot slot paints $paletteMode and returns to Default',
    async ({ preference, system, slot, paletteMode }) => {
      systemTheme = system;
      const bridge = { nativeTheme: {} };
      Object.defineProperty(window, 'okDesktop', { configurable: true, value: bridge });
      const palette = Object.fromEntries(
        Array.from({ length: 16 }, (_, index) => [
          `base${index.toString(16).toUpperCase().padStart(2, '0')}`,
          paletteMode === 'dark' ? '#111111' : '#eeeeee',
        ]),
      );
      globalThis.fetch = vi.fn(async () =>
        Response.json({
          themes: [
            {
              ok: true,
              id: 'saved-cross-kind',
              filename: 'cross-kind.yaml',
              scheme: { name: 'Cross kind', variant: paletteMode, palette },
            },
          ],
          truncated: false,
        }),
      );
      mergedConfig = {
        appearance: {
          theme: preference,
          colorThemeLight: slot === 'light' ? 'saved-cross-kind' : 'default',
          colorThemeDark: slot === 'dark' ? 'saved-cross-kind' : 'default',
        },
      };
      const view = render(
        <ConfigProvider collabUrl="ws://test.invalid">
          <ConfigContextProbe />
        </ConfigProvider>,
      );
      syncAllConfigBindings();

      await waitFor(() => {
        expect(document.documentElement.getAttribute('data-color-theme')).toBe('saved-cross-kind');
      });
      expect(setThemeCalls.at(-1)).toBe(paletteMode);
      expect(useThemeBridgeCalls.at(-1)?.slice(0, 2)).toEqual([bridge, preference ?? 'system']);

      mergedConfig = { appearance: { theme: preference } };
      view.rerender(
        <ConfigProvider collabUrl="ws://test.invalid">
          <ConfigContextProbe />
        </ConfigProvider>,
      );

      expect(setThemeCalls.at(-1)).toBe(preference ?? 'system');
      expect(document.documentElement.hasAttribute('data-color-theme')).toBe(false);
      expect(useThemeBridgeCalls.at(-1)?.slice(0, 2)).toEqual([bridge, preference ?? 'system']);
    },
  );

  test('the merged interface language reaches Lingui, and only once the user layer has synced', async () => {
    mergedConfig = { appearance: { language: 'es' } };

    render(
      <ConfigProvider collabUrl="ws://test.invalid">
        <ConfigContextProbe />
      </ConfigProvider>,
    );

    await waitFor(() => {
      expect(mergeLayeredCalls.length).toBeGreaterThan(0);
    });
    expect(i18n.locale).toBe('en');

    act(() => {
      captures.get('user')?.syncedListener?.();
    });

    expect(i18n.locale).toBe('es');
  });

  test('the same unresolved preference is handed to the native-menu bridge', async () => {
    const bridge = { nativeTheme: {} };
    Object.defineProperty(window, 'okDesktop', { configurable: true, value: bridge });
    mergedConfig = { appearance: { language: 'system' } };

    render(
      <ConfigProvider collabUrl="ws://test.invalid">
        <ConfigContextProbe />
      </ConfigProvider>,
    );

    await waitFor(() => {
      expect(mergeLayeredCalls.length).toBeGreaterThan(0);
    });

    act(() => {
      captures.get('user')?.syncedListener?.();
    });

    await waitFor(() => {
      expect(useLanguageBridgeCalls.at(-1)).toEqual([bridge, 'system', true]);
    });
  });

  test('releases the Electron show gate with the authored preference while preserving cross-variant prepaint after a saved-theme list failure', async () => {
    const bridge = { nativeTheme: {} };
    Object.defineProperty(window, 'okDesktop', {
      configurable: true,
      value: bridge,
    });
    localStorage.setItem(
      COLOR_THEME_PAIR_STORAGE_KEY,
      JSON.stringify({
        pref: 'dark',
        light: { id: 'default', dark: false },
        dark: { id: 'saved-offline', dark: false, css: ':root { --background: #fafafa; }' },
      }),
    );
    document.documentElement.setAttribute('data-color-theme', 'saved-offline');
    const prepaintStyle = document.createElement('style');
    prepaintStyle.id = SAVED_THEME_STYLE_ID;
    prepaintStyle.textContent = ':root { --background: #fafafa; }';
    document.head.appendChild(prepaintStyle);
    globalThis.fetch = vi.fn(async () => Response.json({ error: 'offline' }, { status: 503 }));
    mergedConfig = {
      appearance: {
        theme: 'dark',
        colorThemeLight: 'saved-offline',
        colorThemeDark: 'saved-offline',
      },
    };

    render(
      <ConfigProvider collabUrl="ws://test.invalid">
        <ConfigContextProbe />
      </ConfigProvider>,
    );

    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalled());
    syncAllConfigBindings();

    await waitFor(() => {
      expect(useThemeBridgeCalls.at(-1)?.slice(0, 2)).toEqual([bridge, 'dark']);
    });
    expect(setThemeCalls).toEqual([]);
    expect(document.documentElement.getAttribute('data-color-theme')).toBe('saved-offline');
    expect(document.getElementById(SAVED_THEME_STYLE_ID)?.textContent).toContain('#fafafa');
  });

  test('a live same-id saved-theme edit invalidates the native chrome bridge', async () => {
    const bridge = { nativeTheme: {} };
    Object.defineProperty(window, 'okDesktop', {
      configurable: true,
      value: bridge,
    });
    const palette = Object.fromEntries(
      Array.from({ length: 16 }, (_, index) => {
        const slot = `base${index.toString(16).toUpperCase().padStart(2, '0')}`;
        return [slot, '#111111'];
      }),
    );
    let schemeName = 'Before';
    globalThis.fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            themes: [
              {
                ok: true,
                id: 'saved-active',
                filename: 'active.yaml',
                scheme: { name: schemeName, variant: 'light', palette },
              },
            ],
            truncated: false,
          }),
        ),
    );
    mergedConfig = {
      appearance: {
        theme: 'light',
        colorThemeLight: 'saved-active',
        colorThemeDark: 'default',
      },
    };

    render(
      <ConfigProvider collabUrl="ws://test.invalid">
        <ConfigContextProbe />
        <SavedThemesRefreshProbe />
      </ConfigProvider>,
    );
    syncAllConfigBindings();

    await waitFor(() => {
      expect(useThemeBridgeCalls.at(-1)?.[2]).toContain('Before');
    });
    const beforeKey = useThemeBridgeCalls.at(-1)?.[2];

    schemeName = 'After';
    await act(async () => {
      await refreshSavedThemes?.();
    });

    await waitFor(() => {
      expect(useThemeBridgeCalls.at(-1)?.[2]).toContain('After');
    });
    expect(useThemeBridgeCalls.at(-1)?.[2]).not.toBe(beforeKey);
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
    const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

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

  test('config bindings, CC1 doc names and the layer merge come from the core replacements', async () => {
    const since = servedCore.mark();
    const { unmount } = render(
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
    expect(lastContext?.merged).toBe(mergedConfig);
    unmount();
    expect(okignoreDisposed).toBe(true);

    for (const [specifier, member] of [
      ['@inkeep/open-knowledge-core/config/bind-config-doc', 'bindConfigDoc'],
      ['@inkeep/open-knowledge-core/config/bind-okignore-doc', 'bindOkignoreDoc'],
      ['@inkeep/open-knowledge-core/config/merge-layered', 'mergeLayered'],
      ['@inkeep/open-knowledge-core/constants/cc1', 'CONFIG_DOC_NAME_USER'],
      ['@inkeep/open-knowledge-core/constants/cc1', 'CONFIG_DOC_NAME_PROJECT'],
      ['@inkeep/open-knowledge-core/constants/cc1', 'CONFIG_DOC_NAME_PROJECT_LOCAL'],
      ['@inkeep/open-knowledge-core/constants/cc1', 'CONFIG_DOC_NAME_OKIGNORE'],
    ] as const) {
      expect(servedCore.readersOf(specifier, member, since)).toEqual(['lib/config-provider.tsx']);
    }
  });

  test('the interface language is resolved and applied through the core i18n replacements', async () => {
    document.documentElement.removeAttribute('lang');
    document.documentElement.removeAttribute('dir');
    mergedConfig = { appearance: { language: 'es' } };
    const since = servedCore.mark();
    render(
      <ConfigProvider collabUrl="ws://test.invalid">
        <ConfigContextProbe />
      </ConfigProvider>,
    );

    await waitFor(() => {
      expect(mergeLayeredCalls.length).toBeGreaterThan(0);
    });
    act(() => {
      captures.get('user')?.syncedListener?.();
    });

    expect(i18n.locale).toBe('es');
    await waitFor(() => {
      expect(document.documentElement.lang).toBe('es');
    });
    expect(document.documentElement.dir).toBe('ltr');
    for (const [specifier, member] of [
      ['@inkeep/open-knowledge-core/i18n/direction', 'localeDirection'],
      ['@inkeep/open-knowledge-core/i18n/browser-locale-provider', 'readBrowserLanguages'],
      ['@inkeep/open-knowledge-core/i18n/locales', 'SUPPORTED_LOCALES'],
      ['@inkeep/open-knowledge-core/i18n/locales', 'AUTO_DETECTABLE_LOCALES'],
    ] as const) {
      expect(servedCore.readersOf(specifier, member, since)).toEqual([
        'lib/use-apply-config-language.ts',
      ]);
    }
  });

  test('a saved color theme is listed, selected and painted through the core theme replacements', async () => {
    systemTheme = 'dark';
    const bridge = { nativeTheme: {} };
    Object.defineProperty(window, 'okDesktop', { configurable: true, value: bridge });
    const palette = Object.fromEntries(
      Array.from({ length: 16 }, (_, index) => [
        `base${index.toString(16).toUpperCase().padStart(2, '0')}`,
        '#111111',
      ]),
    );
    palette.base05 = '#eeeeee';
    globalThis.fetch = vi.fn(async () =>
      Response.json({
        themes: [
          {
            ok: true,
            id: 'saved-cross-kind',
            filename: 'cross-kind.yaml',
            scheme: { name: 'Cross kind', variant: 'dark', palette },
          },
        ],
        truncated: false,
      }),
    );
    mergedConfig = {
      appearance: {
        theme: 'light',
        colorThemeLight: 'saved-cross-kind',
        colorThemeDark: 'default',
      },
    };
    const since = servedCore.mark();
    render(
      <ConfigProvider collabUrl="ws://test.invalid">
        <ConfigContextProbe />
      </ConfigProvider>,
    );
    syncAllConfigBindings();

    await waitFor(() => {
      expect(document.documentElement.getAttribute('data-color-theme')).toBe('saved-cross-kind');
    });
    expect(setThemeCalls.at(-1)).toBe('dark');
    expect(useThemeBridgeCalls.at(-1)?.slice(0, 2)).toEqual([bridge, 'light']);
    expect(document.getElementById(SAVED_THEME_STYLE_ID)?.textContent).toBe(
      'html[data-color-theme]{color-scheme:dark;--background:#111111;--foreground:#eeeeee}',
    );

    const readers = (specifier: string, member: string) =>
      servedCore.readersOf(specifier, member, since);
    expect(
      readers('@inkeep/open-knowledge-core/schemas/api', 'SavedThemesListSuccessSchema'),
    ).toEqual(['lib/saved-themes-client.ts']);
    for (const member of [
      'THEME_PLUGINS',
      'resolveColorThemeSelection',
      'resolveModePreference',
      'resolveThemePlugin',
    ]) {
      expect(readers('@inkeep/open-knowledge-core/theme/theme-plugins', member)).toEqual([
        'lib/color-themes.ts',
      ]);
    }
    expect(readers('@inkeep/open-knowledge-core/theme/theme-plugins', 'renderThemeBlock')).toEqual([
      'lib/use-apply-config-color-theme.ts',
    ]);
    expect(readers('@inkeep/open-knowledge-core/theme/base16', 'base16ToTokens')).toEqual([
      'lib/color-themes.ts',
    ]);
  });

  test('a system language preference follows the browser languages the core i18n replacements serve', async () => {
    document.documentElement.removeAttribute('lang');
    browserLanguages = ['es-MX'];
    mergedConfig = { appearance: { language: 'system' } };
    const since = servedCore.mark();
    render(
      <ConfigProvider collabUrl="ws://test.invalid">
        <ConfigContextProbe />
      </ConfigProvider>,
    );

    await waitFor(() => {
      expect(mergeLayeredCalls.length).toBeGreaterThan(0);
    });
    act(() => {
      captures.get('user')?.syncedListener?.();
    });

    expect(i18n.locale).toBe('es');
    await waitFor(() => {
      expect(document.documentElement.lang).toBe('es');
    });
    for (const [specifier, member] of [
      ['@inkeep/open-knowledge-core/i18n/browser-locale-provider', 'readBrowserLanguages'],
      ['@inkeep/open-knowledge-core/i18n/locales', 'AUTO_DETECTABLE_LOCALES'],
    ] as const) {
      expect(servedCore.readersOf(specifier, member, since)).toEqual([
        'lib/use-apply-config-language.ts',
      ]);
    }
  });

  test('a built-in color theme from the core plugin replacement sets its own mode without a saved stylesheet', async () => {
    globalThis.fetch = vi.fn(async () => Response.json({ themes: [], truncated: false }));
    mergedConfig = {
      appearance: {
        theme: 'light',
        colorThemeLight: 'builtin-dusk',
        colorThemeDark: 'default',
      },
    };
    const since = servedCore.mark();
    render(
      <ConfigProvider collabUrl="ws://test.invalid">
        <ConfigContextProbe />
      </ConfigProvider>,
    );
    syncAllConfigBindings();

    await waitFor(() => {
      expect(document.documentElement.getAttribute('data-color-theme')).toBe('builtin-dusk');
    });
    expect(setThemeCalls.at(-1)).toBe('dark');
    expect(document.getElementById(SAVED_THEME_STYLE_ID)).toBeNull();
    expect(
      servedCore.readersOf(
        '@inkeep/open-knowledge-core/theme/theme-plugins',
        'THEME_PLUGINS',
        since,
      ),
    ).toEqual(['lib/color-themes.ts']);
  });
});
