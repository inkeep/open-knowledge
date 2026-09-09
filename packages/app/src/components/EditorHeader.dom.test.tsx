import * as actualLinguiMacro from '@lingui/react/macro';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { type ComponentProps, type ReactNode, useEffect } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import type { GitSyncStatus } from '@/hooks/use-git-sync-status';
import { formatShortcut, formatShortcutLabel } from '@/lib/keyboard-shortcuts';
import {
  expectVisualClassTokens,
  expectVisualClassTokensAbsent,
} from '@/test-utils/visual-contract';

vi.doMock('@lingui/react/macro', () => ({
  ...actualLinguiMacro,
  Trans: ({ children }: { children: ReactNode }) => <>{children}</>,
  useLingui: () => ({
    t: (strings: TemplateStringsArray, ...values: unknown[]) =>
      strings.reduce((acc, part, index) => `${acc}${part}${values[index] ?? ''}`, ''),
  }),
}));

let activeDocName: string | null = 'docs/notes';
let activeTarget: unknown = { kind: 'doc' };
let sidebarState: 'expanded' | 'collapsed' = 'expanded';
let paneCount = 1;
let singleFile = false;
let lastShareInput: unknown;
let gitSyncStatus: Partial<GitSyncStatus> | null = null;
const syncToastsHookCalls: unknown[][] = [];
const syncToastsHosts = { mounted: 0 };
const onOpenSearch = vi.fn(() => {});

vi.doMock('@/editor/DocumentContext', () => ({
  useDocumentContext: () => ({
    activeDocName,
    activeTarget,
    panes: Array.from({ length: paneCount }, (_, index) => ({ id: `pane-${index}` })),
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

vi.doMock('./ShareButton', () => ({
  ShareButton: ({ input }: { input: unknown }) => {
    lastShareInput = input;
    return (
      <button type="button" disabled={input === null}>
        Share
      </button>
    );
  },
}));

vi.doMock('./PublishToGitHubDialog', () => ({
  PublishToGitHubDialog: ({ open }: { open: boolean }) => (
    <div data-testid="publish-dialog" data-open={String(open)} />
  ),
}));

vi.doMock('./SyncStatusBadge', async () => ({
  ...(await vi.importActual<typeof import('./SyncStatusBadge')>('./SyncStatusBadge')),
  SyncStatusBadge: () => <div data-testid="sync-status-badge" />,
}));

vi.doMock('@/hooks/use-git-sync-status', () => ({
  useGitSyncStatusDetailed: () => ({ status: gitSyncStatus, fetchError: null }),
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

vi.doMock('./SettingsButton', () => ({
  SettingsButton: () => <button type="button">Settings</button>,
}));

vi.doMock('./HelpPopover', () => ({
  HelpPopover: () => <button type="button">Resources</button>,
}));

vi.doMock('./InstanceBadge', () => ({
  InstanceBadge: () => null,
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

interface HeaderMetrics {
  header: number;
  leading: number;
  leadingOffset?: number;
  tabs?: number;
  trailing: number;
  collapsedTrailing?: number;
}

function mockHeaderMetrics({
  header,
  leading,
  leadingOffset = 0,
  tabs = 0,
  trailing,
  collapsedTrailing,
}: HeaderMetrics) {
  const offsetWidth = vi
    .spyOn(HTMLElement.prototype, 'offsetWidth', 'get')
    .mockImplementation(function (this: HTMLElement) {
      if (this.tagName === 'HEADER') return header;
      if (this.hasAttribute('data-editor-header-leading-actions')) return leading;
      if (this.hasAttribute('data-editor-header-tabs')) return tabs;
      if (this.hasAttribute('data-editor-header-actions')) {
        const collapsed =
          this.querySelector('[data-testid="header-overflow-actions-trigger"]') !== null;
        return collapsed && collapsedTrailing !== undefined ? collapsedTrailing : trailing;
      }
      return 0;
    });
  const offsetLeft = vi
    .spyOn(HTMLElement.prototype, 'offsetLeft', 'get')
    .mockImplementation(function (this: HTMLElement) {
      return this.hasAttribute('data-editor-header-leading-actions') ? leadingOffset : 0;
    });
  return () => {
    offsetLeft.mockRestore();
    offsetWidth.mockRestore();
  };
}

function captureResizeObserver() {
  const callbacks: ResizeObserverCallback[] = [];
  const original = globalThis.ResizeObserver;
  class CapturingResizeObserver {
    constructor(callback: ResizeObserverCallback) {
      callbacks.push(callback);
    }
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  globalThis.ResizeObserver = CapturingResizeObserver as unknown as typeof ResizeObserver;
  return {
    flush() {
      for (const callback of callbacks) {
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

let rerenderHeader: ((tabs?: ReactNode) => void) | null = null;

async function renderHeader(tabs?: ReactNode) {
  const { EditorHeader } = await import('./EditorHeader');
  const tree = (nextTabs?: ReactNode) => (
    <TooltipProvider delayDuration={0}>
      <EditorHeader onOpenSearch={onOpenSearch}>{nextTabs}</EditorHeader>
    </TooltipProvider>
  );
  const view = render(tree(tabs));
  rerenderHeader = (nextTabs?: ReactNode) => {
    act(() => {
      view.rerender(tree(nextTabs));
    });
  };
  return document.querySelector('header') as HTMLElement;
}

async function renderMeasuredHeader() {
  const header = await renderHeader(<div>tabs</div>);
  const tabHost = header.querySelector('[data-editor-header-tabs]') as HTMLElement;
  await waitFor(() => expectVisualClassTokensAbsent(tabHost.className, ['invisible']));
  return header;
}

async function renderHeaderAwaitingTabSuppression() {
  const header = await renderHeader(<div>tabs</div>);
  const tabHost = header.querySelector('[data-editor-header-tabs]') as HTMLElement;
  await waitFor(() =>
    expect(tabHost.getAttribute('data-editor-header-tabs-suppressed')).not.toBeNull(),
  );
  return header;
}

async function trailingRailCollapses(state: 'expanded' | 'collapsed', metrics: HeaderMetrics) {
  sidebarState = state;
  const restoreMetrics = mockHeaderMetrics(metrics);
  try {
    await renderMeasuredHeader();
    return screen.queryByRole('button', { name: 'More actions' }) !== null;
  } finally {
    restoreMetrics();
    cleanup();
  }
}

describe('EditorHeader runtime behavior', () => {
  afterEach(() => {
    cleanup();
    setElectronHost(false);
    activeDocName = 'docs/notes';
    activeTarget = { kind: 'doc' };
    sidebarState = 'expanded';
    paneCount = 1;
    singleFile = false;
    lastShareInput = undefined;
    gitSyncStatus = null;
    syncToastsHookCalls.length = 0;
    syncToastsHosts.mounted = 0;
    rerenderHeader = null;
    onOpenSearch.mockClear();
  });

  test('exports the EditorHeader component', async () => {
    const mod = await import('./EditorHeader');
    expect(typeof mod.EditorHeader).toBe('function');
  });

  test('web host keeps baseline header layout without Electron drag treatment', async () => {
    setElectronHost(false);
    sidebarState = 'collapsed';
    const header = await renderHeader();

    expect(header.getAttribute('data-electron-drag')).toBeNull();
    expectVisualClassTokens(header.className, [
      'flex',
      'h-12',
      'shrink-0',
      'items-center',
      'shadow-[inset_0_-1px_0_var(--border)]',
    ]);
    expectVisualClassTokensAbsent(header.className, [
      '[-webkit-app-region:drag]',
      'pl-[var(--ok-titlebar-reserve-left,1rem)]',
    ]);
    expectVisualClassTokensAbsent(screen.getByTestId('sidebar-trigger').className, [
      '[-webkit-app-region:no-drag]',
    ]);
    expect(screen.queryByTestId('navigation-history-controls')).toBeNull();
  });

  test('renders the expanded Files shortcut as a Kbd keycap', async () => {
    const user = userEvent.setup();
    await renderHeader();

    await user.hover(screen.getByTestId('sidebar-trigger'));
    const tooltip = await screen.findByRole('tooltip', {
      name: `Hide Files ${formatShortcutLabel('toggle-files-sidebar')}`,
    });
    expect(tooltip.querySelector('[data-slot="kbd"]')?.textContent).toBe(
      formatShortcut('toggle-files-sidebar'),
    );
  });

  test('renders collapsed Files and Search shortcuts as Kbd keycaps with spoken button text', async () => {
    const user = userEvent.setup();
    sidebarState = 'collapsed';
    await renderHeader();

    const filesButton = screen.getByTestId('sidebar-trigger');
    await user.hover(filesButton);
    const filesTooltip = await screen.findByRole('tooltip', {
      name: `Show Files ${formatShortcutLabel('toggle-files-sidebar')}`,
    });
    expect(filesTooltip.querySelector('[data-slot="kbd"]')?.textContent).toBe(
      formatShortcut('toggle-files-sidebar'),
    );
    cleanup();
    await renderHeader();

    const searchButton = screen.getByRole('button', {
      name: `Search (${formatShortcutLabel('command-palette')})`,
    });
    await user.hover(searchButton);
    const searchTooltip = await screen.findByRole('tooltip', {
      name: `Search ${formatShortcutLabel('command-palette')}`,
    });
    expect(searchTooltip.querySelector('[data-slot="kbd"]')?.textContent).toBe(
      formatShortcut('command-palette'),
    );
    expect(searchButton).not.toBeNull();
  });

  test('Electron collapsed-sidebar host groups workspace navigation without a Search-to-Back separator', async () => {
    setElectronHost(true);
    sidebarState = 'collapsed';
    const header = await renderHeader();
    const leadingZone = header.querySelector('[data-editor-header-leading-actions]') as HTMLElement;

    expect(header.getAttribute('data-electron-drag')).toBe('');
    expectVisualClassTokens(header.className, ['[-webkit-app-region:drag]']);
    const tabHost = header.querySelector('[data-editor-header-tabs]') as HTMLElement;
    expect(tabHost.getAttribute('data-electron-drag')).toBe('');
    expectVisualClassTokens(tabHost.className, ['[-webkit-app-region:drag]']);
    expectVisualClassTokensAbsent(tabHost.className, ['[-webkit-app-region:no-drag]']);
    expect(leadingZone.getAttribute('data-electron-drag')).toBe('');
    expectVisualClassTokens(leadingZone.className, ['[-webkit-app-region:drag]']);
    expectVisualClassTokens(leadingZone.className, ['left-[var(--ok-titlebar-reserve-left,1rem)]']);
    expectVisualClassTokensAbsent(leadingZone.className, ['motion-safe:transition-[left]']);
    expectVisualClassTokens(screen.getByTestId('sidebar-trigger').className, [
      '[-webkit-app-region:no-drag]',
    ]);
    const workspaceNavigation = screen.getByRole('group', { name: 'Workspace navigation' });
    const search = screen.getByRole('button', { name: /^Search/ });
    const navigation = screen.getByTestId('navigation-history-controls');
    const separator = leadingZone.querySelector('[data-slot="separator"]') as HTMLElement;
    expect(workspaceNavigation.contains(screen.getByTestId('sidebar-trigger'))).toBe(true);
    expect(workspaceNavigation.contains(search)).toBe(true);
    expect(workspaceNavigation.contains(navigation)).toBe(true);
    expect(workspaceNavigation.querySelector('[data-slot="button-group-separator"]')).toBeNull();
    expect(screen.getAllByRole('button', { name: 'Back' })).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: 'Forward' })).toHaveLength(1);
    expect(
      search.compareDocumentPosition(navigation) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      navigation.compareDocumentPosition(separator) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expectVisualClassTokensAbsent(navigation.className, ['[-webkit-app-region:no-drag]']);
    const rightZone = header.querySelector('[data-editor-header-actions]') as HTMLElement;
    expect(rightZone.getAttribute('data-electron-drag')).toBe('');
    expectVisualClassTokens(rightZone.className, [
      '[-webkit-app-region:drag]',
      '[&_button]:[-webkit-app-region:no-drag]',
      '[&_a]:[-webkit-app-region:no-drag]',
    ]);
    expectVisualClassTokensAbsent(rightZone.className, ['*:[-webkit-app-region:no-drag]']);
    expect(
      tabHost.compareDocumentPosition(leadingZone) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      tabHost.compareDocumentPosition(rightZone) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  test('Electron expanded sidebar keeps drag region but does not reserve traffic-light space', async () => {
    setElectronHost(true);
    sidebarState = 'expanded';
    const header = await renderHeader();
    const leadingZone = header.querySelector('[data-editor-header-leading-actions]') as HTMLElement;

    expectVisualClassTokens(header.className, ['[-webkit-app-region:drag]']);
    expectVisualClassTokensAbsent(leadingZone.className, [
      'left-[var(--ok-titlebar-reserve-left,1rem)]',
    ]);
    expect(header.style.getPropertyValue('--editor-header-leading-offset')).toBe('0px');
    expect(screen.queryByTestId('navigation-history-controls')).toBeNull();
  });

  test('keeps the sidebar offset separate from the measured leading action width', async () => {
    setElectronHost(true);
    sidebarState = 'collapsed';
    const offsetWidth = vi
      .spyOn(HTMLElement.prototype, 'offsetWidth', 'get')
      .mockImplementation(function (this: HTMLElement) {
        if (this.hasAttribute('data-editor-header-leading-actions')) return 224;
        if (this.hasAttribute('data-editor-header-actions')) return 160;
        return 0;
      });

    try {
      const header = await renderHeader(<div>tabs</div>);

      expect(header.style.getPropertyValue('--editor-header-leading-width')).toBe('224px');
      expect(header.style.getPropertyValue('--editor-header-leading-offset')).toBe(
        'var(--ok-titlebar-reserve-left, 1rem)',
      );
      const tabHost = header.querySelector('[data-editor-header-tabs]') as HTMLElement;
      await waitFor(() => expectVisualClassTokensAbsent(tabHost.className, ['invisible']));
    } finally {
      offsetWidth.mockRestore();
    }
  });

  test('keeps tabs hidden on the first render until header chrome is measured', async () => {
    const { EditorHeader } = await import('./EditorHeader');
    const markup = renderToStaticMarkup(
      <TooltipProvider delayDuration={0}>
        <EditorHeader onOpenSearch={onOpenSearch}>
          <div>restored tabs</div>
        </EditorHeader>
      </TooltipProvider>,
    );
    const container = document.createElement('div');
    container.innerHTML = markup;
    const tabHost = container.querySelector('[data-editor-header-tabs]') as HTMLElement;

    expectVisualClassTokens(tabHost.className, ['invisible']);
  });

  test('keeps restored tabs hidden until two settled layout frames have passed', async () => {
    const frames: FrameRequestCallback[] = [];
    const requestFrame = vi
      .spyOn(window, 'requestAnimationFrame')
      .mockImplementation((callback) => {
        frames.push(callback);
        return frames.length;
      });
    const cancelFrame = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});

    try {
      const header = await renderHeader(<div>restored tabs</div>);
      const tabHost = header.querySelector('[data-editor-header-tabs]') as HTMLElement;

      expectVisualClassTokens(tabHost.className, ['invisible']);
      act(() => frames.shift()?.(0));
      expectVisualClassTokens(tabHost.className, ['invisible']);
      act(() => frames.shift()?.(16));
      expectVisualClassTokensAbsent(tabHost.className, ['invisible']);
    } finally {
      requestFrame.mockRestore();
      cancelFrame.mockRestore();
    }
  });

  test('reserves only the header actions that overlap the editor-width tab strip', async () => {
    const offsetWidth = vi
      .spyOn(HTMLElement.prototype, 'offsetWidth', 'get')
      .mockImplementation(function (this: HTMLElement) {
        if (this.tagName === 'HEADER') return 1_000;
        if (this.hasAttribute('data-editor-header-tabs')) return 800;
        if (this.hasAttribute('data-editor-header-actions')) return 300;
        if (this.hasAttribute('data-editor-header-leading-actions')) return 100;
        return 0;
      });

    try {
      const header = await renderHeader(<div>tabs</div>);
      expect(header.style.getPropertyValue('--editor-header-trailing-width')).toBe('100px');
    } finally {
      offsetWidth.mockRestore();
    }
  });

  test('includes the WCO reserve margin in the trailing tab-strip width', async () => {
    const offsetWidth = vi
      .spyOn(HTMLElement.prototype, 'offsetWidth', 'get')
      .mockImplementation(function (this: HTMLElement) {
        if (this.tagName === 'HEADER') return 1_000;
        if (this.hasAttribute('data-editor-header-tabs')) return 800;
        if (this.hasAttribute('data-editor-header-actions')) return 300;
        if (this.hasAttribute('data-editor-header-leading-actions')) return 100;
        return 0;
      });
    const realGetComputedStyle = window.getComputedStyle.bind(window);
    const computedStyle = vi
      .spyOn(window, 'getComputedStyle')
      .mockImplementation((element: Element, pseudo?: string | null) => {
        const style = realGetComputedStyle(element, pseudo);
        if (element instanceof HTMLElement && element.hasAttribute('data-editor-header-actions')) {
          return new Proxy(style, {
            get: (target, property) =>
              property === 'marginRight' ? '137px' : Reflect.get(target, property),
          }) as CSSStyleDeclaration;
        }
        return style;
      });

    try {
      const header = await renderHeader(<div>tabs</div>);
      expect(header.style.getPropertyValue('--editor-header-trailing-width')).toBe('237px');
    } finally {
      computedStyle.mockRestore();
      offsetWidth.mockRestore();
    }
  });

  test('keeps sidebar chrome movement immediate after a post-mount state change', async () => {
    setElectronHost(true);
    sidebarState = 'collapsed';
    const { EditorHeader } = await import('./EditorHeader');
    const headerUi = () => (
      <TooltipProvider delayDuration={0}>
        <EditorHeader onOpenSearch={onOpenSearch}>
          <div>restored tabs</div>
        </EditorHeader>
      </TooltipProvider>
    );
    const view = render(headerUi());
    const header = document.querySelector('header') as HTMLElement;

    const leadingZone = header.querySelector('[data-editor-header-leading-actions]') as HTMLElement;
    expectVisualClassTokens(leadingZone.className, ['left-[var(--ok-titlebar-reserve-left,1rem)]']);
    expectVisualClassTokensAbsent(leadingZone.className, ['motion-safe:transition-[left]']);

    sidebarState = 'expanded';
    view.rerender(headerUi());

    expectVisualClassTokensAbsent(leadingZone.className, [
      'left-[var(--ok-titlebar-reserve-left,1rem)]',
      'motion-safe:transition-[left]',
    ]);
  });

  test('Windows places Hide Files before the File menu', async () => {
    setWindowsHost();
    const header = await renderHeader();

    const files = screen.getByTestId('sidebar-trigger');
    const menubar = await screen.findByTestId('app-menubar');
    const leadingZone = header.querySelector('[data-editor-header-leading-actions]') as HTMLElement;
    const separator = leadingZone.querySelector('[data-slot="separator"]') as HTMLElement;

    expect(files.compareDocumentPosition(menubar) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(
      menubar.compareDocumentPosition(separator) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  test('Windows single-file mode keeps the menubar without project chrome', async () => {
    setWindowsHost();
    singleFile = true;
    await renderHeader();

    expect(await screen.findByTestId('app-menubar')).toBeTruthy();
    expect(screen.queryByTestId('sidebar-trigger')).toBeNull();
  });

  test('single-file mode omits collapsed navigation history with the rest of project chrome', async () => {
    setElectronHost(true);
    sidebarState = 'collapsed';
    singleFile = true;
    await renderHeader();

    expect(screen.queryByTestId('sidebar-trigger')).toBeNull();
    expect(screen.queryByRole('button', { name: /^Search/ })).toBeNull();
    expect(screen.queryByTestId('navigation-history-controls')).toBeNull();
  });

  test('note windows put document context in the titlebar without Resources or sync chrome', async () => {
    setNoteHost();
    sidebarState = 'expanded';
    const restoreMetrics = mockHeaderMetrics({ header: 107, leading: 57, trailing: 218 });
    try {
      const { EditorHeader } = await import('./EditorHeader');
      render(
        <TooltipProvider delayDuration={0}>
          <EditorHeader noteModeToggle={<button type="button">mode switch</button>} />
        </TooltipProvider>,
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
      expectVisualClassTokensAbsent(header.className, [
        'bg-muted/35',
        'shadow-[inset_0_-1px_0_var(--border)]',
      ]);
      expectVisualClassTokens(leadingZone.className, [
        'left-[var(--ok-titlebar-reserve-left,1rem)]',
      ]);
      expect(screen.getByRole('button', { name: 'mode switch' })).toBeTruthy();
      const modeToggle = document.querySelector('[data-note-window-mode-toggle]') as HTMLElement;
      expectVisualClassTokens(modeToggle.className, [
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
      expect(document.querySelector('[data-editor-header-overflow-actions]')).toBeNull();
    } finally {
      restoreMetrics();
    }
  });

  test('renders workspace tabs between the global action zones', async () => {
    await renderHeader(<div data-testid="editor-tabs">tabs</div>);

    const tabHost = document.querySelector('[data-editor-header-tabs]');
    expect(tabHost?.contains(screen.getByTestId('editor-tabs'))).toBe(true);
    expect(screen.queryByTestId('open-in-agent-menu')).toBeNull();
    expect(screen.queryByText('projectName')).toBeNull();
    expect(screen.queryByText('assetFileName')).toBeNull();
  });

  test('keeps the existing action-zone styling when workspace tabs share the header', async () => {
    const header = await renderHeader(<div data-testid="editor-tabs">tabs</div>);
    const leadingZone = header.querySelector('[data-editor-header-leading-actions]') as HTMLElement;
    const trailingZone = header.querySelector('[data-editor-header-actions]') as HTMLElement;

    expectVisualClassTokensAbsent(leadingZone.className, ['bg-muted/95']);
    expectVisualClassTokensAbsent(trailingZone.className, ['bg-muted/95']);
  });

  test('keeps header actions inline with multiple editor panes', async () => {
    paneCount = 3;
    const header = await renderHeader();
    const trailingZone = header.querySelector('[data-editor-header-actions]') as HTMLElement;

    expect(screen.queryByRole('button', { name: 'More actions' })).toBeNull();
    expect(trailingZone.contains(screen.getByRole('button', { name: 'Share' }))).toBe(true);
    expect(trailingZone.contains(screen.getByRole('button', { name: 'Settings' }))).toBe(true);
    expect(trailingZone.contains(screen.getByRole('button', { name: 'Resources' }))).toBe(true);
    expect(document.querySelector('[data-editor-header-overflow-actions]')).toBeNull();
  });

  test('collapses the trailing rail when its expanded width exceeds the available header space', async () => {
    const restoreMetrics = mockHeaderMetrics({ header: 107, leading: 57, trailing: 218 });

    try {
      const header = await renderMeasuredHeader();
      const trailingZone = header.querySelector('[data-editor-header-actions]') as HTMLElement;
      const overflowTrigger = screen.getByRole('button', { name: 'More actions' });

      expect(trailingZone.contains(overflowTrigger)).toBe(true);
      expect(
        trailingZone.querySelector('[data-testid="sync-status-badge"]'),
        'the badge moves behind the overflow trigger instead of staying inline',
      ).toBeNull();
      expect(
        trailingZone.querySelector('[data-testid="presence-bar"]'),
        'the presence bar moves behind the overflow trigger instead of staying inline',
      ).toBeNull();
      expect(
        syncToastsHosts.mounted,
        'moving the visible sync surfaces behind the trigger must not take the sync-toast machine with them',
      ).toBe(1);
      expect(
        window.innerWidth,
        'the jsdom viewport stays roomy, so a collapse here cannot be viewport-driven',
      ).toBeGreaterThan(500);
    } finally {
      restoreMetrics();
    }
  });

  test('keeps the sync-toast machine mounted outside the collapsible trailing rail', async () => {
    const restoreMetrics = mockHeaderMetrics({ header: 107, leading: 57, trailing: 218 });

    try {
      await renderMeasuredHeader();

      expect(screen.getByRole('button', { name: 'More actions' })).toBeTruthy();
      expect(
        screen.queryByTestId('presence-bar'),
        'the presence bar sits behind a closed popover here, so it cannot be the hook host',
      ).toBeNull();
      expect(
        syncToastsHosts.mounted,
        'useSyncToasts must run from a host that the collapse cannot unmount',
      ).toBe(1);
      expect(syncToastsHookCalls.at(-1)?.[1]).toBe('docs/notes');
    } finally {
      restoreMetrics();
    }
  });

  test('opening the overflow menu reveals every action the collapse took out of the rail', async () => {
    const user = userEvent.setup();
    const restoreMetrics = mockHeaderMetrics({ header: 107, leading: 57, trailing: 218 });

    try {
      await renderMeasuredHeader();
      await user.click(screen.getByTestId('header-overflow-actions-trigger'));

      const panel = await waitFor(() => {
        const found = document.querySelector('[data-editor-header-overflow-actions]');
        expect(found, 'the overflow trigger must open a panel').not.toBeNull();
        return found as HTMLElement;
      });
      expect(panel.contains(screen.getByRole('button', { name: 'Share' }))).toBe(true);
      expect(panel.contains(screen.getByRole('button', { name: 'Settings' }))).toBe(true);
      expect(panel.contains(screen.getByRole('button', { name: 'Resources' }))).toBe(true);
      expect(panel.querySelector('[data-testid="sync-status-badge"]')).not.toBeNull();
      expect(panel.querySelector('[data-testid="presence-bar"]')).not.toBeNull();
    } finally {
      restoreMetrics();
    }
  });

  test('mirrors an unresolved sync state onto the collapsed overflow trigger', async () => {
    gitSyncStatus = { state: 'idle', conflictCount: 2, hasRemote: true };
    const restoreMetrics = mockHeaderMetrics({ header: 107, leading: 57, trailing: 218 });

    try {
      await renderMeasuredHeader();
      const trigger = screen.getByTestId('header-overflow-actions-trigger');

      expect(
        trigger.getAttribute('aria-label'),
        'collapsing the sync badge must not leave the trigger claiming there is nothing to see',
      ).toBe('More actions (Conflict)');
      expect(
        trigger
          .querySelector('[data-testid="header-overflow-actions-sync-indicator"]')
          ?.getAttribute('data-sync-attention'),
      ).toBe('conflict');
    } finally {
      restoreMetrics();
    }
  });

  test('leaves the collapsed overflow trigger unadorned while sync is healthy', async () => {
    gitSyncStatus = { state: 'idle', conflictCount: 0, hasRemote: true };
    const restoreMetrics = mockHeaderMetrics({ header: 107, leading: 57, trailing: 218 });

    try {
      await renderMeasuredHeader();
      const trigger = screen.getByTestId('header-overflow-actions-trigger');

      expect(trigger.getAttribute('aria-label')).toBe('More actions');
      expect(
        trigger.querySelector('[data-testid="header-overflow-actions-sync-indicator"]'),
        'a healthy sync must not raise the attention indicator',
      ).toBeNull();
    } finally {
      restoreMetrics();
    }
  });

  test('keeps the trailing rail inline when its expanded width fits the available header space', async () => {
    const restoreMetrics = mockHeaderMetrics({ header: 1_000, leading: 100, trailing: 300 });

    try {
      const header = await renderMeasuredHeader();
      const trailingZone = header.querySelector('[data-editor-header-actions]') as HTMLElement;

      expect(screen.queryByRole('button', { name: 'More actions' })).toBeNull();
      expect(document.querySelector('[data-editor-header-overflow-actions]')).toBeNull();
      expect(trailingZone.contains(screen.getByRole('button', { name: 'Settings' }))).toBe(true);
      expect(trailingZone.contains(screen.getByRole('button', { name: 'Resources' }))).toBe(true);
      expect(trailingZone.querySelector('[data-testid="sync-status-badge"]')).toBeTruthy();
    } finally {
      restoreMetrics();
    }
  });

  test('counts the leading rail offset against the available header space', async () => {
    const restoreMetrics = mockHeaderMetrics({
      header: 300,
      leading: 57,
      leadingOffset: 40,
      trailing: 218,
    });

    try {
      await renderMeasuredHeader();

      expect(
        screen.queryByRole('button', { name: 'More actions' }),
        'a 218px trailing rail does not fit the 203px left of a 300px header once the 40px leading offset is counted',
      ).not.toBeNull();
    } finally {
      restoreMetrics();
    }
  });

  test('never collapses the trailing rail while the header is unmeasured', async () => {
    const restoreMetrics = mockHeaderMetrics({ header: 0, leading: 57, trailing: 218 });

    try {
      const header = await renderMeasuredHeader();
      const trailingZone = header.querySelector('[data-editor-header-actions]') as HTMLElement;

      expect(screen.queryByRole('button', { name: 'More actions' })).toBeNull();
      expect(document.querySelector('[data-editor-header-overflow-actions]')).toBeNull();
      expect(trailingZone.contains(screen.getByRole('button', { name: 'Settings' }))).toBe(true);
    } finally {
      restoreMetrics();
    }
  });

  test('reads the collapse verdict off measured width, not the file-navigator state', async () => {
    const cramped = { header: 107, leading: 57, trailing: 218 };

    expect(await trailingRailCollapses('expanded', cramped)).toBe(true);
    expect(await trailingRailCollapses('collapsed', cramped)).toBe(true);
  });

  test('a collapsed trailing rail stays collapsed when its own collapsed width is re-measured', async () => {
    const observer = captureResizeObserver();
    const restoreMetrics = mockHeaderMetrics({
      header: 107,
      leading: 57,
      trailing: 218,
      collapsedTrailing: 36,
    });

    try {
      await renderMeasuredHeader();
      expect(screen.queryByRole('button', { name: 'More actions' })).not.toBeNull();

      for (const pass of [1, 2, 3]) {
        observer.flush();
        expect(
          screen.queryByRole('button', { name: 'More actions' }),
          `re-measurement pass ${pass} re-expanded the rail even though the available width never changed`,
        ).not.toBeNull();
      }
    } finally {
      restoreMetrics();
      observer.restore();
    }
  });

  test('re-measures the frozen expanded width when the trailing rail content changes', async () => {
    const observer = captureResizeObserver();
    let restoreMetrics = mockHeaderMetrics({
      header: 107,
      leading: 57,
      trailing: 218,
      collapsedTrailing: 36,
    });

    try {
      await renderMeasuredHeader();
      expect(screen.queryByRole('button', { name: 'More actions' })).not.toBeNull();

      restoreMetrics();
      restoreMetrics = mockHeaderMetrics({
        header: 107,
        leading: 57,
        trailing: 40,
        collapsedTrailing: 36,
      });
      activeDocName = '__skill__/project/my-skill';
      rerenderHeader?.(<div>tabs</div>);

      await waitFor(() =>
        expect(
          screen.queryByRole('button', { name: 'More actions' }),
          'the cached expanded width never invalidates, so the rail latches collapsed at a width where it now fits',
        ).toBeNull(),
      );
      observer.flush();
      expect(
        screen.queryByRole('button', { name: 'More actions' }),
        'the honest re-measure must read the new 40px rail, not bounce straight back to the stale 218px',
      ).toBeNull();
    } finally {
      restoreMetrics();
      observer.restore();
    }
  });

  test('hides the tab strip when the header cannot fit the strip reservations', async () => {
    const restoreMetrics = mockHeaderMetrics({
      header: 94,
      leading: 57,
      tabs: 94,
      trailing: 218,
      collapsedTrailing: 36,
    });

    try {
      const header = await renderHeaderAwaitingTabSuppression();
      const tabHost = header.querySelector('[data-editor-header-tabs]') as HTMLElement;

      expectVisualClassTokens(tabHost.className, ['invisible']);
      expect(
        screen.queryByRole('button', { name: 'More actions' }),
        'a 94px header collapses the trailing rail as well, so the strip is not merely unmeasured',
      ).not.toBeNull();
    } finally {
      restoreMetrics();
    }
  });

  test('a collapsed trailing rail does not by itself hide the tab strip', async () => {
    const restoreMetrics = mockHeaderMetrics({
      header: 107,
      leading: 57,
      tabs: 107,
      trailing: 218,
      collapsedTrailing: 36,
    });

    try {
      const header = await renderMeasuredHeader();
      const tabHost = header.querySelector('[data-editor-header-tabs]') as HTMLElement;

      expect(screen.queryByRole('button', { name: 'More actions' })).not.toBeNull();
      expect(
        tabHost.getAttribute('data-editor-header-tabs-suppressed'),
        'the strip hides on its own reservation arithmetic, never on the collapse verdict',
      ).toBeNull();
      expectVisualClassTokensAbsent(tabHost.className, ['invisible']);
    } finally {
      restoreMetrics();
    }
  });

  test('keeps the tab strip visible when the header has room for both rails', async () => {
    const restoreMetrics = mockHeaderMetrics({
      header: 900,
      leading: 100,
      tabs: 900,
      trailing: 300,
    });

    try {
      const header = await renderMeasuredHeader();
      const tabHost = header.querySelector('[data-editor-header-tabs]') as HTMLElement;

      expect(
        tabHost.getAttribute('data-editor-header-tabs-suppressed'),
        '900px of header leaves 492px of tab area, so the strip must not hide',
      ).toBeNull();
      expectVisualClassTokensAbsent(tabHost.className, ['invisible']);
      expect(screen.queryByRole('button', { name: 'More actions' })).toBeNull();
    } finally {
      restoreMetrics();
    }
  });

  test('an active doc yields a doc-scope share input', async () => {
    activeDocName = 'docs/notes';
    activeTarget = { kind: 'doc' };
    await renderHeader();

    expect(lastShareInput).toEqual({ kind: 'doc', docName: 'docs/notes' });
  });

  test('a selected folder yields a folder-scope share input', async () => {
    activeDocName = null;
    activeTarget = { kind: 'folder', folderPath: 'guides' };
    await renderHeader();

    expect(lastShareInput).toEqual({ kind: 'folder', folderRelativePath: 'guides' });
  });

  test('nothing open or selected defaults to sharing the project root', async () => {
    activeDocName = null;
    activeTarget = null;
    await renderHeader();

    expect(lastShareInput).toEqual({ kind: 'folder', folderRelativePath: '' });
  });

  test('a managed-artifact doc (skill/template) keeps the share trigger disabled', async () => {
    activeDocName = '__skill__/project/my-skill';
    activeTarget = { kind: 'doc' };
    await renderHeader();

    expect(lastShareInput).toBeNull();
  });

  test('a non-shareable asset target keeps the share trigger disabled', async () => {
    activeDocName = null;
    activeTarget = { kind: 'asset', assetPath: 'img/logo.png' };
    await renderHeader();

    expect(lastShareInput).toBeNull();
  });
});
