import * as actualLinguiMacro from '@lingui/react/macro';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ComponentProps, ReactNode } from 'react';
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
let isDraggingRail = false;
let singleFile = false;
// Captures the `input` prop EditorHeader hands to ShareButton.
let lastShareInput: unknown;
const onOpenSearch = vi.fn(() => {});

vi.doMock('@/editor/DocumentContext', () => ({
  useDocumentContext: () => ({ activeDocName, activeTarget }),
}));

vi.doMock('@/lib/single-file-mode', () => ({
  useSingleFileMode: () => singleFile,
}));

vi.doMock('@/components/ui/sidebar', () => ({
  useSidebar: () => ({ state: sidebarState, isDraggingRail }),
  SidebarTrigger: ({ className, ...props }: ComponentProps<'button'>) => (
    <button type="button" data-testid="sidebar-trigger" className={className} {...props}>
      sidebar
    </button>
  ),
}));

vi.doMock('./EditorTabs', () => ({
  EditorTabs: () => <div data-testid="editor-tabs" />,
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

function setElectronHost(enabled: boolean) {
  Object.defineProperty(window, 'okDesktop', {
    configurable: true,
    value: enabled ? {} : undefined,
  });
}

async function renderHeader() {
  const { EditorHeader } = await import('./EditorHeader');
  render(
    <TooltipProvider delayDuration={0}>
      <EditorHeader onOpenSearch={onOpenSearch} />
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
    isDraggingRail = false;
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

    expect(header.getAttribute('data-electron-drag')).toBe('');
    expectVisualClassTokens(header.className, [
      '[-webkit-app-region:drag]',
      'pl-[var(--ok-titlebar-reserve-left,1rem)]',
      'motion-safe:transition-[padding]',
    ]);
    expectVisualClassTokens(screen.getByTestId('sidebar-trigger').className, [
      '[-webkit-app-region:no-drag]',
    ]);
    const leftZone = header.children.item(0) as HTMLElement;
    const workspaceNavigation = screen.getByRole('group', { name: 'Workspace navigation' });
    const search = screen.getByRole('button', { name: /^Search/ });
    const navigation = screen.getByTestId('navigation-history-controls');
    const separator = leftZone.querySelector('[data-slot="separator"]') as HTMLElement;
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
    expectVisualClassTokens(navigation.className, ['[-webkit-app-region:no-drag]']);
    const rightZone = header.children.item(1) as HTMLElement;
    expectVisualClassTokens(rightZone.className, ['*:[-webkit-app-region:no-drag]']);
  });

  test('Electron expanded sidebar keeps drag region but does not reserve traffic-light padding', async () => {
    setElectronHost(true);
    sidebarState = 'expanded';
    const header = await renderHeader();

    expectVisualClassTokens(header.className, ['[-webkit-app-region:drag]']);
    expectVisualClassTokensAbsent(header.className, ['pl-[var(--ok-titlebar-reserve-left,1rem)]']);
    expect(screen.queryByTestId('navigation-history-controls')).toBeNull();
  });

  test('rail drag keeps the reserve but drops the padding transition so it snaps with the sidebar', async () => {
    // During a rail drag the sidebar group runs duration-0 and collapses
    // instantly; an animated reserve would lag behind and park the
    // collapse/search controls under the traffic lights. The reserve must be
    // present (collapsed) but the transition must be absent (snap).
    setElectronHost(true);
    sidebarState = 'collapsed';
    isDraggingRail = true;
    const header = await renderHeader();

    expectVisualClassTokens(header.className, ['pl-[var(--ok-titlebar-reserve-left,1rem)]']);
    expectVisualClassTokensAbsent(header.className, ['motion-safe:transition-[padding]']);
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

  test('renders tabs and action cluster without project or asset-title chrome', async () => {
    await renderHeader();

    expect(screen.getByTestId('editor-tabs')).toBeTruthy();
    expect(screen.queryByTestId('open-in-agent-menu')).toBeNull();
    expect(screen.queryByText('projectName')).toBeNull();
    expect(screen.queryByText('assetFileName')).toBeNull();
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
