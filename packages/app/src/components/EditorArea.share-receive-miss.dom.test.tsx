import { cleanup, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { ConfigProvider } from '@/lib/config-provider';
import { pendingReceiveNavStore } from '@/lib/share/pending-receive-nav-store';

const MISSING_DOC_CTX = {
  activeDocName: 'notes/plan',
  activeProvider: {} as never,
  activeTarget: { kind: 'missing', target: 'notes/plan' },
  recycleDocument: () => {},
  docPanelMode: 'timeline',
  docPanelAgentId: null,
  docPanelExpandSignal: 0,
};
let docCtx: typeof MISSING_DOC_CTX = MISSING_DOC_CTX;

vi.doMock('@/lib/perf', () => ({
  mark: () => {},
  ProfilerBoundary: ({ children }: { children: ReactNode }) => children,
}));
vi.doMock('@/components/PropertyContext', () => ({
  PropertyProvider: ({ children }: { children: ReactNode }) => children,
  useProperties: () => ({ requestAddProperty: () => {} }),
}));
vi.doMock('@/editor/DocumentContext', () => ({
  useDocumentContext: () => docCtx,
  useDocumentTransition: () => ({ openDocumentTransition: null }),
  isBlobRunnerNewTabId: () => false,
}));
vi.doMock('@/hooks/use-document-stats', () => ({ useDocumentStats: () => null }));
vi.doMock('@/hooks/use-selection-stats', () => ({ useSelectionStats: () => null }));
vi.doMock('@/hooks/use-lifecycle-status', () => ({ useLifecycleStatus: () => 'ready' }));
vi.doMock('@/presence/use-sync-status', () => ({ useSyncStatus: () => 'synced' }));
vi.doMock('@/lib/use-settings-route', () => ({
  useSettingsRoute: () => ({ open: false, close: () => {} }),
  SETTINGS_OPEN_HASH: '#settings',
  isSettingsShortcut: () => false,
}));
vi.doMock('@/components/settings/SettingsDialogShell', () => ({
  SettingsDialogShell: () => <div data-testid="settings-shell" />,
}));
vi.doMock('@/components/EditorSkeleton', () => ({
  EditorSkeleton: () => <div data-testid="editor-skeleton" />,
}));
vi.doMock('@/components/EmptyEditorState', () => ({
  EmptyEditorState: () => <div data-testid="empty-editor-state" />,
}));
vi.doMock('./TerminalDock', () => ({
  TerminalDock: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.doMock('./EditorWorkspace', () => ({
  EditorWorkspace: ({
    renderActivityPool,
    renderPane,
  }: {
    renderActivityPool?: (bindings: {
      activityHosts: ReadonlyMap<string, HTMLElement>;
      parkingHost: HTMLElement | null;
      visibleDocNames: ReadonlySet<string>;
    }) => ReactNode;
    renderPane: (context: {
      pane: { id: string };
      isFocused: boolean;
      activityDocName: string | null;
      activityMount: ReactNode;
    }) => ReactNode;
  }) => (
    <>
      {renderPane({
        pane: { id: 'pane-test' },
        isFocused: true,
        activityDocName: docCtx.activeDocName,
        activityMount: <div data-testid="activity-mount" />,
      })}
      {renderActivityPool?.({
        activityHosts: new Map(),
        parkingHost: document.body,
        visibleDocNames: new Set([docCtx.activeDocName]),
      })}
    </>
  ),
}));
vi.doMock('react-resizable-panels', () => ({
  usePanelRef: () => ({ current: { collapse: () => {}, expand: () => {} } }),
  useGroupRef: () => ({ current: { getLayout: () => [], setLayout: () => {} } }),
}));
vi.doMock('@/components/ui/resizable', () => ({
  ResizablePanelGroup: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  ResizablePanel: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  ResizableHandle: () => <div />,
}));
vi.doMock('@/components/ShareReceiveMissPanel', () => ({
  ShareReceiveMissPanel: ({ nav }: { nav: { path: string } }) => (
    <div data-testid="miss-panel" data-path={nav.path} />
  ),
}));
vi.doMock('./EditorActivityPool', () => ({
  EditorActivityPool: ({ editorPlaceholder }: { editorPlaceholder?: string }) => (
    <div data-testid="editor-pool" data-placeholder={editorPlaceholder} />
  ),
}));
vi.doMock('@/editor/find-replace/FindReplaceController', () => ({
  FindReplaceController: () => null,
}));
vi.doMock('./EditorToolbar', () => ({
  EditorToolbar: () => <div data-testid="editor-toolbar" />,
}));
vi.doMock('./EditorFooter', () => ({ EditorFooter: () => <div data-testid="editor-footer" /> }));
vi.doMock('./BottomComposer', () => ({
  BottomComposer: () => <div data-testid="bottom-composer" />,
}));
vi.doMock('./editor-area-overlay', () => ({ shouldPaintOverlay: () => false }));
vi.doMock('@/components/DocPanel', () => ({ DocPanel: () => <div data-testid="doc-panel" /> }));

const { EditorArea } = await import('./EditorArea');

function renderEditorArea() {
  return render(
    <ConfigProvider collabUrl={null}>
      <EditorArea
        editorMode="wysiwyg"
        onModeChange={() => {}}
        activeTab="timeline"
        onActiveTabChange={() => {}}
      />
    </ConfigProvider>,
  );
}

describe('EditorArea share-receive miss guard', () => {
  beforeEach(() => {
    cleanup();
    docCtx = MISSING_DOC_CTX;
    pendingReceiveNavStore.clear();
    window.location.hash = '';
  });
  afterEach(() => {
    cleanup();
    pendingReceiveNavStore.clear();
  });

  test('renders the miss panel for a share-receive miss instead of create-mode', () => {
    pendingReceiveNavStore.arm({ kind: 'doc', path: 'notes/plan', branch: 'feature' });
    renderEditorArea();

    expect(screen.getByTestId('miss-panel').getAttribute('data-path')).toBe('notes/plan');
    expect(screen.queryByTestId('editor-pool')).toBeNull();
  });

  test('leaves create-mode reachable for an unarmed missing target (wiki-link)', () => {
    renderEditorArea();

    expect(screen.queryByTestId('miss-panel')).toBeNull();
    const pool = screen.getByTestId('editor-pool');
    expect(pool.getAttribute('data-placeholder')).toBe('Start writing to create this page');
  });

  test('does not divert a missing target whose path differs from the armed nav', () => {
    pendingReceiveNavStore.arm({ kind: 'doc', path: 'some/other-doc', branch: 'feature' });
    renderEditorArea();

    expect(screen.queryByTestId('miss-panel')).toBeNull();
    expect(screen.getByTestId('editor-pool')).toBeTruthy();
  });
});
