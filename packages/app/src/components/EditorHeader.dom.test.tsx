import * as actualLinguiMacro from '@lingui/react/macro';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ComponentProps, ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
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
// Captures the `input` prop EditorHeader hands to ShareButton.
let lastShareInput: unknown;
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

vi.doMock('./SyncStatusBadge', () => ({
  SyncStatusBadge: () => <div data-testid="sync-status-badge" />,
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

async function renderHeader(tabs?: ReactNode) {
  const { EditorHeader } = await import('./EditorHeader');
  render(
    <TooltipProvider delayDuration={0}>
      <EditorHeader onOpenSearch={onOpenSearch}>{tabs}</EditorHeader>
    </TooltipProvider>,
  );
  return document.querySelector('header') as HTMLElement;
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
      // 300px actions + 137px reserve - 200px outside the tab host.
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
    // No target, no doc → empty editor defaults to the content root.
    activeDocName = null;
    activeTarget = null;
    await renderHeader();

    expect(lastShareInput).toEqual({ kind: 'folder', folderRelativePath: '' });
  });

  test('a managed-artifact doc (skill/template) keeps the share trigger disabled', async () => {
    // Managed-artifact doc name (`__skill__/<scope>/<name>`) must not be shareable.
    activeDocName = '__skill__/project/my-skill';
    activeTarget = { kind: 'doc' };
    await renderHeader();

    expect(lastShareInput).toBeNull();
  });

  test('a non-shareable asset target keeps the share trigger disabled', async () => {
    // Asset target has no shareable doc name and must not fall through to root.
    activeDocName = null;
    activeTarget = { kind: 'asset', assetPath: 'img/logo.png' };
    await renderHeader();

    expect(lastShareInput).toBeNull();
  });
});
