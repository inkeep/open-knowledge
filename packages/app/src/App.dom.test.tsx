import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import {
  hashFromDocName,
  pushHashWithoutNavigation,
  replaceHashWithoutNavigation,
} from '@/lib/doc-hash';
import { matchesKeyboardShortcut, type ShortcutEventLike } from '@/lib/keyboard-shortcuts';
import {
  __resetLocalMenuActionBusForTests,
  emitLocalMenuAction,
} from '@/lib/local-menu-action-bus';
import {
  __resetPaneVisibilityStoreForTests,
  type PaneVisibilityRequest,
  paneVisibilityStore,
} from '@/lib/pane-visibility-store';
import {
  consumeHashNavigationSuppression,
  recordAppShellCrashTrip,
  resetTabSessionRestoreSuppression,
} from '@/lib/tab-session-restore-suppression';
import { noteWorkspaceHashWrite } from '@/lib/workspace-hash-writes';
import {
  expectVisualClassTokens,
  expectVisualClassTokensAbsent,
} from '@/test-utils/visual-contract';

type NavigationTarget =
  | { kind: 'doc'; target: string; docName: string }
  | { kind: 'folder-index'; target: string; docName: string; folderPath: string }
  | { kind: 'folder'; target: string; folderPath: string }
  | { kind: 'asset'; target: string; assetPath: string; mediaKind: string }
  | { kind: 'missing'; target: string };

let activeTarget: NavigationTarget | null = null;
let pages = new Set<string>();
let pageMeta = new Map<string, unknown>();
let pagesBySlug = new Map<string, unknown>();
let pagesByBasename = new Map<string, unknown>();
let folderPaths = new Set<string>();
let assetPaths = new Set<string>();
let filePaths = new Set<string>();
let openTabs: string[] = [];
let loading = false;
let singleFileMode = false;
let tabSessionLoaded = true;
let mergedConfig: { editor: { previewTabs: boolean } } | null = null;
let fetchApiConfigMock = vi.fn(() =>
  Promise.resolve({
    status: 'ok' as const,
    config: {
      collabUrl: null,
      previewUrl: null,
      port: 0,
      singleFile: false,
    },
  }),
);
let clearTargetMock = vi.fn(() => {});
let syncOpenTabsWithKnownTargetsMock = vi.fn(() => {});
let promoteAllPreviewTabsMock = vi.fn(() => {});
let openTargetTransitionMock = vi.fn(
  (
    _: NavigationTarget,
    _options: { disposition: 'preview' | 'permanent'; consumeActiveNewTab: boolean },
  ) => {},
);
let resolveNavigationTargetMock = vi.fn(
  (docName: string): NavigationTarget => ({ kind: 'doc', target: docName, docName }),
);
let downgradeFolderIndexForHashNavMock = vi.fn((target: NavigationTarget) => target);
let withLargeFileOpenGuardMock = vi.fn((target: NavigationTarget) => target);

vi.doMock('@/lib/perf', () => ({
  mark: () => {},
  ProfilerBoundary: ({ children }: { children: ReactNode }) => children,
}));

vi.doMock('@/editor/DocumentContext', () => ({
  DocumentProvider: ({ children }: { children: ReactNode }) => (
    <div data-testid="document-provider">{children}</div>
  ),
  useDocumentContext: () => ({
    activeDocName: activeTarget?.kind === 'doc' ? activeTarget.docName : null,
    activeTabId:
      activeTarget?.kind === 'doc'
        ? activeTarget.docName
        : activeTarget?.kind === 'missing'
          ? activeTarget.target
          : null,
    activeTarget,
    clearTarget: clearTargetMock,
    promoteAllPreviewTabs: promoteAllPreviewTabsMock,
    syncOpenTabsWithKnownTargets: syncOpenTabsWithKnownTargetsMock,
    tabSessionLoaded,
    openTabs,
    closeDocument: () => {},
  }),
  useDocumentTransition: () => ({
    openTargetTransition: openTargetTransitionMock,
  }),
}));

vi.doMock('@/components/PageListContext', () => ({
  PageListProvider: ({ children }: { children: ReactNode }) => (
    <div data-testid="page-list-provider">{children}</div>
  ),
  usePageList: () => ({
    assetPaths,
    filePaths,
    folderPaths,
    loading,
    pageMeta,
    pages,
    pagesBySlug,
    pagesByBasename,
  }),
  useOptionalPageList: () => ({
    assetPaths,
    filePaths,
    folderPaths,
    loading,
    pageMeta,
    pages,
    pagesBySlug,
    pagesByBasename,
  }),
}));

vi.doMock('@/components/navigation-targets', () => ({
  resolveNavigationTarget: (...args: Parameters<typeof resolveNavigationTargetMock>) =>
    resolveNavigationTargetMock(...args),
  downgradeFolderIndexForHashNav: (target: NavigationTarget) =>
    downgradeFolderIndexForHashNavMock(target),
  withLargeFileOpenGuard: (target: NavigationTarget) => withLargeFileOpenGuardMock(target),
}));

vi.doMock('@/lib/config-provider', () => ({
  ConfigProvider: ({ children }: { children: ReactNode }) => (
    <div data-testid="config-provider">{children}</div>
  ),
  useConfigContext: () => ({ merged: mergedConfig }),
}));

vi.doMock('@/lib/config-context', () => ({
  useConfigContext: () => ({ merged: mergedConfig }),
}));

vi.doMock('@/components/handoff/TerminalLaunchContext', () => ({
  TerminalLaunchProvider: ({ value, children }: { value: unknown; children: ReactNode }) => (
    <div data-testid="terminal-launch-provider" data-enabled={String(value !== null)}>
      {children}
    </div>
  ),
}));

vi.doMock('@/lib/api-config', () => ({
  fetchApiConfig: (...args: Parameters<typeof fetchApiConfigMock>) => fetchApiConfigMock(...args),
}));

vi.doMock('@/lib/use-server-keepalive', () => ({
  useServerKeepalive: () => {},
}));

vi.doMock('@/lib/single-file-mode', () => ({
  SingleFileModeProvider: ({ children }: { children: ReactNode }) => (
    <div data-testid="single-file-mode-provider">{children}</div>
  ),
  useSingleFileMode: () => singleFileMode,
}));

vi.doMock('@/components/ConnectingBanner', () => ({
  ConnectingBanner: () => <div data-testid="connecting-banner" />,
}));

vi.doMock('@/components/SystemDocSubscriber', () => ({
  SystemDocSubscriber: () => <div data-testid="system-doc-subscriber" />,
}));

vi.doMock('@/editor/EditorLifecycleFlush', () => ({
  EditorLifecycleFlush: () => null,
}));
vi.doMock('@/editor/BackgroundThrottleReporter', () => ({
  BackgroundThrottleReporter: () => null,
}));
vi.doMock('@/editor/StaleTabReloadPrompt', () => ({
  StaleTabReloadPrompt: () => null,
}));

vi.doMock('@/components/McpConsentDialog', () => ({
  McpConsentDialog: () => <div data-testid="mcp-consent-dialog" />,
}));

vi.doMock('@/components/CommandPalette', () => ({
  CommandPalette: ({ open }: { open: boolean }) => (
    <div data-testid="command-palette" data-open={String(open)} />
  ),
}));

vi.doMock('@/components/AuthModal', () => ({
  AuthModal: ({ open }: { open: boolean }) => (
    <div data-testid="auth-modal" data-open={String(open)} />
  ),
}));

vi.doMock('@/components/InstallInClaudeDesktopDialog', () => ({
  InstallInClaudeDesktopDialog: ({ open }: { open: boolean }) => (
    <div data-testid="install-dialog" data-open={String(open)} />
  ),
}));

vi.doMock('@/components/CreateProjectMenuTrigger', () => ({
  CreateProjectMenuTrigger: () => <div data-testid="create-project-menu-trigger" />,
}));

vi.doMock('@/components/ReportBugMenuTrigger', () => ({
  ReportBugMenuTrigger: () => <div data-testid="report-bug-menu-trigger" />,
}));

vi.doMock('@/components/FeedbackMenuTrigger', () => ({
  FeedbackMenuTrigger: () => <div data-testid="feedback-menu-trigger" />,
}));

vi.doMock('@/components/ShareBranchSwitchDialog', () => ({
  ShareBranchSwitchDialog: () => <div data-testid="share-branch-switch-dialog" />,
}));

vi.doMock('@/components/ShareReceiveMissDialog', () => ({
  ShareReceiveMissDialog: () => <div data-testid="share-receive-miss-dialog" />,
}));

vi.doMock('@/components/NewItemDialog', () => ({
  isNewItemShortcut: (event: ShortcutEventLike) =>
    matchesKeyboardShortcut(event, 'new-item', 'mac'),
  NewItemDialog: ({ open, initialDir }: { open: boolean; initialDir: string }) => (
    <div data-testid="new-item-dialog" data-open={String(open)} data-initial-dir={initialDir} />
  ),
}));

vi.doMock('@/components/FileSidebar', () => ({
  FileSidebar: () => <div data-testid="file-sidebar">Sidebar</div>,
}));

vi.doMock('@/components/UpdateNotices', () => ({
  UpdateNotices: () => <div data-testid="update-notices" />,
}));

vi.doMock('@/components/FeedbackCard', () => ({
  FeedbackCardMount: () => <div data-testid="feedback-card-mount" />,
}));

vi.doMock('@/components/EditorPane', async () => {
  const { useState } = await import('react');
  const { useAttachFileListHost, useFileListHost } = await import('@/components/FileListHost');
  function EditorPane() {
    const host = useFileListHost();
    const [slot, setSlot] = useState<HTMLDivElement | null>(null);
    useAttachFileListHost(host, slot);
    return (
      <div data-testid="editor-pane">
        <div data-testid="editor-file-list-slot" ref={setSlot} />
      </div>
    );
  }
  return { EditorPane };
});

vi.doMock('@/components/ui/sidebar', () => ({
  SidebarProvider: ({ children, className }: { children: ReactNode; className?: string }) => (
    <section data-testid="sidebar-provider" className={className}>
      {children}
    </section>
  ),
}));

vi.doMock('@/components/ShareReceiveDialog', () => ({
  ShareReceiveDialog: () => <div data-testid="share-receive-dialog" />,
}));

vi.doMock('@/lib/share/clone-controller', () => ({
  createCloneController: () => ({}),
}));

vi.doMock('@/lib/transports/auth-query-transport', () => ({
  httpAuthQueryTransport: () => ({}),
}));

vi.doMock('@/lib/transports/clone-transport', () => ({
  httpCloneTransport: () => ({}),
}));

const { App } = await import('./App');

function createBridge({ ptyAvailable = true }: { ptyAvailable?: boolean } = {}) {
  return {
    editor: {
      notifyActiveTargetChanged: vi.fn(() => {}),
    },
    config: {
      mode: 'editor' as const,
      ptyAvailable,
    },
    state: {
      query: () => Promise.resolve({ channel: 'latest' as const }),
    },
  };
}

function createNoteWindowBridge() {
  return { ...createBridge(), config: { mode: 'note' as const, ptyAvailable: true } };
}

function appMain(): HTMLElement {
  const main = document.querySelector<HTMLElement>('[data-app-main]');
  if (main == null) throw new Error('the app content wrapper is missing');
  expect(main.getAttribute('role')).toBeNull();
  expect(main.tagName).toBe('DIV');
  return main;
}

function renderApp({ bridge = null }: { bridge?: ReturnType<typeof createBridge> | null } = {}) {
  if (bridge) {
    Object.defineProperty(window, 'okDesktop', {
      configurable: true,
      value: bridge,
    });
  }
  return render(<App />, { wrapper: TooltipProvider });
}

function setHash(hash: string) {
  window.history.replaceState(null, '', `${window.location.pathname}${hash}`);
}

describe('App runtime wiring', () => {
  beforeEach(() => {
    cleanup();
    __resetLocalMenuActionBusForTests();
    Reflect.deleteProperty(window, 'okDesktop');
    setHash('');
    activeTarget = null;
    pages = new Set(['reports/index']);
    pageMeta = new Map();
    pagesBySlug = new Map();
    pagesByBasename = new Map();
    folderPaths = new Set(['reports']);
    assetPaths = new Set();
    filePaths = new Set();
    openTabs = [];
    loading = false;
    singleFileMode = false;
    tabSessionLoaded = true;
    mergedConfig = null;
    fetchApiConfigMock = vi.fn(() =>
      Promise.resolve({
        status: 'ok' as const,
        config: {
          collabUrl: null,
          previewUrl: null,
          port: 0,
          singleFile: false,
        },
      }),
    );
    globalThis.fetch = vi.fn(() => Promise.resolve(new Response(null, { status: 204 }))) as never;
    clearTargetMock = vi.fn(() => {});
    syncOpenTabsWithKnownTargetsMock = vi.fn(() => {});
    promoteAllPreviewTabsMock = vi.fn(() => {});
    openTargetTransitionMock = vi.fn(
      (
        _: NavigationTarget,
        _options: { disposition: 'preview' | 'permanent'; consumeActiveNewTab: boolean },
      ) => {},
    );
    resolveNavigationTargetMock = vi.fn(
      (docName: string): NavigationTarget => ({ kind: 'doc', target: docName, docName }),
    );
    downgradeFolderIndexForHashNavMock = vi.fn((target: NavigationTarget) => target);
    withLargeFileOpenGuardMock = vi.fn((target: NavigationTarget) => target);
  });

  afterEach(() => {
    cleanup();
    __resetLocalMenuActionBusForTests();
    vi.restoreAllMocks();
  });

  describe('note window chrome reduction', () => {
    test('drops the sidebar, the palette, and agent-driven navigation', () => {
      renderApp({ bridge: createNoteWindowBridge() as ReturnType<typeof createBridge> });

      expect(screen.queryByTestId('file-sidebar')).toBeNull();
      expect(screen.queryByTestId('command-palette')).toBeNull();
      expect(screen.queryByTestId('system-doc-subscriber')).toBeNull();
      expectVisualClassTokens(appMain().className, ['h-screen']);
      expectVisualClassTokensAbsent(appMain().className, [
        'h-[calc(100vh-var(--layout-inset-offset))]',
      ]);
    });

    test('single-file windows reserve the shared header height like ordinary windows', () => {
      singleFileMode = true;
      renderApp({ bridge: createBridge() });

      expect(screen.queryByTestId('file-sidebar')).toBeNull();
      expectVisualClassTokens(appMain().className, [
        'h-[calc(100vh-var(--ok-app-header-height,0px))]',
      ]);
      expectVisualClassTokensAbsent(appMain().className, ['h-screen']);
    });

    test('keeps the editor and the connecting banner', () => {
      renderApp({ bridge: createNoteWindowBridge() as ReturnType<typeof createBridge> });

      expect(screen.getByTestId('editor-pane')).not.toBeNull();
      expect(screen.getByTestId('connecting-banner')).not.toBeNull();
    });

    test('an ordinary editor window keeps all of it', () => {
      renderApp({ bridge: createBridge() });

      expect(screen.getByTestId('file-sidebar')).not.toBeNull();
      expect(screen.getByTestId('command-palette')).not.toBeNull();
      expect(screen.getByTestId('system-doc-subscriber')).not.toBeNull();
      expect(screen.getByTestId('editor-pane')).not.toBeNull();
      expectVisualClassTokens(appMain().className, [
        'h-[calc(100vh-var(--ok-app-header-height,0px))]',
      ]);
      expectVisualClassTokensAbsent(appMain().className, ['h-screen']);
    });
  });

  test('imports and mounts the app shell providers and core surfaces', () => {
    renderApp();

    expect(screen.getByTestId('document-provider')).not.toBeNull();
    expect(screen.getByTestId('config-provider')).not.toBeNull();
    expect(screen.getByTestId('page-list-provider')).not.toBeNull();
    expect(screen.getByTestId('system-doc-subscriber')).not.toBeNull();
    expect(screen.getByTestId('file-sidebar')).not.toBeNull();
    expect(screen.getByTestId('editor-pane')).not.toBeNull();
    expect(
      screen.getByTestId('editor-file-list-slot').contains(screen.getByTestId('file-sidebar')),
    ).toBe(true);
  });

  test('a desktop host without PTY capability keeps terminal launching disabled', () => {
    renderApp({ bridge: createBridge({ ptyAvailable: false }) });

    expect(screen.getByTestId('terminal-launch-provider').getAttribute('data-enabled')).toBe(
      'false',
    );
  });

  test('promotes preview tabs when the setting changes from enabled to disabled', async () => {
    mergedConfig = { editor: { previewTabs: true } };
    const view = renderApp();

    expect(promoteAllPreviewTabsMock).not.toHaveBeenCalled();

    mergedConfig = { editor: { previewTabs: false } };
    view.rerender(<App />);

    await waitFor(() => {
      expect(promoteAllPreviewTabsMock).toHaveBeenCalledTimes(1);
    });

    view.rerender(<App />);
    expect(promoteAllPreviewTabsMock).toHaveBeenCalledTimes(1);
  });

  test('passes tracked non-markdown files to tab reconciliation', async () => {
    filePaths = new Set(['LICENSE', 'pnpm-workspace.yaml']);

    renderApp();

    await waitFor(() => {
      expect(syncOpenTabsWithKnownTargetsMock).toHaveBeenCalledWith({
        pages,
        folderPaths,
        assetPaths,
        filePaths,
      });
    });
  });

  test('Cmd/Ctrl-comma opens settings via the canonical hash and ignores text inputs', () => {
    renderApp();

    const input = document.createElement('input');
    document.body.append(input);
    fireEvent.keyDown(input, { key: ',', metaKey: true });
    expect(window.location.hash).toBe('');

    fireEvent.keyDown(window, { key: ',', metaKey: true });
    expect(window.location.hash).toBe('#settings');
  });

  test('does not claim Cmd+Shift+N from the desktop new-folder accelerator', () => {
    renderApp({ bridge: createBridge() });

    const event = new KeyboardEvent('keydown', {
      key: 'N',
      metaKey: true,
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });
    fireEvent(window, event);

    expect(event.defaultPrevented).toBe(false);
    expect(screen.getByTestId('new-item-dialog').getAttribute('data-open')).toBe('false');
  });

  test('hash navigation opens the downgraded folder-index target, not the pre-downgrade result', async () => {
    const resolved: NavigationTarget = {
      kind: 'folder-index',
      target: 'reports/index',
      docName: 'reports/index',
      folderPath: 'reports',
    };
    const downgraded: NavigationTarget = {
      kind: 'folder',
      target: 'reports',
      folderPath: 'reports',
    };
    resolveNavigationTargetMock = vi.fn(() => resolved);
    downgradeFolderIndexForHashNavMock = vi.fn(() => downgraded);
    setHash('#/reports/');

    renderApp();

    await waitFor(() => {
      expect(downgradeFolderIndexForHashNavMock).toHaveBeenCalledWith(resolved);
      expect(openTargetTransitionMock).toHaveBeenCalledWith(downgraded, {
        deliberate: false,
        disposition: 'permanent',
        consumeActiveNewTab: true,
      });
    });
    expect(openTargetTransitionMock).not.toHaveBeenCalledWith(resolved);
  });

  test('hash navigation defers an unresolvable folder hash instead of opening a tab', async () => {
    resolveNavigationTargetMock = vi.fn((docName: string) => ({
      kind: 'missing' as const,
      target: docName.replace(/\/+$/, ''),
    }));
    setHash('#/articles/.ok/');

    renderApp();

    await waitFor(() => {
      expect(resolveNavigationTargetMock).toHaveBeenCalledWith('articles/.ok/', expect.anything());
    });
    expect(openTargetTransitionMock).not.toHaveBeenCalled();
    expect(clearTargetMock).not.toHaveBeenCalled();
  });

  test('hash navigation still opens an unresolvable document hash in create mode', async () => {
    const missing: NavigationTarget = { kind: 'missing', target: 'articles/brand-new' };
    resolveNavigationTargetMock = vi.fn(() => missing);
    setHash('#/articles/brand-new');

    renderApp();

    await waitFor(() => {
      expect(openTargetTransitionMock).toHaveBeenCalledWith(missing, {
        deliberate: false,
        disposition: 'permanent',
        consumeActiveNewTab: true,
      });
    });
  });

  test('a document whose name contains a "#" opens instead of clearing the target', async () => {
    const target: NavigationTarget = {
      kind: 'doc',
      target: '# 2 - Tokens',
      docName: '# 2 - Tokens',
    };
    resolveNavigationTargetMock = vi.fn(() => target);
    setHash(hashFromDocName('# 2 - Tokens'));

    renderApp();

    await waitFor(() => {
      expect(resolveNavigationTargetMock).toHaveBeenCalledWith('# 2 - Tokens', expect.anything());
      expect(openTargetTransitionMock).toHaveBeenCalledWith(target, {
        deliberate: false,
        disposition: 'permanent',
        consumeActiveNewTab: true,
      });
    });
    expect(clearTargetMock).not.toHaveBeenCalled();
  });

  test('hash navigation keeps an open extension-qualified markdown tab exact', async () => {
    openTabs = ['docs/guide.mdx'];
    resolveNavigationTargetMock = vi.fn(() => ({
      kind: 'doc',
      target: 'docs/guide',
      docName: 'docs/guide',
    }));
    setHash('#/docs/guide.mdx');

    renderApp();

    await waitFor(() => {
      expect(openTargetTransitionMock).toHaveBeenCalledWith(
        {
          kind: 'doc',
          target: 'docs/guide.mdx',
          docName: 'docs/guide.mdx',
        },
        {
          deliberate: false,
          disposition: 'permanent',
          consumeActiveNewTab: true,
        },
      );
    });
    expect(resolveNavigationTargetMock).not.toHaveBeenCalled();
  });

  test('does not reopen an already-active hash target after tab state changes', async () => {
    activeTarget = { kind: 'doc', target: 'page-a', docName: 'page-a' };
    setHash('#/page-a');

    renderApp();

    await Promise.resolve();
    expect(openTargetTransitionMock).not.toHaveBeenCalled();
  });

  test('refreshes an active missing target after the page list resolves it', async () => {
    activeTarget = { kind: 'missing', target: 'page-a' };
    setHash('#/page-a');

    renderApp();

    await waitFor(() => {
      expect(openTargetTransitionMock).toHaveBeenCalledWith(
        { kind: 'doc', target: 'page-a', docName: 'page-a' },
        {
          deliberate: false,
          disposition: 'permanent',
          consumeActiveNewTab: true,
        },
      );
    });
  });

  test('defers hash navigation until the persisted tab session has restored', async () => {
    tabSessionLoaded = false;
    setHash('#/.editorconfig');
    const view = renderApp({ bridge: createBridge() });

    await Promise.resolve();
    expect(resolveNavigationTargetMock).not.toHaveBeenCalled();
    expect(openTargetTransitionMock).not.toHaveBeenCalled();

    tabSessionLoaded = true;
    view.rerender(<App />);

    await waitFor(() => {
      expect(openTargetTransitionMock).toHaveBeenCalledWith(
        {
          kind: 'doc',
          target: '.editorconfig',
          docName: '.editorconfig',
        },
        {
          deliberate: false,
          disposition: 'permanent',
          consumeActiveNewTab: true,
        },
      );
    });
  });

  test('navigation-history subscription cleans up before remount and invokes each action once', () => {
    const back = vi.spyOn(window.history, 'back').mockImplementation(() => {});
    const forward = vi.spyOn(window.history, 'forward').mockImplementation(() => {});
    renderApp();
    cleanup();
    renderApp();

    emitLocalMenuAction('navigate-back');
    expect(back).toHaveBeenCalledOnce();
    expect(forward).not.toHaveBeenCalled();

    emitLocalMenuAction('navigate-forward');
    expect(back).toHaveBeenCalledOnce();
    expect(forward).toHaveBeenCalledOnce();
  });

  test('history traversal reuses the preview slot instead of opening a permanent tab', async () => {
    setHash('#/page-a');
    renderApp();

    await waitFor(() => {
      expect(openTargetTransitionMock).toHaveBeenCalledWith(
        {
          kind: 'doc',
          target: 'page-a',
          docName: 'page-a',
        },
        {
          deliberate: false,
          disposition: 'permanent',
          consumeActiveNewTab: true,
        },
      );
    });

    pushHashWithoutNavigation('#/page-b');
    pushHashWithoutNavigation('#/page-c');
    openTargetTransitionMock.mockClear();

    window.history.back();

    await waitFor(() => {
      expect(window.location.hash).toBe('#/page-b');
      expect(openTargetTransitionMock).toHaveBeenCalledWith(
        {
          kind: 'doc',
          target: 'page-b',
          docName: 'page-b',
        },
        expect.objectContaining({
          deliberate: true,
          disposition: 'preview',
          consumeActiveNewTab: true,
        }),
      );
    });

    openTargetTransitionMock.mockClear();
    window.history.back();

    await waitFor(() => {
      expect(window.location.hash).toBe('#/page-a');
      expect(openTargetTransitionMock).toHaveBeenCalledWith(
        {
          kind: 'doc',
          target: 'page-a',
          docName: 'page-a',
        },
        expect.objectContaining({
          deliberate: true,
          disposition: 'preview',
          consumeActiveNewTab: true,
        }),
      );
    });

    openTargetTransitionMock.mockClear();
    window.history.forward();

    await waitFor(() => {
      expect(window.location.hash).toBe('#/page-b');
      expect(openTargetTransitionMock).toHaveBeenCalledWith(
        {
          kind: 'doc',
          target: 'page-b',
          docName: 'page-b',
        },
        expect.objectContaining({
          deliberate: true,
          disposition: 'preview',
          consumeActiveNewTab: true,
        }),
      );
    });
  });

  test('direct hash navigation preserves the active tab', async () => {
    setHash('#/page-a');
    renderApp();

    await waitFor(() => {
      expect(openTargetTransitionMock).toHaveBeenCalledWith(
        {
          kind: 'doc',
          target: 'page-a',
          docName: 'page-a',
        },
        {
          deliberate: false,
          disposition: 'permanent',
          consumeActiveNewTab: true,
        },
      );
    });

    openTargetTransitionMock.mockClear();
    window.history.pushState(null, '', `${window.location.pathname}#/page-b`);
    window.dispatchEvent(new PopStateEvent('popstate', { state: null }));
    window.dispatchEvent(new HashChangeEvent('hashchange'));

    await waitFor(() => {
      expect(openTargetTransitionMock).toHaveBeenCalledWith(
        {
          kind: 'doc',
          target: 'page-b',
          docName: 'page-b',
        },
        {
          deliberate: true,
          disposition: 'permanent',
          consumeActiveNewTab: true,
        },
      );
    });
  });

  async function renderOnPageA() {
    setHash('#/page-a');
    renderApp();
    await waitFor(() => {
      expect(openTargetTransitionMock).toHaveBeenCalledWith(
        { kind: 'doc', target: 'page-a', docName: 'page-a' },
        expect.objectContaining({ deliberate: false }),
      );
    });
    openTargetTransitionMock.mockClear();
  }

  test('a document opened from inside Settings is a deliberate open', async () => {
    await renderOnPageA();

    window.location.hash = '#settings';
    await waitFor(() => expect(window.location.hash).toBe('#settings'));
    window.location.hash = '#/page-b';

    await waitFor(() => {
      expect(openTargetTransitionMock).toHaveBeenCalledWith(
        { kind: 'doc', target: 'page-b', docName: 'page-b' },
        expect.objectContaining({ deliberate: true }),
      );
    });
  });

  test('closing Settings back to the document is not a deliberate open', async () => {
    await renderOnPageA();

    window.location.hash = '#settings';
    await waitFor(() => expect(window.location.hash).toBe('#settings'));
    window.history.back();

    await waitFor(() => {
      expect(window.location.hash).toBe('#/page-a');
      expect(openTargetTransitionMock).toHaveBeenCalledWith(
        { kind: 'doc', target: 'page-a', docName: 'page-a' },
        expect.objectContaining({ deliberate: false }),
      );
    });
  });

  test('a document opened after the install dialog closes is a deliberate open', async () => {
    await renderOnPageA();

    window.location.hash = '#install-claude-desktop';
    await waitFor(() => expect(window.location.hash).toBe('#install-claude-desktop'));
    replaceHashWithoutNavigation('');
    window.location.hash = '#/page-b';

    await waitFor(() => {
      expect(openTargetTransitionMock).toHaveBeenCalledWith(
        { kind: 'doc', target: 'page-b', docName: 'page-b' },
        expect.objectContaining({ deliberate: true }),
      );
    });
  });

  test('the first Back after the install dialog closes is a deliberate open', async () => {
    await renderOnPageA();
    pushHashWithoutNavigation('#/page-b');

    window.location.hash = '#install-claude-desktop';
    await waitFor(() => expect(window.location.hash).toBe('#install-claude-desktop'));
    replaceHashWithoutNavigation('');
    window.history.back();

    await waitFor(() => {
      expect(window.location.hash).toBe('#/page-b');
      expect(openTargetTransitionMock).toHaveBeenCalledWith(
        { kind: 'doc', target: 'page-b', docName: 'page-b' },
        expect.objectContaining({ deliberate: true }),
      );
    });
  });

  function editorRequestsFromClick(
    href: string,
    init: MouseEventInit = {},
    options: { readonly alreadyPrevented?: boolean } = {},
  ): PaneVisibilityRequest[] {
    renderApp();
    __resetPaneVisibilityStoreForTests();
    const requests: PaneVisibilityRequest[] = [];
    paneVisibilityStore.subscribeRequests((request) => requests.push(request));
    paneVisibilityStore.publish({
      editor: { open: false, onScreen: false },
      agents: null,
      terminal: null,
    });
    const link = document.createElement('a');
    link.setAttribute('href', href);
    const label = document.createElement('span');
    link.append(label);
    document.body.append(link);
    if (options.alreadyPrevented) link.addEventListener('click', (event) => event.preventDefault());

    fireEvent.click(label, init);

    link.remove();
    __resetPaneVisibilityStoreForTests();
    return requests;
  }

  test('a plain click on an in-app document link asks a hidden editor to show', () => {
    expect(editorRequestsFromClick('#/page-a')).toEqual([{ pane: 'editor', open: true }]);
  });

  test.each<[string, string, MouseEventInit, boolean]>([
    ['a Cmd click', '#/page-a', { metaKey: true }, false],
    ['a Ctrl click', '#/page-a', { ctrlKey: true }, false],
    ['a Shift click', '#/page-a', { shiftKey: true }, false],
    ['an Alt click', '#/page-a', { altKey: true }, false],
    ['a middle-button click', '#/page-a', { button: 1 }, false],
    ['a click something already handled', '#/page-a', {}, true],
    ['a click on a web link', 'https://example.com/docs', {}, false],
    ['a click on an email link', 'mailto:someone@example.com', {}, false],
    ['a click on an in-page fragment', '#section', {}, false],
  ])('%s leaves a hidden editor hidden', (_label, href, init, alreadyPrevented) => {
    expect(editorRequestsFromClick(href, init, { alreadyPrevented })).toEqual([]);
  });

  test('an address change to the document already open shows a hidden editor unless the workspace wrote it', async () => {
    activeTarget = { kind: 'doc', target: 'page-a', docName: 'page-a' };
    setHash('#/page-a');
    renderApp();
    await Promise.resolve();
    __resetPaneVisibilityStoreForTests();
    const requests: PaneVisibilityRequest[] = [];
    paneVisibilityStore.subscribeRequests((request) => requests.push(request));

    noteWorkspaceHashWrite('#/page-a');
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    expect(requests).toEqual([]);

    window.dispatchEvent(new HashChangeEvent('hashchange'));
    expect(requests).toEqual([{ pane: 'editor', open: true }]);
    expect(openTargetTransitionMock).not.toHaveBeenCalled();
    __resetPaneVisibilityStoreForTests();
  });

  test('active doc and folder targets are pushed to the desktop bridge', async () => {
    const bridge = createBridge();
    activeTarget = { kind: 'doc', target: 'docs/readme', docName: 'docs/readme' };

    renderApp({ bridge });

    await waitFor(() => {
      expect(bridge.editor.notifyActiveTargetChanged).toHaveBeenCalledWith({
        kind: 'doc',
        identifier: 'docs/readme',
      });
    });

    cleanup();
    activeTarget = { kind: 'folder', target: 'docs', folderPath: 'docs' };

    renderApp({ bridge });

    await waitFor(() => {
      expect(bridge.editor.notifyActiveTargetChanged).toHaveBeenCalledWith({
        kind: 'folder',
        identifier: 'docs',
      });
    });
  });

  test('active asset targets are pushed to the desktop bridge', async () => {
    const bridge = createBridge();
    activeTarget = {
      kind: 'asset',
      target: 'images/logo.png',
      assetPath: 'images/logo.png',
      mediaKind: 'image',
    };

    renderApp({ bridge });

    await waitFor(() => {
      expect(bridge.editor.notifyActiveTargetChanged).toHaveBeenCalledWith({
        kind: 'asset',
        identifier: 'images/logo.png',
      });
    });
  });

  test('missing and folder-index targets collapse to the project-scope desktop snapshot', async () => {
    const bridge = createBridge();
    activeTarget = { kind: 'missing', target: 'missing/path' };

    renderApp({ bridge });

    await waitFor(() => {
      expect(bridge.editor.notifyActiveTargetChanged).toHaveBeenCalledWith({ kind: null });
    });
  });

  test('active-target push is a web-mode no-op without the desktop bridge', () => {
    activeTarget = { kind: 'doc', target: 'docs/readme', docName: 'docs/readme' };

    renderApp();

    expect(screen.queryByTestId('share-receive-dialog')).toBeNull();
  });

  test('a note window keeps the drag strip with fixed 8px chrome geometry', () => {
    renderApp({ bridge: createNoteWindowBridge() as ReturnType<typeof createBridge> });

    const strip = screen.getByTestId('editor-window-chrome-drag-strip');
    expect(strip.getAttribute('aria-hidden')).toBe('true');
    expect(strip.getAttribute('data-electron-drag')).toBe('');
    expectVisualClassTokens(strip.className, [
      'pointer-events-none',
      'fixed',
      'inset-x-0',
      'top-0',
      'z-50',
      'h-2',
      '[-webkit-app-region:drag]',
    ]);
  });

  test('the app header supersedes the drag strip in an ordinary editor window', () => {
    renderApp({ bridge: createBridge() });

    expect(screen.getByRole('banner')).not.toBeNull();
    expect(screen.queryByTestId('editor-window-chrome-drag-strip')).toBeNull();
  });

  test('web host does not render Electron-only drag or share-receive surfaces', () => {
    renderApp();

    expect(screen.queryByTestId('editor-window-chrome-drag-strip')).toBeNull();
    expect(screen.queryByTestId('share-receive-dialog')).toBeNull();
  });

  describe('application header placement', () => {
    test('paints above both the file list and the editor, in document order', () => {
      renderApp();

      const header = screen.getByRole('banner');
      const shell = screen.getByTestId('sidebar-provider');
      expect(header.compareDocumentPosition(shell) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(
        header.compareDocumentPosition(screen.getByTestId('file-sidebar')) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
      expect(
        header.compareDocumentPosition(screen.getByTestId('editor-pane')) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    });

    test('takes its height out of the shell below it so nothing overflows the viewport', () => {
      renderApp();

      const shellRoot = document.querySelector<HTMLElement>('[data-app-shell]');
      expect(shellRoot?.style.getPropertyValue('--ok-app-header-height')).toBe('2.75rem');
      expectVisualClassTokens(screen.getByTestId('sidebar-provider').className, [
        'h-[calc(100vh-var(--ok-app-header-height,0px))]',
        'min-h-[calc(100svh-var(--ok-app-header-height,0px))]',
      ]);
      expectVisualClassTokens(appMain().className, [
        'ps-2',
        'pb-2',
        'pe-2',
        'h-[calc(100vh-var(--ok-app-header-height,0px))]',
      ]);
      expectVisualClassTokensAbsent(appMain().className, ['overflow-hidden', 'rounded-e-xl']);
    });

    test('a note window has no application header and no header height to subtract', () => {
      renderApp({ bridge: createNoteWindowBridge() as ReturnType<typeof createBridge> });

      expect(screen.queryByRole('banner')).toBeNull();
      const shellRoot = document.querySelector<HTMLElement>('[data-app-shell]');
      expect(shellRoot?.style.getPropertyValue('--ok-app-header-height')).toBe('');
      expectVisualClassTokens(appMain().className, ['h-screen']);
      expectVisualClassTokensAbsent(appMain().className, [
        'h-[calc(100vh-var(--ok-app-header-height,0px))]',
      ]);
    });

    test('a single-file window shows the shared application header', () => {
      singleFileMode = true;

      renderApp({ bridge: createBridge() });

      expect(screen.getByRole('banner')).not.toBeNull();
    });

    test('its search button opens the command palette', () => {
      renderApp();

      expect(screen.getByTestId('command-palette').getAttribute('data-open')).toBe('false');
      fireEvent.click(within(screen.getByRole('banner')).getByRole('button', { name: 'Search' }));
      expect(screen.getByTestId('command-palette').getAttribute('data-open')).toBe('true');
    });
  });

  describe('corner card stack', () => {
    function expectNoCornerStack() {
      expect(screen.getByTestId('editor-pane')).not.toBeNull();
      expect(screen.queryByTestId('corner-card-stack')).toBeNull();
      expect(screen.queryByRole('region', { name: 'Updates and feedback' })).toBeNull();
      expect(screen.queryByTestId('update-notices')).toBeNull();
      expect(screen.queryByTestId('feedback-card-mount')).toBeNull();
    }

    test('a desktop project window holds the update notice above the feedback card in one stack after the panes', () => {
      renderApp({ bridge: createBridge() });

      expect(screen.getAllByTestId('corner-card-stack')).toHaveLength(1);
      const stack = screen.getByRole('region', { name: 'Updates and feedback' });
      expect(stack).toBe(screen.getByTestId('corner-card-stack'));
      const column = within(stack).getByTestId('corner-card-stack-column');
      expect(Array.from(column.children).map((child) => child.getAttribute('data-testid'))).toEqual(
        ['update-notices', 'feedback-card-mount'],
      );
      expect(screen.getAllByTestId('update-notices')).toHaveLength(1);
      expect(screen.getAllByTestId('feedback-card-mount')).toHaveLength(1);

      expect(screen.getByTestId('page-list-provider').contains(stack)).toBe(true);
      expect(screen.getByTestId('editor-file-list-slot').contains(stack)).toBe(false);
      expect(screen.getByTestId('editor-pane').contains(stack)).toBe(false);
      expect(screen.getByTestId('sidebar-provider').contains(stack)).toBe(false);
      expect(
        screen.getByTestId('editor-pane').compareDocumentPosition(stack) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    });

    test('a web project window has the same stack', () => {
      renderApp();

      const stack = screen.getByRole('region', { name: 'Updates and feedback' });
      expect(screen.getAllByTestId('corner-card-stack')).toHaveLength(1);
      expect(within(stack).getByTestId('feedback-card-mount')).not.toBeNull();
    });

    test('a note window has no stack and no cards', () => {
      renderApp({ bridge: createNoteWindowBridge() as ReturnType<typeof createBridge> });

      expectNoCornerStack();
    });

    test('a single-file window has no stack and no cards', () => {
      singleFileMode = true;

      renderApp({ bridge: createBridge() });

      expectNoCornerStack();
    });
  });

  describe('repeat-crash recovery hash suppression', () => {
    afterEach(() => {
      resetTabSessionRestoreSuppression();
      consumeHashNavigationSuppression();
    });

    test('a mount after a repeat app-shell crash does not reopen the document named in the hash', async () => {
      recordAppShellCrashTrip(new Error('same shell crash'));
      recordAppShellCrashTrip(new Error('same shell crash'));
      setHash('#/poison-doc');

      renderApp();

      await Promise.resolve();
      expect(openTargetTransitionMock).not.toHaveBeenCalled();
      expect(window.location.hash).toBe('');
    });

    test('desktop mode: the suppressed mount drops the hash before the session gate lifts', async () => {
      recordAppShellCrashTrip(new Error('same shell crash'));
      recordAppShellCrashTrip(new Error('same shell crash'));
      tabSessionLoaded = false;
      setHash('#/poison-doc');

      const view = renderApp({ bridge: createBridge() });

      await Promise.resolve();
      expect(window.location.hash).toBe('');

      tabSessionLoaded = true;
      view.rerender(<App />);

      await Promise.resolve();
      expect(openTargetTransitionMock).not.toHaveBeenCalled();
    });

    test('hash navigation resumes immediately after the suppressed mount', async () => {
      recordAppShellCrashTrip(new Error('same shell crash'));
      recordAppShellCrashTrip(new Error('same shell crash'));
      setHash('#/poison-doc');
      renderApp();
      await Promise.resolve();
      openTargetTransitionMock.mockClear();

      window.history.pushState(null, '', `${window.location.pathname}#/other-doc`);
      window.dispatchEvent(new HashChangeEvent('hashchange'));

      await waitFor(() => {
        expect(openTargetTransitionMock).toHaveBeenCalledWith(
          { kind: 'doc', target: 'other-doc', docName: 'other-doc' },
          { deliberate: true, disposition: 'permanent', consumeActiveNewTab: true },
        );
      });
    });

    test('a single crash trip leaves mount-time hash navigation intact', async () => {
      recordAppShellCrashTrip(new Error('one-off crash'));
      setHash('#/kept-doc');

      renderApp();

      await waitFor(() => {
        expect(openTargetTransitionMock).toHaveBeenCalledWith(
          { kind: 'doc', target: 'kept-doc', docName: 'kept-doc' },
          { deliberate: false, disposition: 'permanent', consumeActiveNewTab: true },
        );
      });
      expect(window.location.hash).toBe('#/kept-doc');
    });

    test('an overlay-dialog hash survives the suppressed mount and still consumes the latch', async () => {
      recordAppShellCrashTrip(new Error('same shell crash'));
      recordAppShellCrashTrip(new Error('same shell crash'));
      setHash('#settings');

      renderApp();

      await Promise.resolve();
      expect(window.location.hash).toBe('#settings');

      cleanup();
      setHash('#/kept-doc');
      renderApp();

      await waitFor(() => {
        expect(openTargetTransitionMock).toHaveBeenCalledWith(
          { kind: 'doc', target: 'kept-doc', docName: 'kept-doc' },
          { deliberate: false, disposition: 'permanent', consumeActiveNewTab: true },
        );
      });
      expect(window.location.hash).toBe('#/kept-doc');
    });

    test('suppression is one-mount-scoped: a fresh mount navigates the hash normally', async () => {
      recordAppShellCrashTrip(new Error('same shell crash'));
      recordAppShellCrashTrip(new Error('same shell crash'));
      setHash('#/poison-doc');
      renderApp();
      await Promise.resolve();
      cleanup();

      setHash('#/poison-doc');
      renderApp();

      await waitFor(() => {
        expect(openTargetTransitionMock).toHaveBeenCalledWith(
          { kind: 'doc', target: 'poison-doc', docName: 'poison-doc' },
          { deliberate: false, disposition: 'permanent', consumeActiveNewTab: true },
        );
      });
    });
  });
});
