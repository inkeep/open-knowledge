import type { ConfigPatch } from '@inkeep/open-knowledge-core/config/schema';
import type {
  OkMenuRendererSnapshot,
  OkUserConfigPatchResult,
  OkUserConfigSnapshot,
} from '@inkeep/open-knowledge-core/desktop-bridge';
import { I18nProvider } from '@lingui/react';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ThemeProvider } from 'next-themes';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { TooltipProvider } from '@/components/ui/tooltip';
import { dynamicActivate } from '@/lib/activate-locale';
import type { OkDesktopBridge } from '@/lib/desktop-bridge-types';
import { i18n } from '@/lib/i18n';

const { NavigatorApp } = await import('./NavigatorApp');

type WindowGlobals = { NodeFilter?: typeof NodeFilter; MutationObserver?: typeof MutationObserver };
type GlobalWithDomShims = typeof globalThis &
  WindowGlobals & { window?: WindowGlobals; ResizeObserver?: unknown };
const globalWithDomShims = globalThis as GlobalWithDomShims;
if (
  globalWithDomShims.NodeFilter === undefined &&
  globalWithDomShims.window?.NodeFilter !== undefined
) {
  globalWithDomShims.NodeFilter = globalWithDomShims.window.NodeFilter;
}
if (
  globalWithDomShims.MutationObserver === undefined &&
  globalWithDomShims.window?.MutationObserver !== undefined
) {
  globalWithDomShims.MutationObserver = globalWithDomShims.window.MutationObserver;
}
if (globalWithDomShims.ResizeObserver === undefined) {
  class NoopResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  globalWithDomShims.ResizeObserver = NoopResizeObserver;
}

const ASYNC_TIMEOUT_MS = 4000;

function mergePatch(target: Record<string, unknown>, patch: Record<string, unknown>) {
  for (const [key, value] of Object.entries(patch)) {
    const existing = target[key];
    if (
      value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      existing !== null &&
      typeof existing === 'object' &&
      !Array.isArray(existing)
    ) {
      mergePatch(existing as Record<string, unknown>, value as Record<string, unknown>);
    } else {
      target[key] = value;
    }
  }
  return target;
}

function applyPatchToText(text: string, patch: ConfigPatch): string {
  const doc = (parseYaml(text) as Record<string, unknown> | null) ?? {};
  return stringifyYaml(mergePatch(doc, patch as Record<string, unknown>));
}

function makeNavigatorBridge(
  initialText: string,
  options: { readError?: Error; integrationsMenuItem?: boolean } = {},
) {
  const changeListeners = new Set<(snapshot: OkUserConfigSnapshot) => void>();
  const patches: ConfigPatch[] = [];
  let diskText = initialText;
  const setThemeSource = vi.fn(async () => ({ ok: true as const }));
  const setLanguagePreference = vi.fn(async () => ({ ok: true as const }));
  const menuDispatch = vi.fn(async (request: { kind: string }) =>
    request.kind === 'query'
      ? ({
          recentProjects: [],
          spellCheckEnabled: true,
          showDevToolsMenu: false,
          canCheckForUpdates: false,
          canReconfigureMcpWiring: options.integrationsMenuItem === true,
        } as unknown as OkMenuRendererSnapshot)
      : undefined,
  );
  const bridge = {
    config: {
      collabUrl: '',
      apiOrigin: '',
      projectPath: '',
      projectName: 'Project Navigator',
      mode: 'navigator',
      themePreference: 'system',
    },
    appVersion: '1.2.3',
    platform: 'darwin',
    ...(options.integrationsMenuItem === undefined ? {} : { menu: { dispatch: menuDispatch } }),
    onMenuAction: () => () => {},
    state: { query: async () => ({ channel: 'latest' }) },
    onRecentRemovedMissing: () => () => {},
    setThemeSource,
    setLanguagePreference,
    signalThemeApplied: () => {},
    shell: { openExternal: async () => undefined },
    project: {
      listRecent: async () => [],
      removeRecent: async () => undefined,
      readHeadBranch: async () => ({ currentBranch: null, headSha: null, detached: false }),
    },
    dialog: { openFolder: async (): Promise<string | null> => null },
    userConfig: {
      read: async (): Promise<OkUserConfigSnapshot> => {
        if (options.readError) throw options.readError;
        return { text: diskText };
      },
      patch: async (patch: ConfigPatch): Promise<OkUserConfigPatchResult> => {
        patches.push(patch);
        diskText = applyPatchToText(diskText, patch);
        return { ok: true, text: diskText };
      },
      onChanged: (cb: (snapshot: OkUserConfigSnapshot) => void) => {
        changeListeners.add(cb);
        return () => changeListeners.delete(cb);
      },
    },
  } as unknown as OkDesktopBridge;
  return {
    bridge,
    patches,
    menuDispatch,
    setThemeSource,
    setLanguagePreference,
    emitChange: (text: string) => {
      diskText = text;
      act(() => {
        for (const cb of changeListeners) cb({ text });
      });
    },
  };
}

function renderNavigator(bridge: OkDesktopBridge, options: { asWindowBridge?: boolean } = {}) {
  if (options.asWindowBridge) {
    (window as unknown as { okDesktop?: OkDesktopBridge }).okDesktop = bridge;
  }
  return render(
    <I18nProvider i18n={i18n}>
      <ThemeProvider attribute="class" defaultTheme="system" enableSystem storageKey="ok-theme-v1">
        <TooltipProvider>
          <NavigatorApp bridge={bridge} />
        </TooltipProvider>
      </ThemeProvider>
    </I18nProvider>,
  );
}

function sidebarItem(id: string): HTMLButtonElement {
  return screen.getByTestId(`settings-sidebar-item-${id}`) as HTMLButtonElement;
}

function describedBy(el: HTMLElement): string {
  const ids = el.getAttribute('aria-describedby')?.split(' ') ?? [];
  return ids.map((id) => document.getElementById(id)?.textContent ?? '').join(' ');
}

describe('NavigatorApp settings', () => {
  let consoleWarnSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    localStorage.clear();
    document.documentElement.className = '';
    await act(async () => {
      await dynamicActivate('en');
    });
    consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    window.history.replaceState(null, '', '#settings');
  });

  afterEach(() => {
    cleanup();
    delete (window as unknown as { okDesktop?: OkDesktopBridge }).okDesktop;
    window.history.replaceState(null, '', '#');
    consoleWarnSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  test('the settings route opens Settings with only the user-level panes enabled', async () => {
    const stub = makeNavigatorBridge('', { integrationsMenuItem: true });
    renderNavigator(stub.bridge, { asWindowBridge: true });

    const dialog = await screen.findByTestId('settings-dialog', {}, { timeout: ASYNC_TIMEOUT_MS });
    expect(within(dialog).queryByText('Customize your OpenKnowledge experience.')).toBeNull();

    for (const id of ['preferences', 'hotkeys']) {
      expect(sidebarItem(id).disabled).toBe(false);
    }
    await waitFor(
      () =>
        expect(describedBy(sidebarItem('agent-connections'))).toBe(
          'Open a project to edit. To connect AI tools without a project, use File > Set up OpenKnowledge integrations…',
        ),
      { timeout: ASYNC_TIMEOUT_MS },
    );
    for (const id of [
      'account',
      'user-plugins-manage',
      'user-skills',
      'project-preferences',
      'sync',
    ]) {
      expect(sidebarItem(id).disabled).toBe(true);
      expect(sidebarItem(id).getAttribute('aria-disabled')).toBe('true');
      expect(describedBy(sidebarItem(id))).toBe('Open a project to edit.');
    }
    expect(screen.queryByTestId('settings-sidebar-item-plugin:theme')).toBeNull();
    expect(screen.queryByTestId('settings-sidebar-item-claude-desktop')).toBeNull();
    expect(sidebarItem('preferences').getAttribute('aria-current')).toBe('page');
  });

  test('an install without the integrations menu item does not point Agent connections at it', async () => {
    const stub = makeNavigatorBridge('', { integrationsMenuItem: false });
    renderNavigator(stub.bridge, { asWindowBridge: true });

    await screen.findByTestId('settings-dialog', {}, { timeout: ASYNC_TIMEOUT_MS });
    await waitFor(() => expect(stub.menuDispatch).toHaveBeenCalledWith({ kind: 'query' }), {
      timeout: ASYNC_TIMEOUT_MS,
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(sidebarItem('agent-connections').disabled).toBe(true);
    expect(describedBy(sidebarItem('agent-connections'))).toBe('Open a project to edit.');
    expect(screen.queryByText(/Set up OpenKnowledge integrations/)).toBeNull();
  });

  test('an unreadable user config shows a notice instead of loading forever, then recovers', async () => {
    const stub = makeNavigatorBridge('', { readError: new Error('EACCES: permission denied') });
    renderNavigator(stub.bridge);

    const notice = await screen.findByTestId(
      'settings-user-config-unavailable',
      {},
      { timeout: ASYNC_TIMEOUT_MS },
    );
    expect(notice.textContent).toContain('Your user settings could not be read');

    stub.emitChange('editor:\n  wordWrap: false\n');

    const wordWrap = await screen.findByRole(
      'switch',
      { name: 'Word wrap' },
      { timeout: ASYNC_TIMEOUT_MS },
    );
    expect(wordWrap.getAttribute('aria-checked')).toBe('false');
    expect(screen.queryByTestId('settings-user-config-unavailable')).toBeNull();
  });

  test('settings search skips panes that need a project', async () => {
    const stub = makeNavigatorBridge('');
    renderNavigator(stub.bridge);
    await screen.findByTestId('settings-dialog', {}, { timeout: ASYNC_TIMEOUT_MS });

    await userEvent.type(screen.getByTestId('settings-search-input'), 'Agent connections');

    expect(screen.queryByTestId('settings-search-result-section:agent-connections')).toBeNull();
  });

  test('changing a preference writes it to the user config', async () => {
    const stub = makeNavigatorBridge('');
    renderNavigator(stub.bridge);

    const wordWrap = await screen.findByRole(
      'switch',
      { name: 'Word wrap' },
      { timeout: ASYNC_TIMEOUT_MS },
    );
    await userEvent.click(wordWrap);

    await waitFor(() => expect(stub.patches).toContainEqual({ editor: { wordWrap: false } }), {
      timeout: ASYNC_TIMEOUT_MS,
    });
  });

  test('a theme and language picked in Settings apply live to the navigator', async () => {
    const user = userEvent.setup();
    const stub = makeNavigatorBridge('');
    renderNavigator(stub.bridge);
    await screen.findByTestId('settings-dialog', {}, { timeout: ASYNC_TIMEOUT_MS });

    await user.click(await screen.findByTestId('theme-picker-dark'));

    await waitFor(() => expect(stub.patches).toContainEqual({ appearance: { theme: 'dark' } }), {
      timeout: ASYNC_TIMEOUT_MS,
    });
    await waitFor(() => expect(document.documentElement.classList.contains('dark')).toBe(true), {
      timeout: ASYNC_TIMEOUT_MS,
    });
    await waitFor(() => expect(stub.setThemeSource).toHaveBeenLastCalledWith('dark'), {
      timeout: ASYNC_TIMEOUT_MS,
    });

    const languagePicker = screen.getByRole('combobox', { name: 'Language' });
    languagePicker.focus();
    await user.keyboard('{ArrowDown}');
    await user.click(await screen.findByRole('option', { name: 'français' }));

    await waitFor(() => expect(i18n.locale).toBe('fr'), { timeout: ASYNC_TIMEOUT_MS });
    expect(document.documentElement.lang).toBe('fr');
    await waitFor(() => expect(stub.setLanguagePreference).toHaveBeenLastCalledWith('fr'), {
      timeout: ASYNC_TIMEOUT_MS,
    });
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });

  test('a theme and language edited outside the navigator apply to it', async () => {
    const stub = makeNavigatorBridge('');
    renderNavigator(stub.bridge);
    await screen.findByTestId('settings-dialog', {}, { timeout: ASYNC_TIMEOUT_MS });

    stub.emitChange('appearance:\n  theme: dark\n  language: fr\n');

    await waitFor(() => expect(document.documentElement.classList.contains('dark')).toBe(true), {
      timeout: ASYNC_TIMEOUT_MS,
    });
    await waitFor(() => expect(i18n.locale).toBe('fr'), { timeout: ASYNC_TIMEOUT_MS });
    expect(document.documentElement.lang).toBe('fr');
    await waitFor(() => expect(stub.setThemeSource).toHaveBeenLastCalledWith('dark'), {
      timeout: ASYNC_TIMEOUT_MS,
    });
    await waitFor(() => expect(stub.setLanguagePreference).toHaveBeenLastCalledWith('fr'), {
      timeout: ASYNC_TIMEOUT_MS,
    });
  });
});
