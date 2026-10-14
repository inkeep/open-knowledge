import { REDUCED_CHROME_HEADER_HEIGHT } from '@inkeep/open-knowledge-core';
import * as actualLinguiMacro from '@lingui/react/macro';
import { act, cleanup, render, screen } from '@testing-library/react';
import { type ComponentProps, type ReactNode, useEffect } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, test, vi } from 'vitest';
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
import { mockHeaderMetrics } from './EditorHeader.layout.test-helper';

vi.doMock('@lingui/react/macro', () => ({
  ...actualLinguiMacro,
  Trans: ({ children }: { children: ReactNode }) => <>{children}</>,
  useLingui: () => ({
    t: (strings: TemplateStringsArray, ...values: unknown[]) =>
      strings.reduce((acc, part, index) => `${acc}${part}${values[index] ?? ''}`, ''),
  }),
}));

let activeDocName: string | null = 'docs/notes';
let sidebarState: 'expanded' | 'collapsed' = 'expanded';
let singleFile = false;
let gitSyncStatus: Partial<GitSyncStatus> | null = null;
const syncToastsHookCalls: unknown[][] = [];
const syncToastsHosts = { mounted: 0 };
const gitSyncStatusReads = { count: 0 };

vi.doMock('@/editor/DocumentContext', () => ({
  useDocumentContext: () => ({
    activeDocName,
  }),
}));

vi.doMock('@/lib/single-file-mode', () => ({
  useSingleFileMode: () => singleFile,
}));

vi.doMock('@/components/ui/sidebar', () => ({
  useSidebar: () => ({ state: sidebarState }),
  SidebarTrigger: ({ className, ...props }: ComponentProps<'button'>) => (
    <button type="button" data-testid="sidebar-trigger" className={className} {...props}>
      sidebar
    </button>
  ),
}));

vi.doMock('@/components/AppMenubar', () => ({
  AppMenubar: () => <div data-testid="app-menubar" />,
}));

vi.doMock('./SyncStatusBadge', async () => ({
  ...(await vi.importActual<typeof import('./SyncStatusBadge')>('./SyncStatusBadge')),
  SyncStatusBadge: () => <div data-testid="sync-status-badge" />,
}));

vi.doMock('@/hooks/use-git-sync-status', () => ({
  useGitSyncStatusDetailed: () => {
    gitSyncStatusReads.count += 1;
    return { status: gitSyncStatus, fetchError: null };
  },
  useGitSyncStatus: () => gitSyncStatus,
}));

vi.doMock('@/presence/use-sync-toasts', () => ({
  useSyncToasts: (...args: unknown[]) => {
    syncToastsHookCalls.push(args);
    useEffect(() => {
      syncToastsHosts.mounted += 1;
      return () => {
        syncToastsHosts.mounted -= 1;
      };
    }, []);
  },
}));

vi.doMock('@/presence/PresenceBar', () => ({
  PresenceBar: () => <div data-testid="presence-bar" />,
}));

vi.doMock('./BetaBadge', () => ({
  BetaBadge: () => <div data-testid="beta-badge" />,
}));

vi.doMock('./HelpPopover', () => ({
  HelpPopover: () => <button type="button">Resources</button>,
}));

vi.doMock('./InstanceBadge', () => ({
  InstanceBadge: ({ className }: { className?: string }) => (
    <span data-testid="instance-badge" className={className} />
  ),
}));

function setElectronHost(enabled: boolean) {
  Object.defineProperty(window, 'okDesktop', {
    configurable: true,
    value: enabled ? {} : undefined,
  });
}

function setWindowsHost() {
  Object.defineProperty(window, 'okDesktop', {
    configurable: true,
    value: { menu: {}, platform: 'win32' },
  });
}

function setNoteHost() {
  Object.defineProperty(window, 'okDesktop', {
    configurable: true,
    value: { config: { mode: 'note' }, menu: {}, platform: 'win32' },
  });
}

let projectTerminal: ProjectTerminalSetting = TERMINAL_SETTING_UNSET;

const PANE_HIDDEN: PaneVisibility = { open: false, onScreen: false };
const PANE_SHOWN: PaneVisibility = { open: true, onScreen: true };

function publishPanes({ terminal = true }: { terminal?: boolean } = {}) {
  act(() => {
    paneVisibilityStore.publish({
      editor: null,
      agents: PANE_SHOWN,
      terminal: terminal ? PANE_HIDDEN : null,
    });
  });
}

async function renderHeader(tabs?: ReactNode) {
  const { EditorHeader } = await import('./EditorHeader');
  const tree = (nextTabs?: ReactNode) => (
    <ConfigContext value={configContextWithTerminal(projectTerminal)}>
      <TooltipProvider delayDuration={0}>
        <EditorHeader>{nextTabs}</EditorHeader>
      </TooltipProvider>
    </ConfigContext>
  );
  render(tree(tabs));
  return document.querySelector('header') as HTMLElement;
}

async function renderMeasuredHeader() {
  return await renderHeader(<div>tabs</div>);
}

const RESERVATION_PROPERTIES = [
  '--editor-header-leading-width',
  '--editor-header-trailing-width',
  '--editor-header-leading-offset',
] as const;

function reservationsOn(header: HTMLElement) {
  return RESERVATION_PROPERTIES.map((property) => header.style.getPropertyValue(property));
}

describe('EditorHeader runtime behavior', () => {
  afterEach(() => {
    cleanup();
    setElectronHost(false);
    activeDocName = 'docs/notes';
    sidebarState = 'expanded';
    singleFile = false;
    gitSyncStatus = null;
    syncToastsHookCalls.length = 0;
    syncToastsHosts.mounted = 0;
    gitSyncStatusReads.count = 0;
    projectTerminal = TERMINAL_SETTING_UNSET;
    __resetPaneVisibilityStoreForTests();
  });

  test('exports the EditorHeader component', async () => {
    const mod = await import('./EditorHeader');
    expect(typeof mod.EditorHeader).toBe('function');
  });

  test('a single-file editor card owns document identity and its information control', async () => {
    setElectronHost(true);
    singleFile = true;
    const { EditorHeader } = await import('./EditorHeader');
    render(
      <TooltipProvider delayDuration={0}>
        <EditorHeader trailing={<button type="button">Show document information</button>} />
      </TooltipProvider>,
    );

    const header = document.querySelector('[data-editor-header]') as HTMLElement;
    const tabs = header.querySelector('[data-editor-header-tabs]') as HTMLElement;
    const trailing = header.querySelector('[data-editor-header-trailing]') as HTMLElement;
    expect(tabs.textContent).toContain('docs');
    expect(tabs.textContent).toContain('notes');
    expect(
      trailing.contains(screen.getByRole('button', { name: 'Show document information' })),
    ).toBe(true);
    expect(header.querySelector('[data-editor-header-actions]')).toBeNull();
    expect(header.querySelector('[data-editor-header-leading-actions]')).toBeNull();
    expect(header.querySelector('[data-testid="header-pane-buttons"]')).toBeNull();
    expectVisualClassTokens(header.className, ['h-11']);
  });

  test('a note window alone keeps its reduced titlebar height', async () => {
    setNoteHost();
    const header = await renderHeader();
    expectVisualClassTokens(header.className, ['h-[var(--ok-reduced-chrome-header-height)]']);
    expect(header.style.getPropertyValue('--ok-reduced-chrome-header-height')).toBe(
      REDUCED_CHROME_HEADER_HEIGHT,
    );
  });

  test('a web project window tab row is a plain 44px row without window-drag treatment', async () => {
    setElectronHost(false);
    sidebarState = 'collapsed';
    const header = await renderHeader();

    expect(header.getAttribute('data-electron-drag')).toBeNull();
    expectVisualClassTokens(header.className, [
      'flex',
      'h-11',
      'shrink-0',
      'items-center',
      'bg-background',
    ]);
    expectVisualClassTokensAbsent(header.className, [
      'shadow-[inset_0_-1px_0_var(--border)]',
      'h-[var(--ok-reduced-chrome-header-height)]',
      '[-webkit-app-region:drag]',
      'pl-[var(--ok-titlebar-reserve-left,1rem)]',
    ]);
    expect(screen.queryByTestId('navigation-history-controls')).toBeNull();
  });

  for (const state of ['expanded', 'collapsed'] as const) {
    test(`an Electron project window tab row with the file list ${state} is a drag region holding only the tab strip`, async () => {
      setElectronHost(true);
      sidebarState = state;
      const header = await renderHeader(<div data-testid="editor-tabs">tabs</div>);
      const tabHost = header.querySelector('[data-editor-header-tabs]') as HTMLElement;

      expect(header.getAttribute('data-electron-drag')).toBe('');
      expectVisualClassTokens(header.className, ['h-11', '[-webkit-app-region:drag]']);
      expect(tabHost.getAttribute('data-electron-drag')).toBe('');
      expectVisualClassTokens(tabHost.className, ['[-webkit-app-region:drag]']);
      expectVisualClassTokensAbsent(tabHost.className, ['[-webkit-app-region:no-drag]']);
      expect(Array.from(header.children)).toEqual([tabHost]);
      expect(tabHost.contains(screen.getByTestId('editor-tabs'))).toBe(true);
      expect(header.querySelector('[data-editor-header-leading-actions]')).toBeNull();
      expect(header.querySelector('[data-editor-header-actions]')).toBeNull();
      expect(
        screen.queryByTestId('sidebar-trigger'),
        'the file list toggle rides in the first pane tab strip, not in header chrome laid over it',
      ).toBeNull();
      expect(screen.queryByRole('group', { name: 'Workspace navigation' })).toBeNull();
      expect(screen.queryByRole('button', { name: /^Search/ })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Back' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Forward' })).toBeNull();
      expect(reservationsOn(header)).toEqual(['', '', '']);
    });
  }

  test('no window kind publishes leading or trailing width reservations for the tab strip', async () => {
    const restoreMetrics = mockHeaderMetrics({
      header: 1_000,
      leading: 224,
      leadingOffset: 78,
      trailing: 300,
    });
    try {
      for (const kind of ['project', 'single-file'] as const) {
        setElectronHost(true);
        sidebarState = 'collapsed';
        singleFile = kind === 'single-file';
        const header = await renderHeader(<div>tabs</div>);

        expect(reservationsOn(header), `${kind} window`).toEqual(['', '', '']);
        cleanup();
      }
    } finally {
      restoreMetrics();
    }
  });

  test('tabs paint on the first render, with no header chrome to measure first', async () => {
    const { EditorHeader } = await import('./EditorHeader');
    const markup = renderToStaticMarkup(
      <TooltipProvider delayDuration={0}>
        <EditorHeader>
          <div>restored tabs</div>
        </EditorHeader>
      </TooltipProvider>,
    );
    const container = document.createElement('div');
    container.innerHTML = markup;
    const tabHost = container.querySelector('[data-editor-header-tabs]') as HTMLElement;

    expectVisualClassTokensAbsent(tabHost.className, ['invisible']);
    expect(tabHost.hasAttribute('data-editor-header-tabs-suppressed')).toBe(false);
  });

  test('the tab strip is bounded by the editor column width, not padded around header chrome', async () => {
    const header = await renderHeader(<div>tabs</div>);
    const tabHost = header.querySelector('[data-editor-header-tabs]') as HTMLElement;

    expectVisualClassTokens(tabHost.className, [
      'w-[var(--editor-header-tabs-width,100%)]',
      'min-w-0',
      'overflow-hidden',
    ]);
    expectVisualClassTokensAbsent(tabHost.className, ['absolute', 'invisible']);
  });

  test('a Windows project window leaves the app menu to the app header', async () => {
    setWindowsHost();
    const header = await renderHeader();

    await act(async () => {});
    expect(screen.queryByTestId('app-menubar')).toBeNull();
    expect(header.querySelector('[data-editor-header-leading-actions]')).toBeNull();
  });
  test('a project window tab row carries none of the header actions, which moved to the app header', async () => {
    gitSyncStatus = { state: 'idle', conflictCount: 2, hasRemote: true };
    const restoreMetrics = mockHeaderMetrics({ header: 107, leading: 57, trailing: 218 });
    try {
      for (const state of ['expanded', 'collapsed'] as const) {
        sidebarState = state;
        const header = await renderMeasuredHeader();

        expect(header.querySelector('[data-editor-header-actions]')).toBeNull();
        expect(screen.queryByTestId('presence-bar')).toBeNull();
        expect(screen.queryByRole('button', { name: /^Share/ })).toBeNull();
        expect(screen.queryByTestId('sync-status-badge')).toBeNull();
        expect(screen.queryByRole('button', { name: 'Settings' })).toBeNull();
        expect(screen.queryByRole('button', { name: 'Resources' })).toBeNull();
        expect(screen.queryByTestId('beta-badge')).toBeNull();
        expect(screen.queryByTestId('instance-badge')).toBeNull();
        expect(screen.queryByTestId('header-overflow-actions-trigger')).toBeNull();
        expect(syncToastsHosts.mounted).toBe(0);
        expect(reservationsOn(header)).toEqual(['', '', '']);
        cleanup();
      }
    } finally {
      restoreMetrics();
    }
  });

  test('document card headers leave sync status to the shared header', async () => {
    gitSyncStatus = { state: 'idle', conflictCount: 0, hasRemote: true };

    await renderHeader();
    expect(gitSyncStatusReads.count).toBe(0);

    cleanup();
    singleFile = true;
    await renderHeader();
    expect(gitSyncStatusReads.count).toBe(0);
  });

  test('note windows put document context in the titlebar without Resources or sync chrome', async () => {
    setNoteHost();
    sidebarState = 'expanded';
    const restoreMetrics = mockHeaderMetrics({ header: 107, leading: 57, trailing: 218 });
    try {
      const { EditorHeader } = await import('./EditorHeader');
      render(
        <ConfigContext value={configContextWithTerminal(projectTerminal)}>
          <TooltipProvider delayDuration={0}>
            <EditorHeader noteModeToggle={<button type="button">mode switch</button>} />
          </TooltipProvider>
        </ConfigContext>,
      );

      const leadingZone = document.querySelector(
        '[data-editor-header-leading-actions]',
      ) as HTMLElement;
      const header = document.querySelector('header') as HTMLElement;
      expect(leadingZone.textContent).toContain('docs');
      expect(leadingZone.textContent).toContain('notes');
      expect(
        leadingZone.querySelector('[data-slot="breadcrumb-page"][aria-current="page"]')
          ?.textContent,
      ).toBe('notes');
      expectVisualClassTokens(header.className, ['bg-background']);
      expectVisualClassTokensAbsent(header.className, ['shadow-[inset_0_-1px_0_var(--border)]']);
      expectVisualClassTokens(leadingZone.className, [
        'left-[var(--ok-titlebar-reserve-left,1rem)]',
      ]);
      const modeToggle = document.querySelector('[data-note-window-mode-toggle]') as HTMLElement;
      expect(modeToggle.contains(screen.getByRole('button', { name: 'mode switch' }))).toBe(true);
      expectVisualClassTokensAbsent(modeToggle.className, [
        '[&_[data-slot=toggle-group]]:bg-transparent',
        '[&_[data-slot=toggle-group]]:p-0',
        '[&_[data-slot=toggle-group-item]]:size-8',
        '[&_[data-slot=toggle-group-item]]:shadow-none',
      ]);
      expect(screen.queryByRole('button', { name: 'Resources' })).toBeNull();
      expect(screen.queryByTestId('sync-status-badge')).toBeNull();
      expect(screen.queryByTestId('presence-bar')).toBeNull();
      expect(screen.queryByTestId('beta-badge')).toBeNull();
      expect(screen.queryByTestId('app-menubar')).toBeNull();
      expect(
        screen.queryByRole('button', { name: 'More actions' }),
        'a note window has no trailing actions to collapse, so a cramped header must not grow an overflow trigger',
      ).toBeNull();
      expect(document.querySelector('[data-header-overflow-actions]')).toBeNull();
    } finally {
      restoreMetrics();
    }
  });

  test('a note window has no chat or terminal, so it shows no Agents or Terminal buttons even when panes are published', async () => {
    setNoteHost();
    publishPanes();
    const { EditorHeader } = await import('./EditorHeader');
    render(
      <ConfigContext value={configContextWithTerminal(projectTerminal)}>
        <TooltipProvider delayDuration={0}>
          <EditorHeader />
        </TooltipProvider>
      </ConfigContext>,
    );

    expect(document.querySelector('[data-editor-header-actions]')).not.toBeNull();
    expect(screen.queryByRole('group', { name: 'Panels' })).toBeNull();
    expect(screen.queryByTestId('header-pane-divider')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Agents' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Terminal' })).toBeNull();
  });

  test('a project window tab row leaves the Agents and Terminal buttons to the app header', async () => {
    publishPanes();
    const header = await renderHeader(<div>tabs</div>);

    expect(header.querySelector('[data-testid="header-pane-buttons"]')).toBeNull();
    expect(screen.queryByRole('group', { name: 'Panels' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Agents' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Terminal' })).toBeNull();
  });

  test('renders workspace tabs between the global action zones', async () => {
    await renderHeader(<div data-testid="editor-tabs">tabs</div>);

    const tabHost = document.querySelector('[data-editor-header-tabs]');
    expect(tabHost?.contains(screen.getByTestId('editor-tabs'))).toBe(true);
    expect(screen.queryByTestId('open-in-agent-menu')).toBeNull();
    expect(screen.queryByText('projectName')).toBeNull();
    expect(screen.queryByText('assetFileName')).toBeNull();
  });

  test('a project window tab row holds its trailing slot after the tab strip, a drag region whose controls opt out', async () => {
    setElectronHost(true);
    const { EditorHeader } = await import('./EditorHeader');
    render(
      <TooltipProvider delayDuration={0}>
        <EditorHeader trailing={<button type="button">toggle</button>}>
          <div data-testid="editor-tabs">tabs</div>
        </EditorHeader>
      </TooltipProvider>,
    );
    const header = document.querySelector('header') as HTMLElement;
    const tabHost = header.querySelector('[data-editor-header-tabs]') as HTMLElement;
    const trailing = header.querySelector('[data-editor-header-trailing]') as HTMLElement;

    expect(Array.from(header.children)).toEqual([tabHost, trailing]);
    expect(trailing.contains(screen.getByRole('button', { name: 'toggle' }))).toBe(true);
    expect(trailing.getAttribute('data-electron-drag')).toBe('');
    expectVisualClassTokens(trailing.className, [
      'absolute',
      'inset-y-0',
      'end-0',
      '[-webkit-app-region:drag]',
      '[&_button]:[-webkit-app-region:no-drag]',
      '[&_a]:[-webkit-app-region:no-drag]',
    ]);
    expectVisualClassTokensAbsent(trailing.className, ['pe-9', 'shrink-0']);
    expectVisualClassTokens(tabHost.className, [
      'min-w-0',
      'w-[var(--editor-header-tabs-width,100%)]',
    ]);
  });

  test('a project window tab row shows its trailing slot only while the row is at least 240px wide', async () => {
    const { EditorHeader } = await import('./EditorHeader');
    render(
      <TooltipProvider delayDuration={0}>
        <EditorHeader trailing={<button type="button">toggle</button>}>
          <div data-testid="editor-tabs">tabs</div>
        </EditorHeader>
      </TooltipProvider>,
    );
    const header = document.querySelector('header') as HTMLElement;
    const trailing = header.querySelector('[data-editor-header-trailing]') as HTMLElement;

    expect(trailing.contains(screen.getByRole('button', { name: 'toggle' }))).toBe(true);
    expectVisualClassTokens(header.className, ['@container/editor-header']);
    expectVisualClassTokens(trailing.className, ['hidden', '@[15rem]/editor-header:flex']);
    expectVisualClassTokensAbsent(trailing.className, ['flex']);
  });

  test('a project window tab row tells the last tab group how wide its trailing slot is, only while the slot shows', async () => {
    const { EditorHeader } = await import('./EditorHeader');
    const view = render(
      <TooltipProvider delayDuration={0}>
        <EditorHeader trailing={<button type="button">toggle</button>}>
          <div data-testid="editor-tabs">tabs</div>
        </EditorHeader>
      </TooltipProvider>,
    );
    const header = document.querySelector('header') as HTMLElement;
    const tabHost = header.querySelector('[data-editor-header-tabs]') as HTMLElement;
    expectVisualClassTokens(tabHost.className, [
      '@[15rem]/editor-header:[--editor-header-trailing-width:2rem]',
    ]);
    expect(header.className).not.toContain('--editor-header-trailing-width');
    expect(header.style.getPropertyValue('--editor-header-trailing-width')).toBe('');
    view.unmount();

    render(
      <TooltipProvider delayDuration={0}>
        <EditorHeader>
          <div data-testid="editor-tabs">tabs</div>
        </EditorHeader>
      </TooltipProvider>,
    );
    const bare = document.querySelector('[data-editor-header-tabs]') as HTMLElement;
    expect(bare.className).not.toContain('--editor-header-trailing-width');
  });
});
