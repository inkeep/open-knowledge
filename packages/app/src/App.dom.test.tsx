import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
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
let openTargetTransitionMock = vi.fn((_: NavigationTarget) => {});
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
    activeTarget,
    clearTarget: clearTargetMock,
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
}));

// AppBody reads `merged.appearance.preview.autoOpen` to compose the
// "Open in terminal" launch prompt; the ConfigProvider above is a passthrough
// so the real context is never set. Stub the hook to the cold-start shape.
vi.doMock('@/lib/config-context', () => ({
  useConfigContext: () => ({ merged: null }),
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

vi.doMock('@/components/ShareBranchSwitchDialog', () => ({
  ShareBranchSwitchDialog: () => <div data-testid="share-branch-switch-dialog" />,
}));

vi.doMock('@/components/ShareReceiveMissDialog', () => ({
  ShareReceiveMissDialog: () => <div data-testid="share-receive-miss-dialog" />,
}));

vi.doMock('@/components/NewItemDialog', () => ({
  isNewItemShortcut: () => false,
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
      ptyAvailable: true,
    },
  };
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
    openTargetTransitionMock = vi.fn((_: NavigationTarget) => {});
    resolveNavigationTargetMock = vi.fn(
      (docName: string): NavigationTarget => ({ kind: 'doc', target: docName, docName }),
    );
    downgradeFolderIndexForHashNavMock = vi.fn((target: NavigationTarget) => target);
    withLargeFileOpenGuardMock = vi.fn((target: NavigationTarget) => target);
  });

  afterEach(() => {
    cleanup();
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
      expect(openTargetTransitionMock).toHaveBeenCalledWith(downgraded);
    });
    expect(openTargetTransitionMock).not.toHaveBeenCalledWith(resolved);
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
      expect(openTargetTransitionMock).toHaveBeenCalledWith({
        kind: 'doc',
        target: 'docs/guide.mdx',
        docName: 'docs/guide.mdx',
      });
    });
    expect(resolveNavigationTargetMock).not.toHaveBeenCalled();
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
});
