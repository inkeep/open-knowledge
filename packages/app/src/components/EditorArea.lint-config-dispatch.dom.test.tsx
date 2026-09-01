import { cleanup, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { ConfigProvider } from '@/lib/config-provider';

function assetCtx(assetPath: string) {
  return {
    activeDocName: null,
    activeProvider: {} as never,
    activeTarget: {
      kind: 'asset' as const,
      target: assetPath,
      assetPath,
      mediaKind: 'text' as string | null,
    },
    recycleDocument: () => {},
    docPanelMode: 'timeline',
    docPanelAgentId: null,
    docPanelExpandSignal: 0,
  };
}
let docCtx: ReturnType<typeof assetCtx> = assetCtx('.markdownlint.json');

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
vi.doMock('./BottomComposer', () => ({
  BottomComposer: () => <div data-testid="bottom-composer" />,
}));
vi.doMock('./editor-area-overlay', () => ({ shouldPaintOverlay: () => false }));
vi.doMock('@/components/DocPanel', () => ({ DocPanel: () => <div data-testid="doc-panel" /> }));

vi.doMock('@/components/AssetPreview', () => ({
  AssetPreview: ({ assetPath }: { assetPath: string }) => (
    <div data-testid="asset-preview" data-asset-path={assetPath} />
  ),
}));
vi.doMock('@/components/LintConfigEditor', () => ({
  LintConfigEditor: ({ assetPath }: { assetPath: string }) => (
    <div data-testid="lint-config-editor" data-asset-path={assetPath} />
  ),
}));
vi.doMock('@/components/SchemaConfigEditor', () => ({
  SchemaConfigEditor: ({ assetPath }: { assetPath: string }) => (
    <div data-testid="schema-config-editor" data-asset-path={assetPath} />
  ),
}));

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

describe('EditorArea — markdownlint config dispatch', () => {
  beforeEach(() => cleanup());
  afterEach(() => cleanup());

  test('routes a root .markdownlint.json to the config editor, not the asset preview', async () => {
    docCtx = assetCtx('.markdownlint.json');
    renderEditorArea();

    const editor = await screen.findByTestId('lint-config-editor');
    expect(editor.getAttribute('data-asset-path')).toBe('.markdownlint.json');
    expect(screen.queryByTestId('asset-preview')).toBeNull();
  });

  test('routes a .markdownlint.jsonc to the config editor', () => {
    docCtx = assetCtx('.markdownlint.jsonc');
    renderEditorArea();

    expect(screen.getByTestId('lint-config-editor')).toBeDefined();
    expect(screen.queryByTestId('asset-preview')).toBeNull();
  });

  test('routes a nested config to the config editor (dispatch is basename-driven)', () => {
    docCtx = assetCtx('docs/.markdownlint.json');
    renderEditorArea();

    expect(screen.getByTestId('lint-config-editor').getAttribute('data-asset-path')).toBe(
      'docs/.markdownlint.json',
    );
    expect(screen.queryByTestId('asset-preview')).toBeNull();
  });

  test('leaves a non-config JSON (package.json) on the asset preview', () => {
    docCtx = assetCtx('package.json');
    renderEditorArea();

    expect(screen.getByTestId('asset-preview').getAttribute('data-asset-path')).toBe(
      'package.json',
    );
    expect(screen.queryByTestId('lint-config-editor')).toBeNull();
  });

  test('leaves an ordinary .json data file on the asset preview', () => {
    docCtx = assetCtx('data/settings.json');
    renderEditorArea();

    expect(screen.getByTestId('asset-preview')).toBeDefined();
    expect(screen.queryByTestId('lint-config-editor')).toBeNull();
  });

  test('routes a tool-managed frontmatter schema to the schema editor', async () => {
    docCtx = assetCtx('.ok/schemas/doc.schema.json');
    renderEditorArea();

    const editor = await screen.findByTestId('schema-config-editor');
    expect(editor.getAttribute('data-asset-path')).toBe('.ok/schemas/doc.schema.json');
    expect(screen.queryByTestId('asset-preview')).toBeNull();
    expect(screen.queryByTestId('lint-config-editor')).toBeNull();
  });

  test('routes a *.schema.json anywhere in the project to the schema editor', () => {
    docCtx = assetCtx('schemas/doc.schema.json');
    renderEditorArea();
    expect(screen.getByTestId('schema-config-editor').getAttribute('data-asset-path')).toBe(
      'schemas/doc.schema.json',
    );
    expect(screen.queryByTestId('asset-preview')).toBeNull();
  });

  test('leaves a non-JSON file under .ok/schemas and unconventional json on the preview', () => {
    docCtx = assetCtx('.ok/schemas/notes.md');
    renderEditorArea();
    expect(screen.getByTestId('asset-preview')).toBeDefined();
    expect(screen.queryByTestId('schema-config-editor')).toBeNull();
    cleanup();

    docCtx = assetCtx('schemas/user-owned.json');
    renderEditorArea();
    expect(screen.getByTestId('asset-preview')).toBeDefined();
    expect(screen.queryByTestId('schema-config-editor')).toBeNull();
  });
});
