import { cleanup, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { ConfigProvider } from '@/lib/config-provider';

type EditorMode = 'wysiwyg' | 'source';

function docCtxFor(docName: string) {
  return {
    activeDocName: docName,
    activeProvider: { configuration: { name: docName } } as never,
    activeTarget: { kind: 'doc' as const, target: docName, docName },
    activeNewTabId: null,
    recycleDocument: () => {},
    closeActivityPanel: () => {},
    docPanelMode: 'timeline',
    docPanelAgentId: null,
    docPanelExpandSignal: 0,
  };
}

let docCtx: ReturnType<typeof docCtxFor> = docCtxFor('notes/example.ts');
let selectionStatsSurfaces: string[] = [];

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
vi.doMock('@/hooks/use-selection-stats', () => ({
  useSelectionStats: (_activeDocName: string | null, surface: string) => {
    selectionStatsSurfaces.push(surface);
    return null;
  },
}));
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
    renderPane,
  }: {
    renderPane: (context: {
      pane: { id: string };
      isFocused: boolean;
      activityDocName: string | null;
    }) => ReactNode;
  }) =>
    renderPane({
      pane: { id: 'pane-test' },
      isFocused: true,
      activityDocName: null,
    }),
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
vi.doMock('./EditorActivityPool', () => ({
  EditorActivityPool: () => <div data-testid="editor-pool" />,
}));
vi.doMock('@/editor/find-replace/FindReplaceController', () => ({
  FindReplaceController: () => null,
}));
vi.doMock('./EditorToolbar', () => ({
  EditorToolbar: () => <div data-testid="editor-toolbar" />,
}));
vi.doMock('./EditorFooter', () => ({ EditorFooter: () => <div data-testid="editor-footer" /> }));
vi.doMock('./editor-area-overlay', () => ({ shouldPaintOverlay: () => false }));
vi.doMock('@/components/DocPanel', () => ({ DocPanel: () => <div data-testid="doc-panel" /> }));
vi.doMock('./BottomComposer', () => ({
  BottomComposer: ({ surface }: { surface?: string }) => (
    <div data-testid="bottom-composer" data-surface={surface ?? ''} />
  ),
}));

const { EditorArea } = await import('./EditorArea');

function renderEditorArea(editorMode: EditorMode) {
  return render(
    <ConfigProvider collabUrl={null}>
      <EditorArea
        editorMode={editorMode}
        onModeChange={() => {}}
        activeTab="timeline"
        onActiveTabChange={() => {}}
      />
    </ConfigProvider>,
  );
}

function composerSurfaceFor(docName: string, editorMode: EditorMode): string {
  cleanup();
  docCtx = docCtxFor(docName);
  renderEditorArea(editorMode);
  return screen.getByTestId('bottom-composer').getAttribute('data-surface') ?? '';
}

function footerSelectionSurfaceFor(docName: string, editorMode: EditorMode): string {
  cleanup();
  docCtx = docCtxFor(docName);
  selectionStatsSurfaces = [];
  renderEditorArea(editorMode);
  const surface = selectionStatsSurfaces.at(-1);
  if (surface === undefined) throw new Error('EditorArea never asked for selection stats');
  return surface;
}

describe('EditorArea derives an editing surface from the document, not the markdown mode toggle', () => {
  beforeEach(() => cleanup());
  afterEach(() => cleanup());

  test('a markdown document takes its composer surface from the mode toggle', () => {
    expect(composerSurfaceFor('notes/example', 'wysiwyg')).toBe('wysiwyg');
    expect(composerSurfaceFor('notes/example', 'source')).toBe('source');
  });

  test('a markdown document takes its selection-stats surface from the mode toggle', () => {
    expect(footerSelectionSurfaceFor('notes/example', 'wysiwyg')).toBe('wysiwyg');
    expect(footerSelectionSurfaceFor('notes/example', 'source')).toBe('source');
  });

  test('an editable text doc gets one composer surface whichever way the toggle is left', () => {
    const underWysiwyg = composerSurfaceFor('notes/example.ts', 'wysiwyg');
    const underSource = composerSurfaceFor('notes/example.ts', 'source');

    const message =
      'a .ts file is edited in CodeMirror whatever the markdown mode toggle says, so the surface ' +
      'handed to the composer has to be the CodeMirror one under either toggle position. Got ' +
      `"${underWysiwyg}" under wysiwyg and "${underSource}" under source`;
    expect(underWysiwyg, message).toBe('source');
    expect(underSource, message).toBe('source');
  });

  test('an editable text doc gets one selection-stats surface whichever way the toggle is left', () => {
    const underWysiwyg = footerSelectionSurfaceFor('notes/example.ts', 'wysiwyg');
    const underSource = footerSelectionSurfaceFor('notes/example.ts', 'source');

    const message =
      'the footer reads selection stats under a surface key, and for a .ts file that key has to ' +
      'be the CodeMirror one under either toggle position. Got ' +
      `"${underWysiwyg}" under wysiwyg and "${underSource}" under source`;
    expect(underWysiwyg, message).toBe('source');
    expect(underSource, message).toBe('source');
  });
});
