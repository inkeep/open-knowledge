import { getParseHealth, resetParseHealth } from '@inkeep/open-knowledge-core';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ComponentProps, ReactNode } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { APP_HEADER_HEIGHT, AppHeader } from '@/components/AppHeader';
import { TooltipProvider } from '@/components/ui/tooltip';
import type { GitSyncStatus } from '@/hooks/use-git-sync-status';
import { ConfigContext } from '@/lib/config-context';
import {
  __resetPaneVisibilityStoreForTests,
  type PaneVisibility,
  paneVisibilityStore,
} from '@/lib/pane-visibility-store';
import {
  configContextWithTerminal,
  type ProjectTerminalSetting,
  TERMINAL_SETTING_UNSET,
} from '@/test-utils/config-context';
import {
  expectVisualClassTokens,
  expectVisualClassTokensAbsent,
} from '@/test-utils/visual-contract';

const searchRender = vi.hoisted(() => ({ throws: false }));
const shell = vi.hoisted(() => ({
  singleFile: false,
  activeDocName: 'docs/notes' as string | null,
  activeTarget: { kind: 'doc' } as unknown,
  syncStatus: null as Partial<GitSyncStatus> | null,
  syncToastHosts: 0,
}));

vi.mock('@/lib/single-file-mode', () => ({
  useSingleFileMode: () => shell.singleFile,
}));

vi.mock('@/editor/DocumentContext', () => ({
  useDocumentContext: () => ({
    activeDocName: shell.activeDocName,
    activeTarget: shell.activeTarget,
    activeProvider: null,
  }),
}));

vi.mock('@/hooks/use-git-sync-status', () => ({
  useGitSyncStatusDetailed: () => ({ status: shell.syncStatus, fetchError: null }),
  useGitSyncStatus: () => shell.syncStatus,
}));

vi.mock('@/presence/use-sync-toasts', async () => {
  const { useEffect } = await vi.importActual<typeof import('react')>('react');
  return {
    useSyncToasts: () => {
      useEffect(() => {
        shell.syncToastHosts += 1;
        return () => {
          shell.syncToastHosts -= 1;
        };
      }, []);
    },
  };
});

vi.mock('@/presence/PresenceBar', () => ({
  PresenceBar: () => <div data-testid="presence-bar" />,
}));

vi.mock('@/components/SyncStatusBadge', async () => ({
  ...(await vi.importActual<typeof import('@/components/SyncStatusBadge')>(
    '@/components/SyncStatusBadge',
  )),
  SyncStatusBadge: () => <div data-testid="sync-status-badge" />,
}));

vi.mock('@/components/HelpPopover', () => ({
  HelpPopover: () => <button type="button">Resources</button>,
}));

vi.mock('@/components/PublishToGitHubDialog', () => ({
  PublishToGitHubDialog: ({ open }: { open: boolean }) => (
    <div data-testid="publish-dialog" data-open={String(open)} />
  ),
}));

vi.mock('@/components/HeaderSearchBar', async () => {
  const actual = await vi.importActual<typeof import('@/components/HeaderSearchBar')>(
    '@/components/HeaderSearchBar',
  );
  return {
    ...actual,
    HeaderSearchBar: (props: ComponentProps<typeof actual.HeaderSearchBar>) => {
      if (searchRender.throws) throw new Error('search button render failed');
      return <actual.HeaderSearchBar {...props} />;
    },
  };
});

interface DesktopHostOptions {
  platform?: string;
  channel?: 'latest' | 'beta';
  instanceLabel?: string;
  menu?: { dispatch: (request: { kind: string }) => Promise<unknown> };
}

function setElectronHost(
  enabled: boolean,
  { platform, channel = 'latest', instanceLabel, menu }: DesktopHostOptions = {},
) {
  Object.defineProperty(window, 'okDesktop', {
    configurable: true,
    value: enabled
      ? {
          platform,
          instanceLabel,
          menu,
          config: {
            mode: 'editor',
            projectName: 'Field Notes',
            projectPath: '/projects/field-notes',
          },
          state: { query: () => Promise.resolve({ channel }) },
          project: { listRecent: () => Promise.resolve([]) },
          worktree: { list: () => Promise.resolve({ ok: false, reason: 'no-git' }) },
        }
      : undefined,
  });
}

const onOpenSearch = vi.fn(() => {});

let projectTerminal: ProjectTerminalSetting = TERMINAL_SETTING_UNSET;

function HeaderProviders({ children }: { children: ReactNode }) {
  return (
    <ConfigContext value={configContextWithTerminal(projectTerminal)}>
      <TooltipProvider>{children}</TooltipProvider>
    </ConfigContext>
  );
}

function renderHeader() {
  return render(<AppHeader onOpenSearch={onOpenSearch} />, { wrapper: HeaderProviders });
}

function centreGroup(): HTMLElement {
  return screen.getByRole('banner').querySelector('[data-app-header-center]') as HTMLElement;
}

function leadingGroup(): HTMLElement {
  return screen.getByRole('banner').querySelector('[data-app-header-leading]') as HTMLElement;
}

function trailingGroup(): HTMLElement {
  return screen.getByRole('banner').querySelector('[data-app-header-trailing]') as HTMLElement;
}

interface HeaderMetrics {
  header: number;
  leading: number;
  compactBadgeLeading?: number;
  badgeLabel?: number;
  badges?: { beta?: number; instance?: number };
  trailing: number;
  collapsedTrailing?: number;
  paneButton?: number;
  switcher?: number;
  switcherName?: number;
}

function mockHeaderMetrics(source: HeaderMetrics | (() => HeaderMetrics)) {
  const read = typeof source === 'function' ? source : () => source;
  const scrollWidth = vi
    .spyOn(Element.prototype, 'scrollWidth', 'get')
    .mockImplementation(function (this: Element) {
      const metrics = read();
      return this.hasAttribute('data-instance-badge-label') ? (metrics.badgeLabel ?? 0) : 0;
    });
  const offsetWidth = vi
    .spyOn(HTMLElement.prototype, 'offsetWidth', 'get')
    .mockImplementation(function (this: HTMLElement) {
      const metrics = read();
      if (this.hasAttribute('data-app-header')) return metrics.header;
      if (this.hasAttribute('data-app-header-leading')) {
        const badgeCompact = this.querySelector('[data-instance-badge-label].sr-only') !== null;
        const width =
          badgeCompact && metrics.compactBadgeLeading !== undefined
            ? metrics.compactBadgeLeading
            : metrics.leading;
        let foldedAway = 0;
        if (this.querySelector('[data-testid="beta-badge"]') === null) {
          foldedAway += metrics.badges?.beta ?? 0;
        }
        if (this.querySelector('[data-testid="instance-badge"]') === null) {
          foldedAway += metrics.badges?.instance ?? 0;
        }
        return width - foldedAway;
      }
      if (this.hasAttribute('data-app-header-badges')) {
        let width = 0;
        if (this.querySelector('[data-testid="beta-badge"]') !== null) {
          width += metrics.badges?.beta ?? 0;
        }
        if (this.querySelector('[data-testid="instance-badge"]') !== null) {
          const compact = this.querySelector('[data-instance-badge-label].sr-only') !== null;
          width += (metrics.badges?.instance ?? 0) - (compact ? (metrics.badgeLabel ?? 0) : 0);
        }
        return width;
      }
      if (this.hasAttribute('data-app-header-trailing')) {
        const collapsed =
          this.querySelector('[data-testid="header-overflow-actions-trigger"]') !== null;
        const paneRow =
          this.querySelectorAll('[data-testid^="header-pane-button-"]').length *
          (metrics.paneButton ?? 0);
        return (
          (collapsed && metrics.collapsedTrailing !== undefined
            ? metrics.collapsedTrailing
            : metrics.trailing) + paneRow
        );
      }
      if (this.getAttribute('data-testid') === 'project-switcher-trigger') {
        return metrics.switcher ?? 0;
      }
      if (this.getAttribute('data-testid') === 'project-switcher-name') {
        return metrics.switcherName ?? 0;
      }
      return 0;
    });
  return () => {
    offsetWidth.mockRestore();
    scrollWidth.mockRestore();
  };
}

function captureResizeObserver() {
  const observers: Array<{ callback: ResizeObserverCallback; targets: Set<Element> }> = [];
  const original = globalThis.ResizeObserver;
  class CapturingResizeObserver {
    private readonly entry: { callback: ResizeObserverCallback; targets: Set<Element> };
    constructor(callback: ResizeObserverCallback) {
      this.entry = { callback, targets: new Set<Element>() };
      observers.push(this.entry);
    }
    observe(target: Element) {
      this.entry.targets.add(target);
    }
    unobserve(target: Element) {
      this.entry.targets.delete(target);
    }
    disconnect() {
      this.entry.targets.clear();
    }
  }
  globalThis.ResizeObserver = CapturingResizeObserver as unknown as typeof ResizeObserver;
  return {
    flush(target?: Element) {
      for (const { callback, targets } of observers) {
        if (target !== undefined && !targets.has(target)) continue;
        act(() => {
          callback([], {} as ResizeObserver);
        });
      }
    },
    restore() {
      globalThis.ResizeObserver = original;
    },
  };
}

function overflowTrigger(): HTMLElement | null {
  return screen.queryByTestId('header-overflow-actions-trigger');
}

async function openOverflowPanel(): Promise<HTMLElement> {
  await userEvent.click(screen.getByTestId('header-overflow-actions-trigger'));
  return await waitFor(() => {
    const panel = document.querySelector('[data-header-overflow-actions]');
    expect(panel, 'the overflow trigger must open a panel').not.toBeNull();
    return panel as HTMLElement;
  });
}

const TRAILING_ACTION_QUERIES = [
  () => screen.queryByTestId('presence-bar'),
  () => screen.queryByRole('button', { name: /^Share / }),
  () => screen.queryByTestId('sync-status-badge'),
  () => screen.queryByRole('button', { name: 'Settings' }),
  () => screen.queryByRole('button', { name: 'Resources' }),
] as const;

const FOLDING_BADGES = '[data-testid="beta-badge"], [data-testid="instance-badge"]';

const PANE_HIDDEN: PaneVisibility = { open: false, onScreen: false };

function publishPanes({ terminal = true }: { terminal?: boolean } = {}) {
  act(() => {
    paneVisibilityStore.publish({
      editor: null,
      agents: PANE_HIDDEN,
      terminal: terminal ? PANE_HIDDEN : null,
    });
  });
}

function paneControls(): HTMLElement[] {
  return [
    screen.getByTestId('header-pane-divider'),
    screen.getByRole('button', { name: 'Agents' }),
    screen.getByRole('button', { name: 'Terminal' }),
  ];
}

const CRAMPED: HeaderMetrics = { header: 600, leading: 220, trailing: 420, collapsedTrailing: 44 };
const ROOMY: HeaderMetrics = { header: 1_280, leading: 220, trailing: 420 };
const BADGES_FOLD: HeaderMetrics = {
  header: 600,
  leading: 300,
  compactBadgeLeading: 200,
  badgeLabel: 100,
  badges: { beta: 40, instance: 150 },
  trailing: 480,
  collapsedTrailing: 44,
};
const BADGE_CRAMPED: HeaderMetrics = {
  header: 700,
  leading: 300,
  compactBadgeLeading: 200,
  badgeLabel: 100,
  trailing: 420,
};

function follows(earlier: Element, later: Element): boolean {
  return (earlier.compareDocumentPosition(later) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
}

afterEach(() => {
  cleanup();
  setElectronHost(false);
  onOpenSearch.mockClear();
  searchRender.throws = false;
  shell.activeDocName = 'docs/notes';
  shell.activeTarget = { kind: 'doc' };
  shell.syncStatus = null;
  shell.syncToastHosts = 0;
  shell.singleFile = false;
  __resetPaneVisibilityStoreForTests();
  projectTerminal = TERMINAL_SETTING_UNSET;
  vi.unstubAllGlobals();
});

describe('AppHeader', () => {
  test('a single-file window keeps global actions and the component selector above its cards', async () => {
    shell.singleFile = true;
    setElectronHost(true, { platform: 'win32', menu: { dispatch: async () => null } });
    act(() => {
      paneVisibilityStore.publish({
        editor: { open: true, onScreen: true },
        agents: PANE_HIDDEN,
        terminal: PANE_HIDDEN,
      });
    });
    renderHeader();

    expect(screen.getByRole('banner', { name: 'Application' })).toBeTruthy();
    expect(screen.getByTestId('presence-bar')).toBeTruthy();
    expect(screen.getByTestId('sync-status-badge')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Resources' })).toBeTruthy();
    expect(await screen.findByTestId('app-menubar')).toBeTruthy();
    expect(screen.getByRole('group', { name: 'Panels' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Editor' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Agents' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Terminal' })).toBeTruthy();
    expect(screen.queryByTestId('project-switcher-trigger')).toBeNull();
    expect(screen.queryByRole('button', { name: /^Search/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Share/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Settings' })).toBeNull();
    expect(screen.queryByTestId('publish-dialog')).toBeNull();
    expect(screen.queryByTestId('navigation-history-controls')).toBeNull();
  });

  test('a narrow single-file header folds secondary actions while keeping the selector visible', async () => {
    shell.singleFile = true;
    setElectronHost(true, { platform: 'win32' });
    publishPanes();
    const restoreMetrics = mockHeaderMetrics(CRAMPED);
    try {
      renderHeader();
      const trailing = trailingGroup();
      const trigger = screen.getByTestId('header-overflow-actions-trigger');
      const selector = screen.getByRole('group', { name: 'Panels' });
      expect(trailing.contains(selector)).toBe(true);
      expect(follows(trigger, selector)).toBe(true);
      const panel = await openOverflowPanel();
      expect(panel.contains(screen.getByRole('button', { name: 'Resources' }))).toBe(true);
      expect(panel.querySelector('[data-testid="presence-bar"]')).not.toBeNull();
      expect(panel.querySelector('[data-testid="sync-status-badge"]')).not.toBeNull();
      expect(panel.contains(selector)).toBe(false);
    } finally {
      restoreMetrics();
    }
  });

  test('exposes a single banner landmark with an accessible name', () => {
    renderHeader();

    const banners = screen.getAllByRole('banner');
    expect(banners).toHaveLength(1);
    expect(screen.getByRole('banner', { name: 'Application' })).toBe(banners[0]);
  });

  test('lays out a leading, centre and trailing group in reading order', () => {
    renderHeader();

    const header = screen.getByRole('banner');
    const groups = Array.from(header.children).map((child) =>
      child.getAttributeNames().find((name) => name.startsWith('data-app-header-')),
    );

    expect(groups).toEqual([
      'data-app-header-leading',
      'data-app-header-center',
      'data-app-header-trailing',
    ]);
  });

  test('takes its height from the app-header height property the shell publishes', () => {
    renderHeader();

    expectVisualClassTokens(screen.getByRole('banner').className, [
      `h-[var(--ok-app-header-height,${APP_HEADER_HEIGHT})]`,
    ]);
  });

  test('paints the shell chrome surface with no rule under it', () => {
    renderHeader();

    const header = screen.getByRole('banner');
    expectVisualClassTokens(header.className, ['bg-desk']);
    expectVisualClassTokensAbsent(header.className, [
      'bg-background',
      'shadow-[inset_0_-1px_0_var(--border)]',
    ]);
  });

  test('reserves the macOS window buttons plus a 10px gap at its leading edge', () => {
    renderHeader();

    expectVisualClassTokens(leadingGroup().className, [
      'ps-[calc(var(--ok-titlebar-reserve-left,0px)+0.625rem)]',
    ]);
  });

  test('is a window-drag region on Electron and opts its controls out of dragging', () => {
    setElectronHost(true);
    renderHeader();

    const header = screen.getByRole('banner');
    expect(header.getAttribute('data-electron-drag')).toBe('');
    expectVisualClassTokens(header.className, [
      '[-webkit-app-region:drag]',
      '[&_button]:[-webkit-app-region:no-drag]',
      '[&_a]:[-webkit-app-region:no-drag]',
    ]);
  });

  test('on Electron the pane buttons opt out of dragging and the divider beside them stays draggable', () => {
    setElectronHost(true);
    publishPanes();
    renderHeader();

    const header = screen.getByRole('banner');
    for (const name of ['Agents', 'Terminal']) {
      const button = screen.getByRole('button', { name });
      expect(header.contains(button)).toBe(true);
      expect(button.tagName, `${name} must be a <button> for the header's no-drag rule`).toBe(
        'BUTTON',
      );
    }
    const divider = screen.getByTestId('header-pane-divider');
    expect(header.contains(divider)).toBe(true);
    for (
      let node: HTMLElement | null = divider;
      node && node !== header;
      node = node.parentElement
    ) {
      expect(['BUTTON', 'A']).not.toContain(node.tagName);
      expectVisualClassTokensAbsent(node.className, ['[-webkit-app-region:no-drag]']);
    }
  });

  test('reserves the Windows caption-button inset at its trailing edge on Electron', () => {
    setElectronHost(true, { platform: 'win32' });
    renderHeader();

    const trailing = screen.getByRole('banner').querySelector('[data-app-header-trailing]');
    expectVisualClassTokens(trailing?.className, ['me-[var(--ok-titlebar-reserve-right,0px)]']);
  });

  test('claims no drag region on a web host', () => {
    renderHeader();

    const header = screen.getByRole('banner');
    expect(header.getAttribute('data-electron-drag')).toBeNull();
    expectVisualClassTokensAbsent(header.className, ['[-webkit-app-region:drag]']);
    expectVisualClassTokensAbsent(header.querySelector('[data-app-header-trailing]')?.className, [
      'me-[var(--ok-titlebar-reserve-right,0px)]',
    ]);
  });

  describe('leading group', () => {
    test('puts back, forward and search in the leading group, in that order, on desktop', () => {
      setElectronHost(true);
      renderHeader();

      const leading = leadingGroup();
      const back = screen.getByRole('button', { name: 'Back' });
      const forward = screen.getByRole('button', { name: 'Forward' });
      const search = screen.getByRole('button', { name: 'Search' });

      expect(leading.contains(back)).toBe(true);
      expect(leading.contains(forward)).toBe(true);
      expect(leading.contains(search)).toBe(true);
      expect(follows(back, forward)).toBe(true);
      expect(follows(forward, search)).toBe(true);
    });

    test('a web host gets search alone, with no navigation history', () => {
      renderHeader();

      expect(leadingGroup().contains(screen.getByRole('button', { name: 'Search' }))).toBe(true);
      expect(screen.queryByRole('button', { name: 'Back' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Forward' })).toBeNull();
    });

    test('search opens the command palette and keeps its shortcut hint', async () => {
      const user = userEvent.setup();
      renderHeader();

      const search = screen.getByRole('button', { name: 'Search' });
      await user.hover(search);
      const tooltip = await screen.findByRole('tooltip');
      expect(tooltip.querySelector('[data-slot="kbd"]')).not.toBeNull();

      await user.click(search);
      expect(onOpenSearch).toHaveBeenCalledTimes(1);
    });

    test.each([
      { channel: 'latest', instanceLabel: undefined, expected: [] },
      { channel: 'beta', instanceLabel: undefined, expected: ['beta-badge'] },
      { channel: 'latest', instanceLabel: 'wt-header', expected: ['instance-badge'] },
      { channel: 'beta', instanceLabel: 'wt-header', expected: ['beta-badge', 'instance-badge'] },
    ] as const)(
      'channel $channel with instance label $instanceLabel shows $expected after search',
      async ({ channel, instanceLabel, expected }) => {
        setElectronHost(true, { channel, instanceLabel });
        renderHeader();

        const search = screen.getByRole('button', { name: 'Search' });
        const searchSlot = Array.from(leadingGroup().children).find((child) =>
          child.contains(search),
        ) as Element;
        await waitFor(() => {
          const badges = Array.from(leadingGroup().querySelectorAll('[data-testid$="-badge"]'));
          expect(badges.map((badge) => badge.getAttribute('data-testid'))).toEqual(expected);
        });
        const badgeGroup = searchSlot.nextElementSibling;
        expect(badgeGroup, 'the badge group must follow search').not.toBeNull();
        expect(badgeGroup?.nextElementSibling ?? null).toBeNull();
        expect(
          Array.from(badgeGroup?.children ?? []).map((badge) => badge.getAttribute('data-testid')),
        ).toEqual(expected);
      },
    );

    test('on Windows the app menu leads the header, before search and the badges, and opens from it', async () => {
      const user = userEvent.setup();
      const dispatch = vi.fn((request: { kind: string }) =>
        Promise.resolve(request.kind === 'query' ? null : undefined),
      );
      setElectronHost(true, {
        platform: 'win32',
        channel: 'beta',
        instanceLabel: 'wt-header',
        menu: { dispatch },
      });
      renderHeader();

      const menubar = await screen.findByTestId('app-menubar');
      expect(leadingGroup().firstElementChild).toBe(menubar);
      expect(follows(menubar, screen.getByRole('button', { name: 'Search' }))).toBe(true);
      expect(follows(menubar, await screen.findByTestId('beta-badge'))).toBe(true);
      expect(follows(menubar, screen.getByTestId('instance-badge'))).toBe(true);

      await user.click(screen.getByRole('menuitem', { name: 'File' }));
      expect(await screen.findByRole('menuitem', { name: /^New file/ })).toBeTruthy();
      expect(dispatch).toHaveBeenCalledWith({ kind: 'query' });
    });

    test('macOS leaves the app menu to the native menu bar', async () => {
      setElectronHost(true, {
        platform: 'darwin',
        menu: { dispatch: () => Promise.resolve(null) },
      });
      renderHeader();

      await screen.findByRole('button', { name: 'Search' });
      expect(screen.queryByTestId('app-menubar')).toBeNull();
    });

    test('a search button render failure is counted and leaves the rest of the header standing', () => {
      resetParseHealth();
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
      const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      searchRender.throws = true;
      setElectronHost(true);
      try {
        renderHeader();

        expect(screen.queryByRole('button', { name: 'Search' })).toBeNull();
        expect(screen.getByRole('button', { name: 'Back' })).toBeTruthy();
        expect(screen.getByRole('banner', { name: 'Application' })).toBeTruthy();
        expect(getParseHealth().jsxRenderFailure.headerSearchPill).toBe(1);
      } finally {
        consoleError.mockRestore();
        consoleWarn.mockRestore();
      }
    });

    test('the search button comes back once the open document changes', () => {
      resetParseHealth();
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
      const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      searchRender.throws = true;
      setElectronHost(true);
      try {
        const rendered = renderHeader();
        expect(screen.queryByRole('button', { name: 'Search' })).toBeNull();

        searchRender.throws = false;
        shell.activeDocName = 'docs/other';
        rendered.rerender(<AppHeader onOpenSearch={onOpenSearch} />);

        expect(
          screen.queryByRole('button', { name: 'Search' }),
          'one render failure removed the search button for the life of the window',
        ).not.toBeNull();
      } finally {
        consoleError.mockRestore();
        consoleWarn.mockRestore();
      }
    });
  });

  describe('centre track', () => {
    test('holds the project switcher, named for the open project, on desktop', () => {
      setElectronHost(true);
      renderHeader();

      const trigger = screen.getByRole('button', { name: 'Open project menu' });
      expect(centreGroup().contains(trigger)).toBe(true);
      expect(trigger.textContent).toContain('Field Notes');
    });

    test('stays empty on a web host', () => {
      renderHeader();

      expect(centreGroup().children).toHaveLength(0);
      expect(screen.queryByRole('button', { name: 'Open project menu' })).toBeNull();
    });
  });

  describe('trailing group', () => {
    test('holds presence, Share, sync, settings and resources, then a divider and the Agents and Terminal buttons, in that order', () => {
      shell.syncStatus = { state: 'idle', conflictCount: 0, hasRemote: true };
      publishPanes();
      renderHeader();

      const controls = [...TRAILING_ACTION_QUERIES.map((query) => query()), ...paneControls()];
      for (const control of controls) {
        expect(control).not.toBeNull();
        expect(trailingGroup().contains(control)).toBe(true);
      }
      for (let index = 1; index < controls.length; index += 1) {
        expect(follows(controls[index - 1] as Element, controls[index] as Element)).toBe(true);
      }
    });

    test('Share opens the publish dialog from the header when the project has no remote', async () => {
      const user = userEvent.setup();
      shell.syncStatus = { state: 'idle', conflictCount: 0, hasRemote: false };
      renderHeader();

      expect(screen.getByTestId('publish-dialog').getAttribute('data-open')).toBe('false');
      await user.click(screen.getByRole('button', { name: 'Share doc' }));

      expect(screen.getByTestId('publish-dialog').getAttribute('data-open')).toBe('true');
      expect(trailingGroup().contains(screen.getByTestId('publish-dialog'))).toBe(true);
    });

    test.each([
      {
        target: 'an open doc',
        activeDocName: 'docs/notes',
        activeTarget: { kind: 'doc' },
        button: 'Share doc',
        request: { kind: 'doc', docPath: 'docs/notes.md' },
      },
      {
        target: 'a selected folder',
        activeDocName: null,
        activeTarget: { kind: 'folder', folderPath: 'guides' },
        button: 'Share folder',
        request: { kind: 'folder', folderPath: 'guides' },
      },
      {
        target: 'nothing open or selected',
        activeDocName: null,
        activeTarget: null,
        button: 'Share folder',
        request: { kind: 'folder', folderPath: '' },
      },
    ])(
      'Share asks for a link to $target',
      async ({ activeDocName, activeTarget, button, request }) => {
        const user = userEvent.setup();
        const requests: unknown[] = [];
        vi.stubGlobal(
          'fetch',
          vi.fn(async (_url: string, init?: RequestInit) => {
            requests.push(JSON.parse(String(init?.body)));
            return new Response('unavailable', { status: 503 });
          }),
        );
        shell.activeDocName = activeDocName;
        shell.activeTarget = activeTarget;
        shell.syncStatus = { state: 'idle', conflictCount: 0, hasRemote: true };
        renderHeader();

        await user.click(screen.getByRole('button', { name: button }));

        await waitFor(() => expect(requests).toEqual([request]));
      },
    );

    test.each([
      {
        target: 'a skill or template',
        activeDocName: '__skill__/project/my-skill',
        activeTarget: { kind: 'doc' },
      },
      {
        target: 'an asset',
        activeDocName: null,
        activeTarget: { kind: 'asset', assetPath: 'img/logo.png' },
      },
    ])('Share stays disabled for $target', ({ activeDocName, activeTarget }) => {
      shell.activeDocName = activeDocName;
      shell.activeTarget = activeTarget;
      renderHeader();

      const share = within(trailingGroup()).getByRole('button', { name: /^Share / });
      expect((share as HTMLButtonElement).disabled).toBe(true);
    });

    test('mounts the sync-toast machine exactly once, outside the collapsible group', () => {
      const restoreMetrics = mockHeaderMetrics(CRAMPED);
      try {
        renderHeader();

        expect(overflowTrigger()).not.toBeNull();
        expect(screen.queryByTestId('presence-bar')).toBeNull();
        expect(shell.syncToastHosts).toBe(1);
      } finally {
        restoreMetrics();
      }
    });
  });

  describe('collapse', () => {
    test('when the trailing group does not fit, its five controls go behind "More actions" and the leading group keeps everything but the BETA and instance badges', async () => {
      setElectronHost(true, {
        platform: 'win32',
        channel: 'beta',
        instanceLabel: 'wt-header',
        menu: { dispatch: () => Promise.resolve(null) },
      });
      shell.syncStatus = { state: 'idle', conflictCount: 0, hasRemote: true };
      const restoreMetrics = mockHeaderMetrics(CRAMPED);
      try {
        renderHeader();

        const trigger = overflowTrigger();
        expect(trigger).not.toBeNull();
        expect(trailingGroup().contains(trigger)).toBe(true);
        for (const query of TRAILING_ACTION_QUERIES) expect(query()).toBeNull();
        const staying = [
          await screen.findByTestId('app-menubar'),
          ...['Back', 'Forward', 'Search'].map((name) => screen.getByRole('button', { name })),
        ];
        for (const control of staying) expect(leadingGroup().contains(control)).toBe(true);

        const panel = await openOverflowPanel();
        for (const query of TRAILING_ACTION_QUERIES) {
          expect(panel.contains(query())).toBe(true);
        }
        expect(panel.contains(await screen.findByTestId('beta-badge'))).toBe(true);
        expect(panel.contains(screen.getByTestId('instance-badge'))).toBe(true);
        for (const control of staying) {
          expect(panel.contains(control)).toBe(false);
          expect(leadingGroup().contains(control)).toBe(true);
        }
      } finally {
        restoreMetrics();
      }
    });

    test('the panel behind "More actions" is a dialog announced by that name, even while sync needs attention', async () => {
      shell.syncStatus = { state: 'conflict', conflictCount: 1, hasRemote: true };
      const restoreMetrics = mockHeaderMetrics(CRAMPED);
      try {
        renderHeader();

        const panel = await openOverflowPanel();
        expect(screen.getByRole('dialog', { name: 'More actions' })).toBe(panel);
      } finally {
        restoreMetrics();
      }
    });

    test('when folded, the divider and the pane buttons stay in the header after "More actions" and out of its panel, and keep their place when room returns', async () => {
      shell.syncStatus = { state: 'idle', conflictCount: 0, hasRemote: true };
      publishPanes();
      const observer = captureResizeObserver();
      let restoreMetrics = mockHeaderMetrics({ ...CRAMPED, paneButton: 28 });
      try {
        renderHeader();

        const trigger = overflowTrigger() as HTMLElement;
        expect(trigger).not.toBeNull();
        for (const control of paneControls()) {
          expect(trailingGroup().contains(control)).toBe(true);
          expect(follows(trigger, control)).toBe(true);
        }
        const panel = await openOverflowPanel();
        for (const query of TRAILING_ACTION_QUERIES) {
          expect(panel.contains(query())).toBe(true);
        }
        for (const control of paneControls()) {
          expect(panel.contains(control)).toBe(false);
        }

        restoreMetrics();
        restoreMetrics = mockHeaderMetrics({ ...ROOMY, paneButton: 28 });
        observer.flush();

        expect(overflowTrigger()).toBeNull();
        const controls = [...TRAILING_ACTION_QUERIES.map((query) => query()), ...paneControls()];
        for (const control of controls) {
          expect(trailingGroup().contains(control)).toBe(true);
        }
        for (let index = 1; index < controls.length; index += 1) {
          expect(follows(controls[index - 1] as Element, controls[index] as Element)).toBe(true);
        }
      } finally {
        restoreMetrics();
        observer.restore();
      }
    });

    test.each(['win32', 'linux'] as const)(
      'on %s a folded header moves the BETA and instance badges into "More actions", and they return to the leading group when room returns',
      async (platform) => {
        setElectronHost(true, { platform, channel: 'beta', instanceLabel: 'wt-header' });
        const observer = captureResizeObserver();
        let restoreMetrics = mockHeaderMetrics(BADGES_FOLD);
        try {
          renderHeader();

          expect(overflowTrigger()).not.toBeNull();
          expect(leadingGroup().querySelector(FOLDING_BADGES)).toBeNull();
          const panel = await openOverflowPanel();
          expect(panel.contains(await screen.findByTestId('beta-badge'))).toBe(true);
          const folded = screen.getByTestId('instance-badge');
          expect(panel.contains(folded)).toBe(true);
          expectVisualClassTokensAbsent(
            folded.querySelector('[data-instance-badge-label]')?.className,
            ['sr-only'],
          );

          restoreMetrics();
          restoreMetrics = mockHeaderMetrics({ ...BADGES_FOLD, header: 1_280 });
          observer.flush();

          expect(overflowTrigger()).toBeNull();
          const beta = await screen.findByTestId('beta-badge');
          const instance = screen.getByTestId('instance-badge');
          expect(leadingGroup().contains(beta)).toBe(true);
          expect(leadingGroup().contains(instance)).toBe(true);
          expect(follows(screen.getByRole('button', { name: 'Search' }), beta)).toBe(true);
          expect(follows(beta, instance)).toBe(true);
        } finally {
          restoreMetrics();
          observer.restore();
        }
      },
    );

    test('on macOS a folded header keeps the BETA and instance badges in the leading group', async () => {
      setElectronHost(true, { platform: 'darwin', channel: 'beta', instanceLabel: 'wt-header' });
      const restoreMetrics = mockHeaderMetrics(CRAMPED);
      try {
        renderHeader();

        expect(overflowTrigger()).not.toBeNull();
        const beta = await screen.findByTestId('beta-badge');
        expect(leadingGroup().contains(beta)).toBe(true);
        expect(leadingGroup().contains(screen.getByTestId('instance-badge'))).toBe(true);
        const panel = await openOverflowPanel();
        expect(panel.querySelector(FOLDING_BADGES)).toBeNull();
      } finally {
        restoreMetrics();
      }
    });

    test('on macOS a folded single-file header moves the BETA and instance badges into its overflow', async () => {
      shell.singleFile = true;
      setElectronHost(true, { platform: 'darwin', channel: 'beta', instanceLabel: 'wt-header' });
      publishPanes();
      const restoreMetrics = mockHeaderMetrics(CRAMPED);
      try {
        renderHeader();

        expect(overflowTrigger()).not.toBeNull();
        const panel = await openOverflowPanel();
        expect(panel.contains(await screen.findByTestId('beta-badge'))).toBe(true);
        expect(panel.contains(screen.getByTestId('instance-badge'))).toBe(true);
        expect(leadingGroup().querySelector(FOLDING_BADGES)).toBeNull();
      } finally {
        restoreMetrics();
      }
    });

    test.each([
      { path: 'straight from a roomy header', widths: [600] },
      { path: 'after the instance badge shrank to its icon', widths: [680, 600] },
    ])(
      'with the badges folded out of the leading group $path, the fold holds though the leading group got narrower',
      async ({ widths }) => {
        setElectronHost(true, { platform: 'win32', channel: 'beta', instanceLabel: 'wt-header' });
        const observer = captureResizeObserver();
        let headerWidth = 1_280;
        const restoreMetrics = mockHeaderMetrics(() => ({
          ...BADGES_FOLD,
          header: headerWidth,
          trailing: 420,
        }));
        try {
          renderHeader();
          await waitFor(() =>
            expect(leadingGroup().contains(screen.queryByTestId('beta-badge'))).toBe(true),
          );
          observer.flush();
          expect(overflowTrigger()).toBeNull();

          for (const width of widths) {
            headerWidth = width;
            observer.flush();
          }
          expect(overflowTrigger()).not.toBeNull();
          expect(leadingGroup().querySelector(FOLDING_BADGES)).toBeNull();

          for (const pass of [1, 2, 3]) {
            observer.flush();
            expect(
              overflowTrigger(),
              `re-measurement pass ${pass} unfolded the header because the folded badges no longer counted against the room`,
            ).not.toBeNull();
          }
        } finally {
          restoreMetrics();
          observer.restore();
        }
      },
    );

    test('when room returns the five come back out and the trigger goes', () => {
      shell.syncStatus = { state: 'idle', conflictCount: 0, hasRemote: true };
      const observer = captureResizeObserver();
      let restoreMetrics = mockHeaderMetrics(CRAMPED);
      try {
        renderHeader();
        expect(overflowTrigger()).not.toBeNull();

        restoreMetrics();
        restoreMetrics = mockHeaderMetrics(ROOMY);
        observer.flush();

        expect(overflowTrigger()).toBeNull();
        for (const query of TRAILING_ACTION_QUERIES) {
          expect(trailingGroup().contains(query())).toBe(true);
        }
      } finally {
        restoreMetrics();
        observer.restore();
      }
    });

    test('keeps the trailing group inline when it fits', () => {
      const restoreMetrics = mockHeaderMetrics(ROOMY);
      try {
        renderHeader();

        expect(overflowTrigger()).toBeNull();
        expect(trailingGroup().contains(screen.getByRole('button', { name: 'Settings' }))).toBe(
          true,
        );
      } finally {
        restoreMetrics();
      }
    });

    test('never collapses while the header is unmeasured', () => {
      const restoreMetrics = mockHeaderMetrics({ ...CRAMPED, header: 0 });
      try {
        renderHeader();

        expect(overflowTrigger()).toBeNull();
      } finally {
        restoreMetrics();
      }
    });

    test('the room left for the trailing group keeps the project switcher its icons, whatever the project is called', () => {
      setElectronHost(true);
      const verdicts = [110, 400].map((switcherName) => {
        const restoreMetrics = mockHeaderMetrics({
          header: 700,
          leading: 220,
          trailing: 420,
          switcher: switcherName + 64,
          switcherName,
        });
        try {
          renderHeader();
          return overflowTrigger() !== null;
        } finally {
          restoreMetrics();
          cleanup();
        }
      });

      expect(
        verdicts,
        'reserving the switcher icons leaves 416px, too little for a 420px group',
      ).toEqual([true, true]);
    });

    test('a group that fits beside the leading group and the switcher icons stays inline', () => {
      setElectronHost(true);
      const restoreMetrics = mockHeaderMetrics({
        header: 760,
        leading: 220,
        trailing: 420,
        switcher: 464,
        switcherName: 400,
      });
      try {
        renderHeader();

        expect(overflowTrigger()).toBeNull();
      } finally {
        restoreMetrics();
      }
    });

    test('counts the Windows caption-button inset against the room', () => {
      setElectronHost(true, { platform: 'win32' });
      const realGetComputedStyle = window.getComputedStyle.bind(window);
      const computedStyle = vi
        .spyOn(window, 'getComputedStyle')
        .mockImplementation((element: Element, pseudo?: string | null) => {
          const style = realGetComputedStyle(element, pseudo);
          if (element instanceof HTMLElement && element.hasAttribute('data-app-header-trailing')) {
            return new Proxy(style, {
              get: (target, property) =>
                property === 'marginInlineEnd' ? '138px' : Reflect.get(target, property),
            }) as CSSStyleDeclaration;
          }
          return style;
        });
      const restoreMetrics = mockHeaderMetrics({ header: 760, leading: 220, trailing: 420 });
      try {
        renderHeader();

        expect(
          overflowTrigger(),
          '420px of controls plus a 138px caption-button inset does not fit in 540px',
        ).not.toBeNull();
      } finally {
        restoreMetrics();
        computedStyle.mockRestore();
      }
    });

    test('an Electron host keeps the build label hoverable inside the draggable header', () => {
      setElectronHost(true, { instanceLabel: 'wt-header' });
      renderHeader();
      const header = screen.getByRole('banner');
      const badge = screen.getByTestId('instance-badge');

      expect(header.contains(badge)).toBe(true);
      expectVisualClassTokens(header.className, ['[-webkit-app-region:drag]']);
      expectVisualClassTokens(badge.className, ['[-webkit-app-region:no-drag]']);
    });

    test('when only the instance badge does not fit, it shrinks to its icon and the trailing group stays inline', () => {
      setElectronHost(true, { instanceLabel: 'wt-header' });
      const observer = captureResizeObserver();
      const restoreMetrics = mockHeaderMetrics(BADGE_CRAMPED);
      try {
        renderHeader();
        const badge = screen.getByTestId('instance-badge');

        for (const pass of [1, 2, 3]) {
          observer.flush();
          expectVisualClassTokens(badge.querySelector('[data-instance-badge-label]')?.className, [
            'sr-only',
          ]);
          expect(
            overflowTrigger(),
            `re-measurement pass ${pass} folded the trailing group though the compact badge left room for it`,
          ).toBeNull();
        }
        expect(within(badge).getByText('App instance: wt-header').classList).toContain('sr-only');
      } finally {
        restoreMetrics();
        observer.restore();
      }
    });

    test('the pass that shrinks the instance badge already counts the room it frees', () => {
      setElectronHost(true, { instanceLabel: 'wt-header' });
      const observer = captureResizeObserver();
      const restoreMetrics = mockHeaderMetrics(BADGE_CRAMPED);
      try {
        renderHeader();

        expectVisualClassTokens(
          screen.getByTestId('instance-badge').querySelector('[data-instance-badge-label]')
            ?.className,
          ['sr-only'],
        );
        expect(
          overflowTrigger(),
          'the first paint folded the trailing group at a width where the compact badge leaves room for it',
        ).toBeNull();
      } finally {
        restoreMetrics();
        observer.restore();
      }
    });

    test('a centre that fills in after mount re-drives the collapse verdict', () => {
      setElectronHost(true);
      const observer = captureResizeObserver();
      let centreWidth = 0;
      const restoreMetrics = mockHeaderMetrics(() => ({
        header: 700,
        leading: 220,
        trailing: 420,
        collapsedTrailing: 44,
        switcher: centreWidth,
        switcherName: centreWidth > 0 ? 100 : 0,
      }));
      try {
        renderHeader();
        expect(overflowTrigger()).toBeNull();

        centreWidth = 300;
        observer.flush(centreGroup());

        expect(
          overflowTrigger(),
          'the centre grew after mount and nothing re-measured, so the header kept the verdict it computed for an empty centre',
        ).not.toBeNull();
      } finally {
        restoreMetrics();
        observer.restore();
      }
    });

    test('the instance badge keeps its name while the header has room for it', () => {
      setElectronHost(true, { instanceLabel: 'wt-header' });
      const observer = captureResizeObserver();
      const restoreMetrics = mockHeaderMetrics({ ...BADGE_CRAMPED, header: 1_280 });
      try {
        renderHeader();
        observer.flush();

        expectVisualClassTokensAbsent(
          screen.getByTestId('instance-badge').querySelector('[data-instance-badge-label]')
            ?.className,
          ['sr-only'],
        );
        expect(overflowTrigger()).toBeNull();
      } finally {
        restoreMetrics();
        observer.restore();
      }
    });

    test('a collapsed group stays collapsed when its own collapsed width is re-measured', () => {
      const observer = captureResizeObserver();
      const restoreMetrics = mockHeaderMetrics(CRAMPED);
      try {
        renderHeader();
        expect(overflowTrigger()).not.toBeNull();

        for (const pass of [1, 2, 3]) {
          observer.flush();
          expect(
            overflowTrigger(),
            `re-measurement pass ${pass} re-expanded the group though the room never changed`,
          ).not.toBeNull();
        }
      } finally {
        restoreMetrics();
        observer.restore();
      }
    });

    test('re-measures the remembered width when the trailing content changes', async () => {
      const observer = captureResizeObserver();
      shell.syncStatus = { state: 'idle', conflictCount: 0, hasRemote: true };
      let restoreMetrics = mockHeaderMetrics(CRAMPED);
      try {
        const view = renderHeader();
        expect(overflowTrigger()).not.toBeNull();

        restoreMetrics();
        restoreMetrics = mockHeaderMetrics({ ...CRAMPED, trailing: 200 });
        shell.syncStatus = { state: 'offline', conflictCount: 0, hasRemote: true };
        view.rerender(<AppHeader onOpenSearch={onOpenSearch} />);

        await waitFor(() => expect(overflowTrigger()).toBeNull());
        observer.flush();
        expect(overflowTrigger()).toBeNull();
      } finally {
        restoreMetrics();
        observer.restore();
      }
    });

    test('a pane button that goes while folded resets the remembered width, and the header unfolds and stays unfolded', () => {
      const observer = captureResizeObserver();
      publishPanes();
      const restoreMetrics = mockHeaderMetrics({
        header: 600,
        leading: 220,
        trailing: 300,
        collapsedTrailing: 44,
        paneButton: 40,
      });
      try {
        renderHeader();
        expect(
          overflowTrigger(),
          '300px of controls and two 40px pane buttons do not fit in 380px',
        ).not.toBeNull();

        publishPanes({ terminal: false });

        expect(
          overflowTrigger(),
          'the header kept the width it remembered with the Terminal button though the button is gone',
        ).toBeNull();
        for (const pass of [1, 2, 3]) {
          observer.flush();
          expect(
            overflowTrigger(),
            `re-measurement pass ${pass} folded the header again`,
          ).toBeNull();
        }
      } finally {
        restoreMetrics();
        observer.restore();
      }
    });

    test('a pane button that appears re-measures at once, and the header folds and stays folded', () => {
      const observer = captureResizeObserver();
      publishPanes({ terminal: false });
      const restoreMetrics = mockHeaderMetrics({
        header: 600,
        leading: 220,
        trailing: 300,
        collapsedTrailing: 44,
        paneButton: 40,
      });
      try {
        renderHeader();
        expect(overflowTrigger()).toBeNull();

        publishPanes();

        expect(
          overflowTrigger(),
          'the Terminal button appeared and the header kept a verdict measured without it',
        ).not.toBeNull();
        for (const pass of [1, 2, 3]) {
          observer.flush();
          expect(
            overflowTrigger(),
            `re-measurement pass ${pass} unfolded the header though the room never changed`,
          ).not.toBeNull();
        }
      } finally {
        restoreMetrics();
        observer.restore();
      }
    });

    test('turning the project terminal off and on re-measures the fold each time', () => {
      const observer = captureResizeObserver();
      publishPanes();
      const restoreMetrics = mockHeaderMetrics({
        header: 600,
        leading: 220,
        trailing: 300,
        collapsedTrailing: 44,
        paneButton: 40,
      });
      try {
        const view = renderHeader();
        expect(overflowTrigger()).not.toBeNull();

        projectTerminal = { synced: true, enabled: false };
        view.rerender(<AppHeader onOpenSearch={onOpenSearch} />);

        expect(screen.queryByRole('button', { name: 'Terminal' })).toBeNull();
        expect(
          overflowTrigger(),
          'the header kept the width it remembered with the Terminal button after the terminal was turned off',
        ).toBeNull();
        observer.flush();
        expect(overflowTrigger()).toBeNull();

        projectTerminal = { synced: true, enabled: true };
        view.rerender(<AppHeader onOpenSearch={onOpenSearch} />);

        expect(screen.getByRole('button', { name: 'Terminal' })).toBeTruthy();
        expect(
          overflowTrigger(),
          'the Terminal button came back and the header kept a verdict measured without it',
        ).not.toBeNull();
        observer.flush();
        expect(overflowTrigger()).not.toBeNull();
      } finally {
        restoreMetrics();
        observer.restore();
      }
    });

    test.each([
      { status: { state: 'idle', conflictCount: 2 }, attention: 'conflict', label: 'Conflict' },
      { status: { state: 'offline', conflictCount: 0 }, attention: 'offline', label: 'Offline' },
      {
        status: { state: 'auth-error', conflictCount: 0 },
        attention: 'auth-error',
        label: 'Reconnect required',
      },
      {
        status: { state: 'disabled', conflictCount: 0, pausedReason: 'git-operation-in-progress' },
        attention: 'paused',
        label: 'Sync paused',
      },
    ] as const)(
      'a collapsed group puts the $attention sync state on the trigger',
      ({ status, attention, label }) => {
        shell.syncStatus = { ...status, hasRemote: true } as Partial<GitSyncStatus>;
        const restoreMetrics = mockHeaderMetrics(CRAMPED);
        try {
          renderHeader();

          const trigger = overflowTrigger() as HTMLElement;
          expect(trigger.getAttribute('aria-label')).toBe(`More actions (${label})`);
          expect(
            trigger
              .querySelector('[data-testid="header-overflow-actions-sync-indicator"]')
              ?.getAttribute('data-sync-attention'),
          ).toBe(attention);
        } finally {
          restoreMetrics();
        }
      },
    );

    test('a collapsed group leaves the trigger unadorned while sync is healthy', () => {
      shell.syncStatus = { state: 'idle', conflictCount: 0, hasRemote: true };
      const restoreMetrics = mockHeaderMetrics(CRAMPED);
      try {
        renderHeader();

        const trigger = overflowTrigger() as HTMLElement;
        expect(trigger.getAttribute('aria-label')).toBe('More actions');
        expect(
          trigger.querySelector('[data-testid="header-overflow-actions-sync-indicator"]'),
        ).toBeNull();
      } finally {
        restoreMetrics();
      }
    });
  });
});
