import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { pushHashWithoutNavigation } from '@/lib/doc-hash';
import { matchesKeyboardShortcut, type ShortcutEventLike } from '@/lib/keyboard-shortcuts';
import {
  __resetLocalMenuActionBusForTests,
  emitLocalMenuAction,
} from '@/lib/local-menu-action-bus';
import {
  consumeHashNavigationSuppression,
  recordAppShellCrashTrip,
  resetTabSessionRestoreSuppression,
} from '@/lib/tab-session-restore-suppression';
import { expectVisualClassTokens } from '@/test-utils/visual-contract';

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
    // The skill-tab reconciler reads these at render (no open skill tab here,
    // so it issues no `/api/skills` fetch); the real context always supplies them.
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
  // ValidationFreshness (mounted in the App body) reads the doc count through the
  // optional variant to budget its on-open audit.
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
  // ValidationFreshness (mounted in the App body) gates on the merged config;
  // null merged reads as every default (indicators on).
  useConfigContext: () => ({ merged: mergedConfig }),
}));

// AppBody reads `merged.appearance.preview.autoOpen` to compose the
// "Open in terminal" launch prompt; the ConfigProvider above is a passthrough
// so the real context is never set. Stub the hook to the cold-start shape.
vi.doMock('@/lib/config-context', () => ({
  useConfigContext: () => ({ merged: mergedConfig }),
}));

vi.doMock('@/lib/api-config', () => ({
  fetchApiConfig: (...args: Parameters<typeof fetchApiConfigMock>) => fetchApiConfigMock(...args),
}));

// ConfigProviderHost mounts the app-lifetime server keepalive; stub it so this
// chrome-focused test doesn't open a real WebSocket. Behavior is covered by
// use-server-keepalive.dom.test.tsx.
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

// Side-effect-only lifecycle reporters that mount null and drive the provider
// pool / desktop bridge (flush-on-hide; background-throttle). This chrome-focused
// test doesn't exercise them and its DocumentContext mock omits `getPool`, so
// stub them like the other side surfaces above — their behavior is covered by
// their own suites (install-editor-lifecycle-flush, install-background-throttle-reporter).
vi.doMock('@/editor/EditorLifecycleFlush', () => ({
  EditorLifecycleFlush: () => null,
}));
vi.doMock('@/editor/BackgroundThrottleReporter', () => ({
  BackgroundThrottleReporter: () => null,
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
  FileSidebar: ({ onOpenSearch }: { onOpenSearch: () => void }) => (
    <button type="button" data-testid="file-sidebar" onClick={onOpenSearch}>
      Sidebar
    </button>
  ),
}));

vi.doMock('@/components/EditorPane', () => ({
  EditorPane: () => <main data-testid="editor-pane" />,
}));

vi.doMock('@/components/ui/sidebar', () => ({
  SidebarProvider: ({ children, className }: { children: ReactNode; className?: string }) => (
    <section data-testid="sidebar-provider" className={className}>
      {children}
    </section>
  ),
  SidebarInset: ({ children, className }: { children: ReactNode; className?: string }) => (
    <section data-testid="sidebar-inset" className={className}>
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

function createBridge() {
  return {
    editor: {
      notifyActiveTargetChanged: vi.fn(() => {}),
    },
    // The real preload always exposes `config`; App reads `config.ptyAvailable`
    // to gate the terminal-launch provider (mac-only PTY). Mirror that shape so
    // the gate resolves instead of dereferencing undefined.
    config: {
      mode: 'editor' as const,
      ptyAvailable: true,
    },
  };
}

/** A popped-out note window: same bridge shape, `note` mode. */
function createNoteWindowBridge() {
  return { ...createBridge(), config: { mode: 'note' as const, ptyAvailable: true } };
}

function renderApp({ bridge = null }: { bridge?: ReturnType<typeof createBridge> | null } = {}) {
  if (bridge) {
    Object.defineProperty(window, 'okDesktop', {
      configurable: true,
      value: bridge,
    });
  }
  return render(<App />);
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
      // SystemDocSubscriber retargets the window to whatever doc an agent is
      // writing — right for the workspace window, wrong for a parked pop-out.
      expect(screen.queryByTestId('system-doc-subscriber')).toBeNull();
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
        disposition: 'permanent',
        consumeActiveNewTab: true,
      });
    });
    expect(openTargetTransitionMock).not.toHaveBeenCalledWith(resolved);
  });

  test('hash navigation defers an unresolvable folder hash instead of opening a tab', async () => {
    // Re-resolution fires on every page-list change, so a folder hash the
    // resolver cannot place must leave the folder view the click already opened
    // untouched — opening or clearing here would stomp it.
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
        disposition: 'permanent',
        consumeActiveNewTab: true,
      });
    });
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
    // A replay must not raise the disposition a target held when its history
    // entry was recorded: a doc the sidebar opened as a provisional preview has
    // to come back from Back as a preview, not as a durable tab. The option bag
    // is read through `objectContaining` so a field added later does not break
    // this, with both fields the handler promises today spelled out. What the
    // disposition then does to the tab strip is pinned against the real reducer
    // in App.history-traversal.dom.test.tsx.
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
          disposition: 'permanent',
          consumeActiveNewTab: true,
        },
      );
    });

    // File-tree navigation opens in the active tab and records the URL with
    // pushState, so NavigationHandler sees only the later history traversal.
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
        expect.objectContaining({ disposition: 'preview', consumeActiveNewTab: true }),
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
        expect.objectContaining({ disposition: 'preview', consumeActiveNewTab: true }),
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
        expect.objectContaining({ disposition: 'preview', consumeActiveNewTab: true }),
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
          disposition: 'permanent',
          consumeActiveNewTab: true,
        },
      );
    });
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

  test('Electron host renders the drag strip with fixed 8px chrome geometry', () => {
    renderApp({ bridge: createBridge() });

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

  test('web host does not render Electron-only drag or share-receive surfaces', () => {
    renderApp();

    expect(screen.queryByTestId('editor-window-chrome-drag-strip')).toBeNull();
    expect(screen.queryByTestId('share-receive-dialog')).toBeNull();
  });

  // A repeat app-shell crash arms the tab-session restore suppression latch.
  // The suppressed recovery mount must not renavigate into the crashing
  // document through the URL hash either: the active tab is mirrored into the
  // hash, so an unguarded mount-time hash resolution reopens the very document
  // the recovery just dropped and re-enters the crash loop. Ordinary hash
  // navigation must resume immediately after that one mount.
  describe('repeat-crash recovery hash suppression', () => {
    afterEach(() => {
      resetTabSessionRestoreSuppression();
      // A failed assertion can leave the navigation latch armed (a mounted App
      // normally consumes it); drain it so a failure doesn't cascade.
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
          { disposition: 'permanent', consumeActiveNewTab: true },
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
          { disposition: 'permanent', consumeActiveNewTab: true },
        );
      });
      expect(window.location.hash).toBe('#/kept-doc');
    });

    test('an overlay-dialog hash survives the suppressed mount and still consumes the latch', async () => {
      // The suppression deliberately exempts overlay-dialog hashes: they portal
      // over the editor and cannot reopen a document, so clearing one would
      // dismiss a dialog the user has open. Every other test here uses a
      // document hash, which leaves that exemption asserted only in prose.
      recordAppShellCrashTrip(new Error('same shell crash'));
      recordAppShellCrashTrip(new Error('same shell crash'));
      setHash('#settings');

      renderApp();

      await Promise.resolve();
      expect(window.location.hash).toBe('#settings');

      // The latch is one-shot regardless of which branch ran, so the next mount
      // must navigate normally rather than inheriting an unconsumed suppression.
      cleanup();
      setHash('#/kept-doc');
      renderApp();

      await waitFor(() => {
        expect(openTargetTransitionMock).toHaveBeenCalledWith(
          { kind: 'doc', target: 'kept-doc', docName: 'kept-doc' },
          { disposition: 'permanent', consumeActiveNewTab: true },
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
          { disposition: 'permanent', consumeActiveNewTab: true },
        );
      });
    });
  });
});
