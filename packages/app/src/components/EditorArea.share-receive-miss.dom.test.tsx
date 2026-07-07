import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { cleanup, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { pendingReceiveNavStore } from '@/lib/share/pending-receive-nav-store';

// A missing target with a live provider — the phantom-doc state the resolver
// lands on for a share target the branch doesn't carry. Reaches the editor
// `else` branch (create-mode) unless the share-receive miss guard diverts it.
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

mock.module('@/lib/perf', () => ({
  mark: () => {},
  ProfilerBoundary: ({ children }: { children: ReactNode }) => children,
}));
mock.module('@/components/PropertyContext', () => ({
  PropertyProvider: ({ children }: { children: ReactNode }) => children,
  useProperties: () => ({ requestAddProperty: () => {} }),
}));
mock.module('@/editor/DocumentContext', () => ({
  useDocumentContext: () => docCtx,
  useDocumentTransition: () => ({ openDocumentTransition: null }),
}));
mock.module('@/hooks/use-document-stats', () => ({ useDocumentStats: () => null }));
mock.module('@/hooks/use-selection-stats', () => ({ useSelectionStats: () => null }));
mock.module('@/hooks/use-lifecycle-status', () => ({ useLifecycleStatus: () => 'ready' }));
mock.module('@/presence/use-sync-status', () => ({ useSyncStatus: () => 'synced' }));
mock.module('@/lib/use-settings-route', () => ({
  useSettingsRoute: () => ({ open: false, close: () => {} }),
  SETTINGS_OPEN_HASH: '#settings',
  isSettingsShortcut: () => false,
}));
mock.module('@/components/settings/SettingsDialogShell', () => ({
  SettingsDialogShell: () => <div data-testid="settings-shell" />,
}));
mock.module('@/components/EditorSkeleton', () => ({
  EditorSkeleton: () => <div data-testid="editor-skeleton" />,
}));
mock.module('@/components/EmptyEditorState', () => ({
  EmptyEditorState: () => <div data-testid="empty-editor-state" />,
}));
mock.module('./TerminalDock', () => ({
  TerminalDock: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
mock.module('react-resizable-panels', () => ({
  usePanelRef: () => ({ current: { collapse: () => {}, expand: () => {} } }),
  // EditorArea imports `useGroupRef` alongside `usePanelRef`; the mock must
  // carry BOTH named exports or the `import { useGroupRef }` binding fails to
  // resolve and the whole file errors on load.
  useGroupRef: () => ({ current: { getLayout: () => [], setLayout: () => {} } }),
}));
mock.module('@/components/ui/resizable', () => ({
  ResizablePanelGroup: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  ResizablePanel: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  ResizableHandle: () => <div />,
}));
// The share-receive miss panel — stubbed so this test observes only which
// branch EditorArea takes, not the panel's own fetch/verdict behavior (its own
// dom test owns that).
mock.module('@/components/ShareReceiveMissPanel', () => ({
  ShareReceiveMissPanel: ({ nav }: { nav: { path: string } }) => (
    <div data-testid="miss-panel" data-path={nav.path} />
  ),
}));
// Editor-branch children — stubbed to a marker that surfaces the create-mode
// placeholder, so "fell through to create-mode" is observable without the real
// TipTap/CodeMirror stack.
mock.module('./EditorActivityPool', () => ({
  EditorActivityPool: ({ editorPlaceholder }: { editorPlaceholder?: string }) => (
    <div data-testid="editor-pool" data-placeholder={editorPlaceholder} />
  ),
}));
mock.module('@/editor/find-replace/FindReplaceController', () => ({
  FindReplaceController: () => null,
}));
mock.module('./EditorToolbar', () => ({
  EditorToolbar: () => <div data-testid="editor-toolbar" />,
}));
mock.module('./EditorFooter', () => ({ EditorFooter: () => <div data-testid="editor-footer" /> }));
// The create-mode branch mounts BottomComposer, which reaches useConfigContext
// via useHandoffDispatch — stub it out (this test only asserts which primary
// view renders, not the ask-composer, and pulling in the real config context
// is out of scope).
mock.module('./BottomComposer', () => ({
  BottomComposer: () => <div data-testid="bottom-composer" />,
}));
mock.module('./editor-area-overlay', () => ({ shouldPaintOverlay: () => false }));
// The editor `else` branch mounts DocPanel as its right panel; it reads
// usePageList, so stub it out — this test only cares which primary view renders.
mock.module('@/components/DocPanel', () => ({ DocPanel: () => <div data-testid="doc-panel" /> }));

const { EditorArea } = await import('./EditorArea');

function renderEditorArea() {
  return render(
    <EditorArea
      editorMode="wysiwyg"
      onModeChange={() => {}}
      activeTab="timeline"
      onActiveTabChange={() => {}}
    />,
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

  // A share-receive navigation to a missing target renders the miss panel,
  // never the create-mode editor — the fork trap is mechanically closed.
  test('renders the miss panel for a share-receive miss instead of create-mode', () => {
    pendingReceiveNavStore.arm({ kind: 'doc', path: 'notes/plan', branch: 'feature' });
    renderEditorArea();

    expect(screen.getByTestId('miss-panel').getAttribute('data-path')).toBe('notes/plan');
    expect(screen.queryByTestId('editor-pool')).toBeNull();
  });

  // An ordinary wiki-link create-on-navigate (no armed share-receive nav) still
  // opens the create-mode editor — the guard doesn't interfere.
  test('leaves create-mode reachable for an unarmed missing target (wiki-link)', () => {
    renderEditorArea();

    expect(screen.queryByTestId('miss-panel')).toBeNull();
    const pool = screen.getByTestId('editor-pool');
    expect(pool.getAttribute('data-placeholder')).toBe('Start writing to create this page');
  });

  // Path-scoping: an armed nav for a DIFFERENT path must not divert this
  // target — only the exact shared path gets the panel.
  test('does not divert a missing target whose path differs from the armed nav', () => {
    pendingReceiveNavStore.arm({ kind: 'doc', path: 'some/other-doc', branch: 'feature' });
    renderEditorArea();

    expect(screen.queryByTestId('miss-panel')).toBeNull();
    expect(screen.getByTestId('editor-pool')).toBeTruthy();
  });
});
