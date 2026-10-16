import type { HocuspocusProvider } from '@hocuspocus/provider';
import { act, cleanup, fireEvent, render as rtlRender, screen } from '@testing-library/react';
import { type CSSProperties, type ReactNode, useEffect, useRef, useState } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  AGENTS_PANEL_WIDTH_KEY,
  getInitialAgentsPanelWidth,
  MIN_AGENTS_PANEL_WIDTH,
} from '@/lib/agents-panel-width-store';
import { DOC_PANEL_WIDTH_KEY } from '@/lib/doc-panel-width-store';
import {
  __resetPaneVisibilityStoreForTests,
  type PaneId,
  type PaneVisibilityRequest,
  paneVisibilityStore,
} from '@/lib/pane-visibility-store';
import { SIDEBAR_PINS_KEY } from '@/lib/sidebar-pin-store';
import {
  expectVisualClassTokens,
  expectVisualClassTokensAbsent,
} from '@/test-utils/visual-contract';
import type { PanelTab } from './DocPanel';
import { FileListHostProvider } from './FileListHost';

type SettingsDialogShellProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

let settingsRouteOpen = false;
let closeSettingsRouteMock = vi.fn(() => {});
let shellProps: SettingsDialogShellProps[] = [];
let toastInfoMessages: string[] = [];
const railPanelOnResizeById = new Map<
  string,
  ((size: { asPercentage: number; inPixels: number }) => void) | null
>();

vi.doMock('sonner', async (importOriginal) => {
  const actual = await importOriginal<typeof import('sonner')>();
  return {
    ...actual,
    toast: {
      ...actual.toast,
      info: (message: string) => {
        toastInfoMessages.push(message);
      },
    },
  };
});

vi.doMock('@/lib/perf', () => ({
  mark: () => {},
  ProfilerBoundary: ({ children }: { children: ReactNode }) => children,
}));

vi.doMock('@/components/PropertyContext', () => ({
  PropertyProvider: ({ children }: { children: ReactNode }) => children,
  useProperties: () => ({ requestAddProperty: () => {} }),
}));

vi.doMock('@/lib/config-provider', () => ({
  useConfigContext: () => ({ projectBinding: null }),
}));

let closeActivityPanelCalls = 0;
const closeActivityPanel = () => {
  closeActivityPanelCalls += 1;
};

const FOLDER_DOC_CTX = {
  activeDocName: 'folder/index',
  activeProvider: null,
  activeTarget: { kind: 'folder', target: 'folder', folderPath: 'folder' },
  recycleDocument: () => {},
  closeActivityPanel,
  docPanelMode: 'timeline',
  docPanelAgentId: null,
  docPanelExpandSignal: 0,
};
const EMPTY_DOC_CTX = {
  activeDocName: null,
  activeProvider: null,
  activeTarget: null,
  recycleDocument: () => {},
  closeActivityPanel,
  docPanelMode: 'timeline',
  docPanelAgentId: null,
  docPanelExpandSignal: 0,
};
const LARGE_FILE_DOC_CTX = {
  activeDocName: 'big',
  activeProvider: null,
  activeTarget: { kind: 'large-file', docName: 'big', size: 9_999_999, limit: 1_000_000 },
  recycleDocument: () => {},
  closeActivityPanel,
  docPanelMode: 'timeline',
  docPanelAgentId: null,
  docPanelExpandSignal: 0,
};
const ASSET_DOC_CTX = {
  activeDocName: null,
  activeProvider: null,
  activeTarget: { kind: 'asset', assetPath: 'images/diagram.png', mediaKind: 'image' },
  recycleDocument: () => {},
  closeActivityPanel,
  docPanelMode: 'timeline',
  docPanelAgentId: null,
  docPanelExpandSignal: 0,
};
const FOLDER_LIVE_CTX = {
  ...FOLDER_DOC_CTX,
  activeProvider: {
    configuration: { name: 'docs/notes' },
  } as unknown as HocuspocusProvider,
};
const FOLDER_AGENT_CTX = {
  ...FOLDER_DOC_CTX,
  docPanelMode: 'agent',
  docPanelAgentId: 'conn-1',
};
const DOC_LIVE_CTX = {
  ...FOLDER_LIVE_CTX,
  activeDocName: 'docs/notes',
  activeTarget: { kind: 'doc', target: 'docs/notes', docName: 'docs/notes' },
};
const DOC_COLD_CTX = {
  activeDocName: null,
  activeProvider: null,
  activeTarget: { kind: 'doc', target: 'some-doc', docName: 'some-doc' },
  recycleDocument: () => {},
  closeActivityPanel,
  docPanelMode: 'timeline',
  docPanelAgentId: null,
  docPanelExpandSignal: 0,
};
let docCtx:
  | typeof FOLDER_DOC_CTX
  | typeof FOLDER_LIVE_CTX
  | typeof FOLDER_AGENT_CTX
  | typeof DOC_LIVE_CTX
  | typeof EMPTY_DOC_CTX
  | typeof LARGE_FILE_DOC_CTX
  | typeof ASSET_DOC_CTX
  | typeof DOC_COLD_CTX = FOLDER_DOC_CTX;
vi.doMock('@/editor/DocumentContext', () => ({
  useDocumentContext: () => docCtx,
  useDocumentTransition: () => ({ openDocumentTransition: null }),
  isBlobRunnerNewTabId: () => false,
}));

vi.doMock('@/components/EmptyEditorState', () => ({
  EmptyEditorState: ({
    terminalOpen,
    bottomDockOpen,
    agentsOpen,
  }: {
    terminalOpen?: boolean;
    bottomDockOpen?: boolean;
    agentsOpen?: boolean;
  }) => (
    <div
      data-testid="empty-editor-state"
      data-terminal-open={String(terminalOpen === true)}
      data-bottom-dock-open={String(bottomDockOpen === true)}
      data-agents-open={String(agentsOpen === true)}
    />
  ),
}));

let terminalDockMounts = 0;
vi.doMock('@/components/EditorSkeleton', () => ({
  EditorSkeleton: () => <div data-testid="editor-skeleton" />,
}));

vi.doMock('./TerminalDock', () => ({
  TerminalDock: ({
    children,
    placement,
    visible,
  }: {
    children: ReactNode;
    placement?: string;
    visible?: boolean;
  }) => {
    useEffect(() => {
      terminalDockMounts += 1;
    }, []);
    return (
      <div
        data-testid="terminal-dock"
        data-placement={placement ?? 'bottom'}
        data-visible={String(visible)}
      >
        {children}
      </div>
    );
  },
}));

let editorWorkspaceMounts = 0;
vi.doMock('./EditorWorkspace', () => ({
  EditorWorkspace: ({
    renderHeader,
    renderPane,
  }: {
    renderHeader: (tabs: ReactNode) => ReactNode;
    renderPane: (context: {
      pane: { id: string };
      isFocused: boolean;
      activityDocName: string | null;
    }) => ReactNode;
  }) => {
    useEffect(() => {
      editorWorkspaceMounts += 1;
    }, []);
    return (
      <>
        {renderHeader(<div data-testid="workspace-tabs" />)}
        {renderPane({
          pane: { id: 'pane-test' },
          isFocused: true,
          activityDocName: null,
        })}
      </>
    );
  },
}));

type EditorRow = 'outer' | 'inner';
type MockLayout = Record<string, number>;
type LayoutChangedHandler = (layout: MockLayout, meta: { isUserInteraction: boolean }) => void;

const INNER_LAYOUT_DOC_CLOSED: MockLayout = { 'workspace-main': 100, 'doc-panel': 0 };
let groupLayout: MockLayout = {};
let innerLayout: MockLayout = { ...INNER_LAYOUT_DOC_CLOSED };
let groupSetLayoutCalls: MockLayout[] = [];
let innerSetLayoutCalls: MockLayout[] = [];
let rejectNextGroupLayoutWrite = false;
let rejectGroupLayoutWrites = false;
let groupOnLayoutChanged: LayoutChangedHandler | null = null;
let groupOnLayoutChange: ((layout: MockLayout) => void) | null = null;
const innerRowHandlers: {
  onLayoutChanged: LayoutChangedHandler | null;
  onLayoutChange: ((layout: MockLayout) => void) | null;
} = {
  onLayoutChanged: null,
  onLayoutChange: null,
};
let panelIsCollapsed = false;
let mockGroupPx = 1360;
let mockInnerPx: number | null = null;
let mockFileListPx = 0;
let mockPanelPercentage: number | null = null;
let mockPanelPx: number | null = null;
let deferPanelGeometryCommit = false;
let committedGroupLayout: MockLayout = {};
let committedInnerLayout: MockLayout = {};
let innerSetLayoutPx: number[] = [];
let deliverDocPanelResizeAfterLayout = false;
let lastDeliveredDocPanelSize: { asPercentage: number; inPixels: number } | null = null;

beforeEach(() => {
  mockPanelPercentage = null;
  mockPanelPx = null;
  rejectGroupLayoutWrites = false;
  deferPanelGeometryCommit = false;
  committedGroupLayout = {};
  committedInnerLayout = {};
  innerLayout = { ...INNER_LAYOUT_DOC_CLOSED };
  innerSetLayoutCalls = [];
  innerSetLayoutPx = [];
  deliverDocPanelResizeAfterLayout = false;
  lastDeliveredDocPanelSize = null;
  innerRowHandlers.onLayoutChanged = null;
  innerRowHandlers.onLayoutChange = null;
  mockInnerPx = null;
  mockFileListPx = 0;
  conflictedDocName = null;
});

const renderedInnerPanelIds = () =>
  [...screen.getByTestId('resizable-group-inner').children].map((el) => el.id).filter(Boolean);
const innerRowWithDoc = (docPx: number, editorColumnPx: number): MockLayout => ({
  'workspace-main': 100 - (docPx / editorColumnPx) * 100,
  'doc-panel': (docPx / editorColumnPx) * 100,
});
const innerResidualWidthPx = () =>
  screen
    .getByTestId('resizable-group-inner')
    .querySelector<HTMLElement>(':scope > [data-panel]:not([id])')
    ?.getBoundingClientRect().width;

function lastInnerWritePx(id: string): number | null {
  const layout = innerSetLayoutCalls.at(-1);
  const px = innerSetLayoutPx.at(-1);
  const pct = layout?.[id];
  return pct == null || px == null ? null : (pct / 100) * px;
}

function rowOf(element: Element | null | undefined): EditorRow {
  return element?.closest('[data-editor-row]')?.getAttribute('data-editor-row') === 'inner'
    ? 'inner'
    : 'outer';
}

function rowLayout(row: EditorRow): MockLayout {
  return row === 'inner' ? innerLayout : groupLayout;
}

function assignRowLayout(row: EditorRow, layout: MockLayout) {
  if (row === 'inner') innerLayout = layout;
  else groupLayout = layout;
}

function assignCommittedRowLayout(row: EditorRow, layout: MockLayout) {
  if (row === 'inner') committedInnerLayout = layout;
  else committedGroupLayout = layout;
}

function rowSetLayoutCalls(row: EditorRow): MockLayout[] {
  return row === 'inner' ? innerSetLayoutCalls : groupSetLayoutCalls;
}

function geometryLayout(row: EditorRow): MockLayout {
  if (!deferPanelGeometryCommit) return rowLayout(row);
  return row === 'inner' ? committedInnerLayout : committedGroupLayout;
}

function residualPanelWidthPx(element: HTMLElement, row: EditorRow): number {
  const layout = geometryLayout(row);
  const group = element.parentElement;
  if (group == null) return 0;
  let claimedPercentage = 0;
  for (const sibling of group.querySelectorAll<HTMLElement>(':scope > [data-panel]')) {
    if (sibling.id !== '') claimedPercentage += layout[sibling.id] ?? 0;
  }
  return (Math.max(0, 100 - claimedPercentage) / 100) * rowPx(row);
}

function rowPx(row: EditorRow): number {
  if (row === 'outer') return mockGroupPx;
  if (mockInnerPx != null) return mockInnerPx;
  const outerResidual = document.querySelector<HTMLElement>(
    '[data-editor-row="outer"] > [data-panel]:not([id])',
  );
  const editorColumnPx =
    outerResidual == null ? mockGroupPx : residualPanelWidthPx(outerResidual, 'outer');
  return Math.max(0, editorColumnPx - mockFileListPx);
}

function mockedPanelWidthPx(element: HTMLElement): number {
  const row = rowOf(element.parentElement);
  if (element.id !== '') return ((geometryLayout(row)[element.id] ?? 0) / 100) * rowPx(row);
  return residualPanelWidthPx(element, row);
}

function measureMockedPanel(element: HTMLDivElement | null) {
  if (element == null) return;
  Object.defineProperty(element, 'getBoundingClientRect', {
    configurable: true,
    value: () => {
      const width = mockedPanelWidthPx(element);
      return { width, height: 0, top: 0, left: 0, right: width, bottom: 0, x: 0, y: 0 };
    },
  });
  Object.defineProperty(element, 'offsetWidth', {
    configurable: true,
    get: () => Math.round(mockedPanelWidthPx(element)),
  });
}

function createGroupHandle(row: EditorRow) {
  return {
    getLayout: () => rowLayout(row),
    setLayout: (layout: MockLayout) => {
      rowSetLayoutCalls(row).push(layout);
      if (row === 'inner') innerSetLayoutPx.push(rowPx('inner'));
      if (rejectNextGroupLayoutWrite && row === 'outer') {
        rejectNextGroupLayoutWrite = false;
        return;
      }
      if (rejectGroupLayoutWrites) return;
      assignRowLayout(row, layout);
      if (deferPanelGeometryCommit) {
        queueMicrotask(() => {
          assignCommittedRowLayout(row, layout);
        });
      } else {
        assignCommittedRowLayout(row, layout);
      }
      if (row === 'inner' && deliverDocPanelResizeAfterLayout) {
        const size = docPanelSizeFromRow();
        if (
          lastDeliveredDocPanelSize?.asPercentage !== size.asPercentage ||
          lastDeliveredDocPanelSize.inPixels !== size.inPixels
        ) {
          lastDeliveredDocPanelSize = size;
          panelIsCollapsed = size.asPercentage === 0;
          railPanelOnResizeById.get('doc-panel')?.(size);
        }
      }
    },
  };
}

const groupHandles: Record<EditorRow, ReturnType<typeof createGroupHandle>> = {
  outer: createGroupHandle('outer'),
  inner: createGroupHandle('inner'),
};

let panelRefCalls = 0;
const PANEL_REF_ORDER = ['doc-panel', 'agents-column', 'terminal-column'] as const;

function docPanelSizeFromRow() {
  const pct = rowLayout('inner')['doc-panel'] ?? 0;
  return { asPercentage: pct, inPixels: (pct / 100) * rowPx('inner') };
}

vi.doMock('react-resizable-panels', () => ({
  usePanelRef: () => {
    const slot = PANEL_REF_ORDER[panelRefCalls % PANEL_REF_ORDER.length];
    panelRefCalls += 1;
    return {
      current: {
        collapse: () => {},
        expand: () => {},
        getSize: () => {
          if (slot !== 'doc-panel') {
            return {
              asPercentage: mockPanelPercentage ?? 25,
              inPixels: mockPanelPx ?? mockGroupPx / 4,
            };
          }
          const fromRow = docPanelSizeFromRow();
          return {
            asPercentage: mockPanelPercentage ?? fromRow.asPercentage,
            inPixels: mockPanelPx ?? fromRow.inPixels,
          };
        },
        isCollapsed: () =>
          deliverDocPanelResizeAfterLayout
            ? (slot === 'doc-panel' ? innerLayout : groupLayout)[slot] === 0
            : panelIsCollapsed,
      },
    };
  },
  useGroupRef: () => useRef<ReturnType<typeof createGroupHandle> | null>(null),
}));

vi.doMock('@/components/ui/resizable', () => ({
  ResizablePanelGroup: ({
    children,
    onLayoutChange,
    onLayoutChanged,
    groupRef,
    'data-editor-row': rowProp,
    'data-dragging': dragging,
  }: {
    children: ReactNode;
    onLayoutChange?: (layout: MockLayout) => void;
    onLayoutChanged?: LayoutChangedHandler;
    groupRef?: { current: ReturnType<typeof createGroupHandle> | null };
    'data-editor-row'?: string;
    'data-dragging'?: boolean;
  }) => {
    const row: EditorRow = rowProp === 'inner' ? 'inner' : 'outer';
    if (groupRef != null) groupRef.current = groupHandles[row];
    if (row === 'inner') {
      innerRowHandlers.onLayoutChanged = onLayoutChanged ?? null;
      innerRowHandlers.onLayoutChange = onLayoutChange ?? null;
    } else {
      groupOnLayoutChanged = onLayoutChanged ?? null;
      groupOnLayoutChange = onLayoutChange ?? null;
    }
    return (
      <div
        data-testid={row === 'inner' ? 'resizable-group-inner' : 'resizable-group'}
        data-group="true"
        data-editor-row={row}
        data-dragging={dragging || undefined}
        data-slot="resizable-panel-group"
      >
        {children}
      </div>
    );
  },
  ResizablePanel: ({
    children,
    id,
    minSize,
    maxSize,
    onResize,
    role,
    'aria-label': ariaLabel,
    inert,
    style,
  }: {
    children: ReactNode;
    style?: CSSProperties;
    id?: string;
    minSize?: string | number;
    maxSize?: string | number;
    onResize?: (size: { asPercentage: number; inPixels: number }) => void;
    role?: string;
    'aria-label'?: string;
    inert?: boolean;
  }) => {
    if (id != null) railPanelOnResizeById.set(id, onResize ?? null);
    return (
      <div
        id={id}
        {...(role == null ? {} : { role, 'aria-label': ariaLabel })}
        inert={inert}
        style={style}
        data-panel="true"
        data-slot="resizable-panel"
        ref={measureMockedPanel}
        data-min-size={minSize}
        data-max-size={maxSize}
      >
        {children}
      </div>
    );
  },
  ResizableHandle: ({
    onPointerDown,
    ...props
  }: {
    onPointerDown?: (e: unknown) => void;
    'aria-controls'?: string;
    'aria-label'?: string;
    'data-agents-panel-resize-handle'?: string;
    'data-doc-panel-handle'?: string;
    'data-terminal-panel-handle'?: string;
    style?: CSSProperties;
  }) => (
    <hr
      style={props.style}
      aria-controls={props['aria-controls']}
      aria-label={props['aria-label']}
      aria-valuenow={50}
      data-testid="resizable-handle"
      data-agents-panel-resize-handle={props['data-agents-panel-resize-handle']}
      data-doc-panel-handle={props['data-doc-panel-handle']}
      data-terminal-panel-handle={props['data-terminal-panel-handle']}
      onPointerDown={onPointerDown}
      tabIndex={0}
    />
  ),
}));

vi.doMock('@/hooks/use-document-stats', () => ({
  useDocumentStats: () => null,
}));

let conflictedDocName: string | null = null;
vi.doMock('@/hooks/use-conflicts', () => ({
  useDocConflict: (docName: string | null) =>
    docName != null && docName === conflictedDocName
      ? {
          file: `${docName}.md`,
          docName,
          detectedAt: '2026-09-25T00:00:00.000Z',
          conflict: 'merge-native',
        }
      : null,
  useConflicts: () => ({
    conflicts: [],
    loading: false,
    error: null,
    refresh: () => {},
  }),
}));

vi.doMock('@/presence/use-sync-status', () => ({
  useSyncStatus: () => 'synced',
}));

vi.doMock('@/components/FolderOverview', () => ({
  FolderOverview: ({ folderPath }: { folderPath: string }) => (
    <div data-testid="folder-overview">{folderPath}</div>
  ),
}));

vi.doMock('./BottomComposer', () => ({
  BottomComposer: ({ docName, folderPath }: { docName?: string | null; folderPath?: string }) => (
    <div data-testid="bottom-composer" data-doc={docName ?? ''} data-folder={folderPath ?? ''} />
  ),
}));

vi.doMock('@/components/ActivityModeContent', () => ({
  ActivityModeContent: () => <div data-testid="activity-mode-content" />,
}));

vi.doMock('@/components/AssetPreview', () => ({
  AssetPreview: ({ assetPath }: { assetPath: string }) => (
    <div data-testid="asset-preview">{assetPath}</div>
  ),
}));

vi.doMock('@/components/LargeFileEditorState', () => ({
  LargeFileEditorState: ({ docName }: { docName: string }) => (
    <div data-testid="large-file-state">{docName}</div>
  ),
}));

vi.doMock('./EditorFooter', () => ({
  EditorFooter: () => <div data-testid="editor-footer" />,
}));

vi.doMock('@/components/DocPanelToggle', () => ({
  DocPanelToggle: ({
    isPanelCollapsed,
    onTogglePanel,
  }: {
    isPanelCollapsed: boolean;
    onTogglePanel: () => void;
  }) => (
    <button
      type="button"
      data-doc-panel-toggle=""
      aria-controls="doc-panel"
      aria-expanded={!isPanelCollapsed}
      aria-label={isPanelCollapsed ? 'Show panel' : 'Hide panel'}
      onClick={onTogglePanel}
    />
  ),
}));

vi.doMock('@/components/settings/SettingsDialogShell', () => ({
  SettingsDialogShell: (props: SettingsDialogShellProps) => {
    shellProps.push(props);
    return <div data-testid="settings-shell" data-open={String(props.open)} />;
  },
}));

vi.doMock('@/lib/use-settings-route', () => ({
  useSettingsRoute: () => ({
    open: settingsRouteOpen,
    close: closeSettingsRouteMock,
  }),
}));

const { EditorArea } = await import('./EditorArea');
const { SidebarProvider } = await import('@/components/ui/sidebar');
const { TooltipProvider } = await import('@/components/ui/tooltip');
const { SingleFileModeProvider } = await import('@/lib/single-file-mode');
const { emitLocalMenuAction } = await import('@/lib/local-menu-action-bus');
const { requestDocPanelTab } = await import('./doc-panel-events');
const { AGENTS_COLUMN_ID, TERMINAL_COLUMN_ID } = await import('./editor-area-rail-registry');
const { MAX_RAIL_PIN_EXHAUSTED_REPORTS } = await import('./EditorArea');
const { RIGHT_TERMINAL_PANEL_MIN_WIDTH_PX } = await import('./right-rail-admission');

function render(ui: ReactNode) {
  return rtlRender(ui, { wrapper: SidebarProvider });
}

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

describe('EditorArea SettingsDialogPortal runtime wiring', () => {
  beforeEach(() => {
    cleanup();
    docCtx = FOLDER_DOC_CTX;
    settingsRouteOpen = false;
    closeSettingsRouteMock = vi.fn(() => {});
    shellProps = [];
  });

  test('mounts the Settings shell while closed and delegates close to useSettingsRoute', () => {
    renderEditorArea();

    expect(screen.getByTestId('folder-overview').textContent).toBe('folder');
    expect(screen.getByTestId('settings-shell').getAttribute('data-open')).toBe('false');
    expect(shellProps.at(-1)?.open).toBe(false);

    act(() => {
      shellProps.at(-1)?.onOpenChange(true);
    });
    expect(closeSettingsRouteMock).not.toHaveBeenCalled();

    act(() => {
      shellProps.at(-1)?.onOpenChange(false);
    });
    expect(closeSettingsRouteMock).toHaveBeenCalledTimes(1);
  });
});

describe('EditorArea empty-state terminal host', () => {
  beforeEach(() => {
    cleanup();
    docCtx = EMPTY_DOC_CTX;
  });

  test('hosts the docked terminal on the empty state when a terminal bridge is present', () => {
    render(
      <EditorArea
        editorMode="wysiwyg"
        onModeChange={() => {}}
        activeTab="timeline"
        onActiveTabChange={() => {}}
        terminalBridge={{} as never}
        terminalVisible
        onTerminalVisibleChange={() => {}}
      />,
    );

    const dock = screen.getByTestId('terminal-dock');
    expect(dock.getAttribute('data-visible')).toBe('true');
    const emptyState = dock.querySelector('[data-testid="empty-editor-state"]');
    expect(emptyState).not.toBeNull();
    expect(emptyState?.getAttribute('data-terminal-open')).toBe('true');
    expect(emptyState?.getAttribute('data-agents-open')).toBe('false');
  });

  test('collapses the empty state to the header-only view when the agents panel is open', () => {
    render(
      <EditorArea
        editorMode="wysiwyg"
        onModeChange={() => {}}
        activeTab="timeline"
        onActiveTabChange={() => {}}
        agentsVisible
        onAgentsVisibleChange={() => {}}
      />,
    );

    const emptyState = screen.getByTestId('empty-editor-state');
    expect(emptyState.getAttribute('data-agents-open')).toBe('true');
    expect(emptyState.getAttribute('data-terminal-open')).toBe('false');
  });

  test('renders the empty state; the dock shell is present but inactive on the web host', () => {
    render(
      <EditorArea
        editorMode="wysiwyg"
        onModeChange={() => {}}
        activeTab="timeline"
        onActiveTabChange={() => {}}
      />,
    );

    expect(screen.getByTestId('terminal-dock').getAttribute('data-visible')).toBe('false');
    const emptyState = screen.getByTestId('empty-editor-state');
    expect(emptyState.getAttribute('data-terminal-open')).toBe('false');
    expect(emptyState.getAttribute('data-agents-open')).toBe('false');
  });

  test('reports the bottom dock as open when a visible terminal is docked at the bottom', () => {
    render(
      <EditorArea
        editorMode="wysiwyg"
        onModeChange={() => {}}
        activeTab="timeline"
        onActiveTabChange={() => {}}
        terminalBridge={{} as never}
        terminalVisible
        terminalPlacement="bottom"
        onTerminalVisibleChange={() => {}}
      />,
    );

    const emptyState = screen.getByTestId('empty-editor-state');
    expect(emptyState.getAttribute('data-terminal-open')).toBe('true');
    expect(emptyState.getAttribute('data-bottom-dock-open')).toBe('true');
  });

  test('reports the bottom dock as closed when the visible terminal is docked to the right', () => {
    render(
      <EditorArea
        editorMode="wysiwyg"
        onModeChange={() => {}}
        activeTab="timeline"
        onActiveTabChange={() => {}}
        terminalBridge={{} as never}
        terminalVisible
        terminalPlacement="right"
        onTerminalVisibleChange={() => {}}
      />,
    );

    const emptyState = screen.getByTestId('empty-editor-state');
    expect(emptyState.getAttribute('data-terminal-open')).toBe('true');
    expect(emptyState.getAttribute('data-bottom-dock-open')).toBe('false');
  });

  test('reports the bottom dock as closed when a bottom-placed terminal is not visible', () => {
    render(
      <EditorArea
        editorMode="wysiwyg"
        onModeChange={() => {}}
        activeTab="timeline"
        onActiveTabChange={() => {}}
        terminalBridge={{} as never}
        terminalPlacement="bottom"
        onTerminalVisibleChange={() => {}}
      />,
    );

    const emptyState = screen.getByTestId('empty-editor-state');
    expect(emptyState.getAttribute('data-terminal-open')).toBe('false');
    expect(emptyState.getAttribute('data-bottom-dock-open')).toBe('false');
  });
});

describe('EditorArea right-rail layout assert on column mount/unmount', () => {
  const setViewportWidth = (px: number) => {
    Object.defineProperty(window, 'innerWidth', {
      value: px,
      configurable: true,
      writable: true,
    });
  };

  const baseProps = {
    editorMode: 'wysiwyg',
    onModeChange: () => {},
    activeTab: 'timeline',
    onActiveTabChange: () => {},
    terminalBridge: {} as never,
    onAgentsVisibleChange: () => {},
  } as const;

  const MOCK_GROUP_PX = 1360;
  const pctOf = (px: number) => (px / MOCK_GROUP_PX) * 100;
  const getAgentsHandle = () => {
    const handle = screen.getAllByTestId('resizable-handle').at(-1);
    if (handle == null) throw new Error('agents resize handle not found');
    return handle;
  };
  const controlAnimationFrames = () => {
    const callbacks = new Map<number, FrameRequestCallback>();
    let nextId = 1;
    let timestamp = performance.now();
    const requestSpy = vi
      .spyOn(window, 'requestAnimationFrame')
      .mockImplementation((callback: FrameRequestCallback) => {
        const id = nextId;
        nextId += 1;
        callbacks.set(id, callback);
        return id;
      });
    const cancelSpy = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id: number) => {
      callbacks.delete(id);
    });
    return {
      pendingCount: () => callbacks.size,
      run: (count: number, frameDurationMs = 1000 / 60) => {
        for (let index = 0; index < count; index += 1) {
          const next = callbacks.entries().next().value;
          if (next == null) return;
          const [id, callback] = next;
          callbacks.delete(id);
          timestamp += frameDurationMs;
          act(() => callback(timestamp));
        }
      },
      restore: () => {
        requestSpy.mockRestore();
        cancelSpy.mockRestore();
      },
    };
  };

  beforeEach(() => {
    cleanup();
    localStorage.clear();
    docCtx = EMPTY_DOC_CTX;
    groupLayout = {};
    groupSetLayoutCalls = [];
    rejectNextGroupLayoutWrite = false;
    rejectGroupLayoutWrites = false;
    panelIsCollapsed = false;
    mockGroupPx = 1360;
    mockPanelPercentage = null;
    mockPanelPx = null;
    deferPanelGeometryCommit = false;
    committedGroupLayout = {};
    groupOnLayoutChanged = null;
    groupOnLayoutChange = null;
    toastInfoMessages = [];
  });

  const renderedPanelIds = () =>
    [...screen.getByTestId('resizable-group').children].map((el) => el.id).filter(Boolean);

  test('moving the terminal right at a narrow width closes agents without moving focus', async () => {
    setViewportWidth(650);
    mockGroupPx = 650;
    const agentsChanges: boolean[] = [];
    const focusTarget = document.createElement('button');
    document.body.append(focusTarget);
    focusTarget.focus();
    const view = render(
      <EditorArea
        {...baseProps}
        agentsVisible
        terminalVisible
        terminalPlacement="bottom"
        onAgentsVisibleChange={(visible: boolean) => {
          agentsChanges.push(visible);
        }}
        onTerminalVisibleChange={() => {}}
      />,
    );
    groupLayout = { 'editor-main': 52, 'terminal-column': 30, 'agents-column': 18 };

    view.rerender(
      <EditorArea
        {...baseProps}
        agentsVisible
        terminalVisible
        terminalPlacement="right"
        onAgentsVisibleChange={(visible: boolean) => {
          agentsChanges.push(visible);
        }}
        onTerminalVisibleChange={() => {}}
      />,
    );
    await act(async () => {});

    expect(agentsChanges).toEqual([false]);
    expect(toastInfoMessages).toEqual(['Agent panel closed to keep Terminal readable.']);
    expect(document.activeElement).toBe(focusTarget);
  });

  test('a narrow restored layout keeps the right terminal and closes agents', async () => {
    setViewportWidth(650);
    mockGroupPx = 650;
    const agentsChanges: boolean[] = [];
    const terminalChanges: boolean[] = [];
    render(
      <EditorArea
        {...baseProps}
        agentsVisible
        terminalVisible
        terminalPlacement="right"
        onAgentsVisibleChange={(visible: boolean) => {
          agentsChanges.push(visible);
        }}
        onTerminalVisibleChange={(visible: boolean) => {
          terminalChanges.push(visible);
        }}
      />,
    );
    groupLayout = { 'editor-main': 52, 'terminal-column': 30, 'agents-column': 18 };
    await act(async () => {});

    expect(agentsChanges).toEqual([false]);
    expect(terminalChanges).toHaveLength(0);
    expect(toastInfoMessages).toEqual(['Agent panel closed to keep Terminal readable.']);
  });

  test('opening agents at a narrow width closes the existing right terminal', async () => {
    setViewportWidth(650);
    mockGroupPx = 650;
    const terminalChanges: boolean[] = [];
    const view = render(
      <EditorArea
        {...baseProps}
        agentsVisible={false}
        terminalVisible
        terminalPlacement="right"
        onTerminalVisibleChange={(visible: boolean) => {
          terminalChanges.push(visible);
        }}
      />,
    );
    groupLayout = { 'editor-main': 52, 'terminal-column': 30, 'agents-column': 18 };

    view.rerender(
      <EditorArea
        {...baseProps}
        agentsVisible
        terminalVisible
        terminalPlacement="right"
        onTerminalVisibleChange={(visible: boolean) => {
          terminalChanges.push(visible);
        }}
      />,
    );
    await act(async () => {});

    expect(terminalChanges).toEqual([false]);
    expect(toastInfoMessages).toEqual(['Terminal closed to make room for the agent panel.']);
  });

  test('a wide workspace keeps both rails and their independent size constraints', async () => {
    setViewportWidth(2000);
    mockGroupPx = 2000;
    groupLayout = { 'editor-main': 47, 'terminal-column': 37, 'agents-column': 16 };
    const agentsChanges: boolean[] = [];
    const terminalChanges: boolean[] = [];
    render(
      <EditorArea
        {...baseProps}
        agentsVisible
        terminalVisible
        terminalPlacement="right"
        onAgentsVisibleChange={(visible: boolean) => {
          agentsChanges.push(visible);
        }}
        onTerminalVisibleChange={(visible: boolean) => {
          terminalChanges.push(visible);
        }}
      />,
    );
    await act(async () => {});

    const terminalPanel = document.getElementById('terminal-column');
    const agentsPanel = document.getElementById('agents-column');
    expect(terminalPanel?.getAttribute('data-min-size')).toBe('325px');
    expect(terminalPanel?.hasAttribute('data-max-size')).toBe(false);
    expect(agentsPanel?.getAttribute('data-min-size')).toBe('0px');
    expect(agentsPanel?.getAttribute('data-max-size')).toBe('95%');
    expect(agentsChanges).toHaveLength(0);
    expect(terminalChanges).toHaveLength(0);
  });

  test('a hidden right terminal is clamped out of flex flow', () => {
    render(<EditorArea {...baseProps} terminalPlacement="right" />);

    const terminalPanel = document.getElementById('terminal-column');
    expect(terminalPanel?.getAttribute('data-min-size')).toBe('0px');
    expect(terminalPanel?.getAttribute('data-max-size')).toBe('0px');
  });

  test('repeated resize events below the boundary close agents once and keep Terminal open', async () => {
    const originalResizeObserver = globalThis.ResizeObserver;
    const observations: Array<{
      callback: ResizeObserverCallback;
      observer: ResizeObserver;
      target: Element;
    }> = [];
    class TestResizeObserver implements ResizeObserver {
      readonly callback: ResizeObserverCallback;

      constructor(callback: ResizeObserverCallback) {
        this.callback = callback;
      }

      observe(target: Element) {
        observations.push({ callback: this.callback, observer: this, target });
      }

      unobserve() {}

      disconnect() {}
    }
    Object.defineProperty(globalThis, 'ResizeObserver', {
      value: TestResizeObserver,
      configurable: true,
      writable: true,
    });

    try {
      setViewportWidth(2000);
      mockGroupPx = 2000;
      groupLayout = { 'editor-main': 47, 'terminal-column': 37, 'agents-column': 16 };
      const agentsChanges: boolean[] = [];
      const terminalChanges: boolean[] = [];
      render(
        <EditorArea
          {...baseProps}
          agentsVisible
          terminalVisible
          terminalPlacement="right"
          onAgentsVisibleChange={(visible: boolean) => {
            agentsChanges.push(visible);
          }}
          onTerminalVisibleChange={(visible: boolean) => {
            terminalChanges.push(visible);
          }}
        />,
      );
      await act(async () => {});
      expect(agentsChanges).toHaveLength(0);

      mockGroupPx = 650;
      const panels = document.querySelector('[data-editor-area-panels]');
      const panelObservation = observations.find(({ target }) => target === panels);
      expect(panelObservation).toBeDefined();
      act(() => {
        panelObservation?.callback([], panelObservation.observer);
        panelObservation?.callback([], panelObservation.observer);
      });

      expect(agentsChanges).toEqual([false]);
      expect(terminalChanges).toHaveLength(0);
      expect(toastInfoMessages).toEqual(['Agent panel closed to keep Terminal readable.']);
    } finally {
      Object.defineProperty(globalThis, 'ResizeObserver', {
        value: originalResizeObserver,
        configurable: true,
        writable: true,
      });
    }
  });

  test('revealing the right terminal pins its width and routes the remainder to the editor', async () => {
    setViewportWidth(1400);
    const view = render(
      <EditorArea
        {...baseProps}
        terminalVisible
        terminalPlacement="bottom"
        onTerminalVisibleChange={() => {}}
      />,
    );
    groupLayout = { 'editor-main': 65, 'terminal-column': 35 };

    view.rerender(
      <EditorArea
        {...baseProps}
        terminalVisible
        terminalPlacement="right"
        onTerminalVisibleChange={() => {}}
      />,
    );
    await act(async () => {});

    const corrected = groupSetLayoutCalls.at(-1);
    expect(corrected?.['terminal-column']).toBeCloseTo(pctOf(740), 3);
    expect(corrected?.['editor-main']).toBeCloseTo(100 - pctOf(740), 3);
  });

  test('opens the collapsed doc panel while both permanent rail columns are hidden', () => {
    setViewportWidth(1024);
    docCtx = DOC_LIVE_CTX;
    render(<EditorArea {...baseProps} />);
    groupLayout = {
      'editor-main': 100,
      'terminal-column': 0,
      'agents-column': 0,
    };
    groupSetLayoutCalls = [];
    innerSetLayoutCalls = [];

    act(() => emitLocalMenuAction('toggle-doc-panel'));

    const correctedInner = innerSetLayoutCalls.at(-1);
    expect(correctedInner?.['doc-panel']).toBeCloseTo(pctOf(320), 3);
    expect(lastInnerWritePx('doc-panel')).toBeCloseTo(320, 3);
    expect(correctedInner?.['workspace-main']).toBeCloseTo(100 - pctOf(320), 3);
    const corrected = groupSetLayoutCalls.at(-1);
    expect(corrected?.['terminal-column']).toBe(0);
    expect(corrected?.['agents-column']).toBe(0);
    expect(corrected?.['editor-main']).toBe(100);
  });

  test('a second toggle re-opens the doc panel the first toggle collapsed', () => {
    setViewportWidth(1400);
    docCtx = DOC_LIVE_CTX;
    render(<EditorArea {...baseProps} />);
    groupLayout = {
      'editor-main': 100,
      'terminal-column': 0,
      'agents-column': 0,
    };
    innerLayout = { 'workspace-main': 75, 'doc-panel': 25 };
    innerSetLayoutCalls = [];

    act(() => emitLocalMenuAction('toggle-doc-panel'));
    expect(innerSetLayoutCalls.at(-1)?.['doc-panel']).toBe(0);

    act(() => emitLocalMenuAction('toggle-doc-panel'));
    expect(innerSetLayoutCalls.at(-1)?.['doc-panel']).toBeCloseTo(pctOf(320), 3);
    expect(lastInnerWritePx('doc-panel')).toBeCloseTo(320, 3);
  });

  test('hiding the agents panel re-asserts the collapsed doc panel over the stale panel-set restore', async () => {
    setViewportWidth(1024);
    docCtx = DOC_LIVE_CTX;
    const view = render(<EditorArea {...baseProps} agentsVisible />);
    expect(groupSetLayoutCalls).toHaveLength(0);
    expect(innerSetLayoutCalls).toHaveLength(0);
    groupLayout = { 'editor-main': 70, 'agents-column': 30 };
    innerLayout = { 'workspace-main': 70, 'doc-panel': 30 };
    view.rerender(<EditorArea {...baseProps} agentsVisible={false} />);
    await act(async () => {});
    const correctedInner = innerSetLayoutCalls.at(-1);
    expect(correctedInner).toBeDefined();
    expect(correctedInner?.['doc-panel']).toBe(0);
    expect(correctedInner?.['workspace-main']).toBe(100);
    const corrected = groupSetLayoutCalls.at(-1);
    expect(corrected?.['agents-column']).toBe(0);
    expect(corrected?.['editor-main']).toBe(100);
  });

  test('the terminal pin is taken against rendered panel space, not a panel-ratio estimate', async () => {
    setViewportWidth(1900);
    mockGroupPx = 1610;
    docCtx = DOC_LIVE_CTX;
    mockPanelPercentage = (319.51 / 1610) * 100;
    mockPanelPx = 320;
    const view = render(
      <EditorArea {...baseProps} terminalVisible terminalPlacement="right" agentsVisible={false} />,
    );
    groupLayout = { ...RAIL_OUTER_1610 };
    innerLayout = { ...RAIL_INNER_1610 };
    groupSetLayoutCalls = [];

    view.rerender(
      <EditorArea {...baseProps} terminalVisible terminalPlacement="right" agentsVisible />,
    );
    await act(async () => {});

    const corrected = groupSetLayoutCalls.at(-1);
    expect(corrected).toBeDefined();
    const terminalPercentage = corrected?.['terminal-column'];
    if (terminalPercentage == null) throw new Error('terminal column was not pinned');
    expect((terminalPercentage / 100) * 1610).toBeGreaterThan(739);
    expect(terminalPercentage).toBeCloseTo((740 / 1610) * 100, 3);
  });

  const RAIL_OUTER_1610 = {
    'editor-main': 100 - (740 / 1610) * 100,
    'terminal-column': (740 / 1610) * 100,
    'agents-column': 0,
  };
  const RAIL_INNER_1610 = innerRowWithDoc(320, 1610 - 740);
  const strandedOuter1610 = (terminalPercentage: number): MockLayout => ({
    'editor-main': 100 - terminalPercentage,
    'terminal-column': terminalPercentage,
    'agents-column': 0,
  });
  const strandedInner1610 = (terminalPercentage: number): MockLayout =>
    innerRowWithDoc(320, ((100 - terminalPercentage) / 100) * 1610);

  const readExhaustedReports = (warnings: readonly string[]) =>
    warnings
      .map((message) => {
        try {
          return JSON.parse(message) as {
            event?: string;
            trigger?: string;
            stage?: string;
            refusal?: string;
            shortfall?: Record<string, unknown>;
            unaccountedIds?: readonly string[];
          };
        } catch {
          return null;
        }
      })
      .filter((entry) => entry?.event === 'right-rail-pin-exhausted');

  async function withSynchronousFrames(run: () => void | Promise<void>) {
    const warnings: string[] = [];
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation((message: unknown) => {
      warnings.push(String(message));
    });
    const realRequestAnimationFrame = globalThis.requestAnimationFrame;
    globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) => {
      callback(0);
      return 0;
    }) as typeof globalThis.requestAnimationFrame;
    try {
      await run();
      await act(async () => {});
    } finally {
      globalThis.requestAnimationFrame = realRequestAnimationFrame;
      warnSpy.mockRestore();
    }
    return warnings;
  }

  test('the terminal pin is verified against the write, not the frame the panels still show', async () => {
    setViewportWidth(1900);
    mockGroupPx = 1610;
    docCtx = DOC_LIVE_CTX;
    const view = render(
      <EditorArea {...baseProps} terminalVisible terminalPlacement="right" agentsVisible={false} />,
    );
    groupLayout = { ...RAIL_OUTER_1610 };
    committedGroupLayout = { ...RAIL_OUTER_1610 };
    innerLayout = { ...RAIL_INNER_1610 };
    committedInnerLayout = { ...RAIL_INNER_1610 };
    deferPanelGeometryCommit = true;
    groupSetLayoutCalls = [];

    const warnings = await withSynchronousFrames(() => {
      view.rerender(
        <EditorArea {...baseProps} terminalVisible terminalPlacement="right" agentsVisible />,
      );
    });

    const corrected = groupSetLayoutCalls.at(-1);
    expect(corrected).toBeDefined();
    expect(corrected?.['terminal-column']).toBeCloseTo((740 / 1610) * 100, 3);
    expect(readExhaustedReports(warnings)).toEqual([]);
  });

  test('an exhausted terminal pin reports the width the column actually got', async () => {
    setViewportWidth(1900);
    mockGroupPx = 1610;
    docCtx = DOC_LIVE_CTX;
    const strandedTerminalPercentage = 44;
    const view = render(
      <EditorArea {...baseProps} terminalVisible terminalPlacement="right" agentsVisible={false} />,
    );
    groupLayout = strandedOuter1610(strandedTerminalPercentage);
    innerLayout = strandedInner1610(strandedTerminalPercentage);
    rejectGroupLayoutWrites = true;

    const warnings = await withSynchronousFrames(() => {
      view.rerender(
        <EditorArea {...baseProps} terminalVisible terminalPlacement="right" agentsVisible />,
      );
    });

    const exhausted = readExhaustedReports(warnings).at(0);
    expect(exhausted).toBeDefined();
    expect(exhausted?.trigger).toBe('rail-column-sync');
    expect(exhausted?.stage).toBe('width-shortfall');
    expect(exhausted?.shortfall?.['terminal-column']).toEqual({
      targetPx: 740,
      renderedPx: expect.closeTo((strandedTerminalPercentage / 100) * 1610, 6),
    });
  });

  test('a second exhausted loop reports its own outcome, not the one before it', async () => {
    setViewportWidth(1900);
    mockGroupPx = 1610;
    docCtx = DOC_LIVE_CTX;
    const view = render(
      <EditorArea {...baseProps} terminalVisible terminalPlacement="right" agentsVisible={false} />,
    );
    groupLayout = strandedOuter1610(44);
    innerLayout = strandedInner1610(44);
    rejectGroupLayoutWrites = true;

    const warnings = await withSynchronousFrames(() => {
      view.rerender(
        <EditorArea {...baseProps} terminalVisible terminalPlacement="right" agentsVisible />,
      );
      mockGroupPx = 0;
      docCtx = EMPTY_DOC_CTX;
      view.rerender(
        <EditorArea {...baseProps} terminalVisible terminalPlacement="right" agentsVisible />,
      );
    });

    const [fromColumnSync, fromDocSlot] = readExhaustedReports(warnings);
    expect(fromColumnSync?.trigger).toBe('rail-column-sync');
    expect(fromColumnSync?.stage).toBe('width-shortfall');
    expect(fromColumnSync?.shortfall?.['terminal-column']).toEqual({
      targetPx: 740,
      renderedPx: expect.closeTo((44 / 100) * 1610, 6),
    });
    expect(fromDocSlot?.trigger).toBe('doc-slot-presence');
    expect(fromDocSlot?.stage).toBe('panel-space-unresolved');
    expect(fromDocSlot?.refusal).toBe('panel-space-empty');
    expect(fromDocSlot?.shortfall).toBeUndefined();
  });

  test('a layout carrying stray ids reports them instead of a bare missing-residual', async () => {
    setViewportWidth(1900);
    mockGroupPx = 1610;
    docCtx = DOC_LIVE_CTX;
    const view = render(
      <EditorArea
        {...baseProps}
        terminalVisible={false}
        terminalPlacement="right"
        agentsVisible={false}
      />,
    );
    groupLayout = { 'editor-main': 50, 'preview-main': 50 };
    groupSetLayoutCalls = [];

    const warnings = await withSynchronousFrames(() => {
      view.rerender(
        <EditorArea
          {...baseProps}
          terminalVisible
          terminalPlacement="right"
          agentsVisible={false}
        />,
      );
    });

    expect(groupSetLayoutCalls).toHaveLength(0);
    const exhausted = readExhaustedReports(warnings).at(0);
    expect(exhausted).toBeDefined();
    expect(exhausted?.trigger).toBe('rail-column-sync');
    expect(exhausted?.stage).toBe('layout-unaccounted');
    expect(exhausted?.unaccountedIds).toEqual(['editor-main', 'preview-main']);
  });

  test('a rail with no room for its floor widths reports the pin it could not place', async () => {
    setViewportWidth(500);
    mockGroupPx = 300;
    docCtx = DOC_LIVE_CTX;
    const view = render(
      <EditorArea
        {...baseProps}
        terminalVisible={false}
        terminalPlacement="right"
        agentsVisible={false}
      />,
    );
    groupLayout = {
      'editor-main': 60,
      'terminal-column': 40,
      'agents-column': 0,
    };
    groupSetLayoutCalls = [];

    const warnings = await withSynchronousFrames(() => {
      view.rerender(
        <EditorArea
          {...baseProps}
          terminalVisible
          terminalPlacement="right"
          agentsVisible={false}
        />,
      );
    });

    expect(groupSetLayoutCalls).toHaveLength(0);
    const exhausted = readExhaustedReports(warnings).at(0);
    expect(exhausted).toBeDefined();
    expect(exhausted?.trigger).toBe('rail-column-sync');
    expect(exhausted?.stage).toBe('pins-do-not-fit');
    expect(exhausted?.shortfall?.['terminal-column']).toEqual({
      targetPx: RIGHT_TERMINAL_PANEL_MIN_WIDTH_PX,
      renderedPx: expect.closeTo((40 / 100) * 300, 6),
    });
  });

  test('a rail short of its floors leaves out the column that is already wide enough', async () => {
    const DOC_PANEL_FLOOR_PX = 300;
    const groupPx = DOC_PANEL_FLOOR_PX + RIGHT_TERMINAL_PANEL_MIN_WIDTH_PX - 5;
    const terminalRenderedPx = RIGHT_TERMINAL_PANEL_MIN_WIDTH_PX + 175;
    const docRenderedPx = 40;
    setViewportWidth(700);
    mockGroupPx = groupPx;
    docCtx = DOC_LIVE_CTX;
    const view = render(
      <EditorArea
        {...baseProps}
        terminalVisible={false}
        terminalPlacement="right"
        agentsVisible={false}
      />,
    );
    act(() => emitLocalMenuAction('toggle-doc-panel'));
    groupLayout = {
      'editor-main': ((groupPx - terminalRenderedPx) / groupPx) * 100,
      'terminal-column': (terminalRenderedPx / groupPx) * 100,
      'agents-column': 0,
    };
    innerLayout = innerRowWithDoc(docRenderedPx, groupPx - terminalRenderedPx);

    const warnings = await withSynchronousFrames(() => {
      view.rerender(
        <EditorArea
          {...baseProps}
          terminalVisible
          terminalPlacement="right"
          agentsVisible={false}
        />,
      );
    });

    const exhausted = readExhaustedReports(warnings).at(0);
    expect(exhausted).toBeDefined();
    expect(exhausted?.trigger).toBe('rail-column-sync');
    expect(exhausted?.stage).toBe('pins-do-not-fit');
    expect(Object.keys(exhausted?.shortfall ?? {})).toEqual(['doc-panel']);
    expect(exhausted?.shortfall?.['doc-panel']).toEqual({
      targetPx: DOC_PANEL_FLOOR_PX,
      renderedPx: expect.closeTo(docRenderedPx, 6),
    });
  });

  test('a pin that can never land stops reporting once the mount has had its say', async () => {
    setViewportWidth(1900);
    mockGroupPx = 1610;
    docCtx = DOC_LIVE_CTX;
    const view = render(
      <EditorArea {...baseProps} terminalVisible terminalPlacement="right" agentsVisible={false} />,
    );
    groupLayout = strandedOuter1610(44);
    innerLayout = strandedInner1610(44);
    rejectGroupLayoutWrites = true;

    const warnings = await withSynchronousFrames(() => {
      for (let toggle = 0; toggle < MAX_RAIL_PIN_EXHAUSTED_REPORTS + 3; toggle += 1) {
        view.rerender(
          <EditorArea
            {...baseProps}
            terminalVisible
            terminalPlacement="right"
            agentsVisible={toggle % 2 === 0}
          />,
        );
      }
    });

    expect(
      readExhaustedReports(warnings).filter((report) => report.trigger === 'rail-column-sync')
        .length,
    ).toBe(MAX_RAIL_PIN_EXHAUSTED_REPORTS);
  });

  test('one exhausted trigger does not spend the budget the other trigger needs', async () => {
    setViewportWidth(1900);
    mockGroupPx = 1610;
    docCtx = DOC_LIVE_CTX;
    const view = render(
      <EditorArea {...baseProps} terminalVisible terminalPlacement="right" agentsVisible={false} />,
    );
    groupLayout = strandedOuter1610(44);
    innerLayout = strandedInner1610(44);
    rejectGroupLayoutWrites = true;

    const warnings = await withSynchronousFrames(() => {
      for (let toggle = 0; toggle < MAX_RAIL_PIN_EXHAUSTED_REPORTS + 3; toggle += 1) {
        view.rerender(
          <EditorArea
            {...baseProps}
            terminalVisible
            terminalPlacement="right"
            agentsVisible={toggle % 2 === 0}
          />,
        );
      }
      mockGroupPx = 0;
      docCtx = EMPTY_DOC_CTX;
      view.rerender(
        <EditorArea {...baseProps} terminalVisible terminalPlacement="right" agentsVisible />,
      );
    });

    const reports = readExhaustedReports(warnings);
    expect(reports.filter((report) => report.trigger === 'rail-column-sync').length).toBe(
      MAX_RAIL_PIN_EXHAUSTED_REPORTS,
    );
    expect(reports.filter((report) => report.trigger === 'doc-slot-presence').length).toBe(1);
  });

  test('an editor hide the row never settles into reports its own pin outcome under its own cap', async () => {
    setViewportWidth(1400);
    docCtx = DOC_LIVE_CTX;
    const view = render(<EditorArea {...baseProps} agentsVisible />);
    groupLayout = { 'editor-main': 65, 'terminal-column': 0, 'agents-column': 35 };
    await act(async () => {});
    rejectGroupLayoutWrites = true;

    const warnings = await withSynchronousFrames(async () => {
      for (let toggle = 0; toggle <= MAX_RAIL_PIN_EXHAUSTED_REPORTS * 2; toggle += 1) {
        view.rerender(<EditorArea {...baseProps} agentsVisible editorVisible={toggle % 2 === 1} />);
        await act(async () => {});
      }
    });

    const reports = readExhaustedReports(warnings).filter(
      (report) => report.trigger === 'editor-visibility',
    );
    expect(reports.length).toBe(MAX_RAIL_PIN_EXHAUSTED_REPORTS);
    expect(reports[0]?.stage).toBe('editor-hidden-unsettled');
  });

  test('revealing the agents panel keeps the open doc panel open despite a stale cached layout', async () => {
    setViewportWidth(1400);
    docCtx = DOC_LIVE_CTX;
    const view = render(<EditorArea {...baseProps} agentsVisible={false} />);
    groupLayout = { 'editor-main': 70, 'agents-column': 30 };
    innerLayout = innerRowWithDoc(340, 0.7 * 1360);
    view.rerender(<EditorArea {...baseProps} agentsVisible />);
    await act(async () => {});
    const corrected = groupSetLayoutCalls.at(-1);
    expect(corrected).toBeDefined();
    expect(lastInnerWritePx('doc-panel')).toBeCloseTo(320, 3);
    expect(corrected?.['agents-column']).toBeCloseTo(pctOf(480), 3);
    expect(corrected?.['editor-main']).toBeCloseTo(100 - pctOf(480), 3);
    const innerWrite = innerSetLayoutCalls.at(-1);
    expect(innerWrite).toBeDefined();
    expect(
      ((innerWrite?.['workspace-main'] ?? 0) / 100) * (innerSetLayoutPx.at(-1) ?? 0),
    ).toBeCloseTo(1360 - 480 - 320, 3);
  });

  test('the rail keeps one panel-ID set from a document to a new tab', () => {
    setViewportWidth(1400);
    docCtx = DOC_LIVE_CTX;
    const view = render(<EditorArea {...baseProps} agentsVisible />);
    const withDocument = renderedPanelIds();
    const withDocumentInner = renderedInnerPanelIds();
    expect(withDocument).toEqual(['terminal-column', 'agents-column']);
    expect(withDocumentInner).toEqual(['doc-panel']);

    docCtx = EMPTY_DOC_CTX;
    view.rerender(<EditorArea {...baseProps} agentsVisible />);

    expect(renderedPanelIds()).toEqual(withDocument);
    expect(renderedInnerPanelIds()).toEqual(withDocumentInner);
    expect(document.getElementById('doc-panel')?.textContent).toBe('');
  });

  test('the rail keeps one panel-ID set across every view kind', () => {
    setViewportWidth(1400);
    const expected = ['terminal-column', 'agents-column'];
    const expectedInner = ['doc-panel'];
    for (const ctx of [
      DOC_LIVE_CTX,
      EMPTY_DOC_CTX,
      FOLDER_DOC_CTX,
      FOLDER_AGENT_CTX,
      ASSET_DOC_CTX,
      LARGE_FILE_DOC_CTX,
    ]) {
      cleanup();
      docCtx = ctx;
      render(<EditorArea {...baseProps} agentsVisible />);
      expect(renderedPanelIds()).toEqual(expected);
      expect(renderedInnerPanelIds()).toEqual(expectedInner);
    }
  });

  test('an empty slot is clamped out of flex flow, like every hidden rail column', () => {
    setViewportWidth(1400);
    docCtx = ASSET_DOC_CTX;
    const view = render(<EditorArea {...baseProps} agentsVisible />);
    expect(document.getElementById('doc-panel')?.dataset.maxSize).toBe('0px');

    docCtx = DOC_LIVE_CTX;
    view.rerender(<EditorArea {...baseProps} agentsVisible />);
    expect(document.getElementById('doc-panel')?.dataset.maxSize).toBe('600px');
  });

  test('the mid-session load gap keeps the panel-ID set and fills the slot', () => {
    setViewportWidth(1400);
    docCtx = FOLDER_LIVE_CTX;
    const view = render(<EditorArea {...baseProps} agentsVisible />);
    window.location.hash = '#/incoming-doc';
    docCtx = DOC_COLD_CTX;
    view.rerender(<EditorArea {...baseProps} agentsVisible />);

    expect(screen.getByTestId('editor-skeleton')).toBeTruthy();
    expect(renderedPanelIds()).toEqual(['terminal-column', 'agents-column']);
    expect(renderedInnerPanelIds()).toEqual(['doc-panel']);
    expect(document.getElementById('doc-panel')?.childElementCount).toBe(1);
    window.location.hash = '';
  });

  test('emptying the slot hands its width to the editor; refilling takes it back', async () => {
    setViewportWidth(1400);
    docCtx = DOC_LIVE_CTX;
    const view = render(<EditorArea {...baseProps} />);
    groupLayout = {
      'editor-main': 100,
      'terminal-column': 0,
      'agents-column': 0,
    };
    innerLayout = { 'workspace-main': 60, 'doc-panel': 40 };
    innerSetLayoutCalls = [];

    docCtx = ASSET_DOC_CTX;
    view.rerender(<EditorArea {...baseProps} />);
    await act(async () => {});
    const emptied = innerSetLayoutCalls.at(-1);
    expect(emptied?.['doc-panel']).toBe(0);
    expect(emptied?.['workspace-main']).toBe(100);

    innerLayout = { 'workspace-main': 100, 'doc-panel': 0 };
    docCtx = DOC_LIVE_CTX;
    view.rerender(<EditorArea {...baseProps} />);
    await act(async () => {});
    const refilled = innerSetLayoutCalls.at(-1);
    expect(refilled?.['doc-panel']).toBeCloseTo(pctOf(320), 3);
    expect(lastInnerWritePx('doc-panel')).toBeCloseTo(320, 3);
    expect(refilled?.['workspace-main']).toBeCloseTo(100 - pctOf(320), 3);
  });

  test('folder-view agent activity fills the shared slot, not a panel of its own', () => {
    setViewportWidth(1400);
    docCtx = FOLDER_AGENT_CTX;
    render(<EditorArea {...baseProps} />);

    expect(document.getElementById('agent-panel')).toBeNull();
    expect(document.getElementById('doc-panel')?.childElementCount).toBe(1);
  });

  test('a folder-view avatar click opens the slot even when the pane was collapsed', async () => {
    setViewportWidth(1024);
    docCtx = FOLDER_DOC_CTX;
    const view = render(<EditorArea {...baseProps} />);
    groupLayout = {
      'editor-main': 100,
      'terminal-column': 0,
      'agents-column': 0,
    };
    innerSetLayoutCalls = [];

    docCtx = { ...FOLDER_AGENT_CTX, docPanelExpandSignal: 1 };
    view.rerender(<EditorArea {...baseProps} />);
    await act(async () => {});

    const opened = innerSetLayoutCalls.at(-1);
    expect(opened?.['doc-panel']).toBeCloseTo(pctOf(320), 3);
    expect(lastInnerWritePx('doc-panel')).toBeCloseTo(320, 3);
  });

  test('an avatar click with the editor hidden shows the editor, then opens the side panel', async () => {
    setViewportWidth(1024);
    docCtx = FOLDER_DOC_CTX;
    __resetPaneVisibilityStoreForTests();
    const requests: PaneVisibilityRequest[] = [];
    paneVisibilityStore.subscribeRequests((request) => requests.push(request));
    const view = render(<EditorArea {...baseProps} editorVisible={false} />);
    groupLayout = {
      'editor-main': 100,
      'terminal-column': 0,
      'agents-column': 0,
    };
    await act(async () => {});
    innerSetLayoutCalls = [];

    docCtx = { ...FOLDER_AGENT_CTX, docPanelExpandSignal: 1 };
    view.rerender(<EditorArea {...baseProps} editorVisible={false} />);
    await act(async () => {});
    expect(requests).toEqual([{ pane: 'editor', open: true }]);

    view.rerender(<EditorArea {...baseProps} />);
    await act(async () => {});
    expect(lastInnerWritePx('doc-panel')).toBeCloseTo(320, 3);
    __resetPaneVisibilityStoreForTests();
  });

  test('a view with no document pane pins the slot shut and ignores the toggle', async () => {
    setViewportWidth(1400);
    docCtx = ASSET_DOC_CTX;
    groupLayout = {
      'editor-main': 100 - pctOf(480),
      'terminal-column': 0,
      'agents-column': pctOf(480),
    };
    render(<EditorArea {...baseProps} agentsVisible />);
    groupSetLayoutCalls = [];
    innerSetLayoutCalls = [];
    groupLayout = {
      'editor-main': 70,
      'terminal-column': 0,
      'agents-column': 30,
    };
    innerLayout = { 'workspace-main': 75, 'doc-panel': 25 };

    act(() => emitLocalMenuAction('toggle-doc-panel'));
    await act(async () => {});

    expect(groupSetLayoutCalls).toHaveLength(0);
    expect(innerSetLayoutCalls).toHaveLength(0);
  });

  test('releasing an agents-handle drag below the close threshold hides the panel', async () => {
    setViewportWidth(1400);
    const visibleChanges: boolean[] = [];
    render(
      <EditorArea
        {...baseProps}
        agentsVisible
        onAgentsVisibleChange={(visible: boolean) => {
          visibleChanges.push(visible);
        }}
      />,
    );
    const handle = getAgentsHandle();
    act(() => {
      fireEvent.pointerDown(handle, { pointerId: 1 });
    });
    mockPanelPx = 0;
    mockPanelPercentage = 0;
    panelIsCollapsed = true;
    act(() => {
      fireEvent.pointerUp(window, { pointerId: 1 });
    });
    expect(visibleChanges.at(-1)).toBe(false);
  });

  test('a divider drag that closes chat while its history covers the panel leaves it collapsed without changing visibility', async () => {
    setViewportWidth(1400);
    const visibleChanges: boolean[] = [];
    render(
      <EditorArea
        {...baseProps}
        agentsVisible
        onAgentsVisibleChange={(visible: boolean) => {
          visibleChanges.push(visible);
        }}
      />,
    );
    const mount = document.querySelector('[data-agents-panel-mount]');
    if (mount == null) throw new Error('no chat mount to hold the history cover');
    const cover = document.createElement('aside');
    cover.setAttribute('data-history-mode', 'cover');
    mount.appendChild(cover);
    const handle = getAgentsHandle();
    act(() => {
      fireEvent.pointerDown(handle, { pointerId: 1 });
    });
    mockPanelPx = 0;
    mockPanelPercentage = 0;
    panelIsCollapsed = true;
    act(() => {
      fireEvent.pointerUp(window, { pointerId: 1 });
    });
    expect(visibleChanges).toEqual([]);
    cover.remove();
  });

  test('releasing an agents-handle drag in the middle band settles at the minimum', () => {
    setViewportWidth(1400);
    const visibleChanges: boolean[] = [];
    render(
      <EditorArea
        {...baseProps}
        agentsVisible
        onAgentsVisibleChange={(visible: boolean) => {
          visibleChanges.push(visible);
        }}
      />,
    );
    groupLayout = { 'editor-main': 100 - pctOf(250), 'agents-column': pctOf(250) };
    groupSetLayoutCalls = [];
    const handle = getAgentsHandle();
    act(() => {
      fireEvent.pointerDown(handle, { pointerId: 1 });
    });
    mockPanelPx = 250;
    mockPanelPercentage = pctOf(250);
    act(() => {
      fireEvent.pointerUp(window, { pointerId: 1 });
    });
    expect(visibleChanges).toHaveLength(0);
    expect(groupSetLayoutCalls.at(-1)?.['agents-column']).toBeCloseTo(pctOf(320), 3);
  });

  test('a rejected first agents pointer settlement still reaches the minimum', async () => {
    setViewportWidth(1400);
    groupLayout = {
      'editor-main': 100 - pctOf(480),
      'agents-column': pctOf(480),
    };
    render(<EditorArea {...baseProps} agentsVisible />);
    await act(async () => {});

    groupLayout = {
      'editor-main': 100 - pctOf(250),
      'agents-column': pctOf(250),
    };
    mockPanelPx = 250;
    mockPanelPercentage = pctOf(250);
    rejectNextGroupLayoutWrite = true;
    const handle = getAgentsHandle();

    act(() => {
      fireEvent.pointerDown(handle, { pointerId: 1 });
      fireEvent.pointerUp(window, { pointerId: 1 });
    });

    await act(
      () =>
        new Promise<void>((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
        }),
    );

    expect(groupLayout['agents-column']).toBeCloseTo(pctOf(320), 3);
  });

  test.each([
    ['document', 'doc-panel'],
    ['terminal', TERMINAL_COLUMN_ID],
  ] as const)(
    'an active %s drag blocks agents settlement without spending its failure budget',
    (_label, columnId) => {
      setViewportWidth(1400);
      docCtx = FOLDER_DOC_CTX;
      groupLayout = {
        'editor-main': 100 - pctOf(440 + 480),
        'terminal-column': pctOf(440),
        'agents-column': pctOf(480),
      };
      innerLayout = innerRowWithDoc(320, 1360 - 440 - 480);
      const frames = controlAnimationFrames();
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        render(
          <EditorArea
            {...baseProps}
            agentsVisible
            terminalVisible
            terminalPlacement="right"
            onTerminalVisibleChange={() => {}}
          />,
        );
        groupLayout = {
          'editor-main': 100 - pctOf(440 + 250),
          'terminal-column': pctOf(440),
          'agents-column': pctOf(250),
        };
        innerLayout = innerRowWithDoc(320, 1360 - 440 - 250);
        mockPanelPx = 250;
        mockPanelPercentage = pctOf(250);
        rejectNextGroupLayoutWrite = true;

        act(() => {
          fireEvent.pointerDown(getAgentsHandle(), { pointerId: 1 });
          fireEvent.pointerUp(window, { pointerId: 1 });
        });

        const panel = document.getElementById(columnId);
        const handle = panel?.previousElementSibling;
        if (!(handle instanceof HTMLElement))
          throw new Error(`${columnId} resize handle not found`);
        rejectGroupLayoutWrites = true;
        act(() => {
          fireEvent.pointerDown(handle, { pointerId: 2 });
        });
        const writesBeforeBlockedFrames = groupSetLayoutCalls.length;

        frames.run(40);

        expect.soft(groupSetLayoutCalls).toHaveLength(writesBeforeBlockedFrames);
        expect.soft(warnSpy.mock.calls).toEqual([]);
        expect.soft(frames.pendingCount()).toBe(1);

        rejectGroupLayoutWrites = false;
        act(() => {
          fireEvent.pointerUp(window, { pointerId: 2 });
        });
        frames.run(1);

        expect.soft(groupLayout['agents-column']).toBeCloseTo(pctOf(320), 3);
        expect.soft(frames.pendingCount()).toBe(0);
      } finally {
        warnSpy.mockRestore();
        frames.restore();
      }
    },
  );

  test('a permanently blocked agents settlement reports without an animation frame', () => {
    const blockedRetryTimeoutMs = 60_000;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    setViewportWidth(1400);
    docCtx = FOLDER_DOC_CTX;
    groupLayout = {
      'editor-main': 100 - pctOf(480),
      'agents-column': pctOf(480),
    };
    innerLayout = innerRowWithDoc(320, 1360 - 480);
    const frames = controlAnimationFrames();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      render(<EditorArea {...baseProps} agentsVisible />);
      groupLayout = {
        'editor-main': 100 - pctOf(250),
        'agents-column': pctOf(250),
      };
      innerLayout = innerRowWithDoc(320, 1360 - 250);
      mockPanelPx = 250;
      mockPanelPercentage = pctOf(250);
      rejectNextGroupLayoutWrite = true;

      act(() => {
        fireEvent.pointerDown(getAgentsHandle(), { pointerId: 1 });
        fireEvent.pointerUp(window, { pointerId: 1 });
      });

      const docPanel = document.getElementById('doc-panel');
      const docHandle = docPanel?.previousElementSibling;
      if (!(docHandle instanceof HTMLElement)) throw new Error('doc-panel resize handle not found');
      act(() => {
        fireEvent.pointerDown(docHandle, { pointerId: 2 });
      });

      act(() => vi.advanceTimersByTime(blockedRetryTimeoutMs));

      expect.soft(warnSpy.mock.calls).toEqual([
        [
          JSON.stringify({
            event: 'rail-layout-retry-exhausted',
            error: 'Rail layout did not apply within the retry budget',
            decision: 'settle-minimum',
            targetWidthPx: 320,
          }),
        ],
      ]);
      expect.soft(frames.pendingCount()).toBe(0);
    } finally {
      cleanup();
      warnSpy.mockRestore();
      frames.restore();
      vi.useRealTimers();
    }
  });

  test('an agents pointer settlement reports once after exhausting its retry budget', () => {
    setViewportWidth(1400);
    groupLayout = {
      'editor-main': 100 - pctOf(480),
      'agents-column': pctOf(480),
    };
    const frames = controlAnimationFrames();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      render(<EditorArea {...baseProps} agentsVisible />);
      groupLayout = {
        'editor-main': 100 - pctOf(250),
        'agents-column': pctOf(250),
      };
      mockPanelPx = 250;
      mockPanelPercentage = pctOf(250);
      rejectGroupLayoutWrites = true;
      const handle = getAgentsHandle();

      act(() => {
        fireEvent.pointerDown(handle, { pointerId: 1 });
        fireEvent.pointerUp(window, { pointerId: 1 });
      });
      frames.run(30);

      expect(frames.pendingCount()).toBe(0);
      expect(warnSpy.mock.calls).toEqual([
        [
          JSON.stringify({
            event: 'rail-layout-retry-exhausted',
            error: 'Rail layout did not apply within the retry budget',
            decision: 'settle-minimum',
            targetWidthPx: 320,
          }),
        ],
      ]);
    } finally {
      warnSpy.mockRestore();
      frames.restore();
    }
  });

  test('a production close reports exhaustion with its decision and target width', () => {
    setViewportWidth(1400);
    groupLayout = {
      'editor-main': 100 - pctOf(480),
      'agents-column': pctOf(480),
    };
    const frames = controlAnimationFrames();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    function ControlledAgentsVisibility() {
      const [agentsVisible, setAgentsVisible] = useState(true);
      return (
        <EditorArea
          {...baseProps}
          agentsVisible={agentsVisible}
          onAgentsVisibleChange={setAgentsVisible}
        />
      );
    }
    try {
      render(<ControlledAgentsVisibility />);
      groupLayout = {
        'editor-main': 100 - pctOf(100),
        'agents-column': pctOf(100),
      };
      mockPanelPx = 100;
      mockPanelPercentage = pctOf(100);
      rejectGroupLayoutWrites = true;

      act(() => {
        fireEvent.pointerDown(getAgentsHandle(), { pointerId: 1 });
        fireEvent.pointerUp(window, { pointerId: 1 });
      });
      frames.run(30);

      expect(frames.pendingCount()).toBe(0);
      expect(warnSpy.mock.calls).toEqual([
        [
          JSON.stringify({
            event: 'rail-layout-retry-exhausted',
            error: 'Rail layout did not apply within the retry budget',
            decision: 'close',
            targetWidthPx: 0,
          }),
        ],
      ]);
    } finally {
      warnSpy.mockRestore();
      frames.restore();
    }
  });

  test('a newer agents-handle interaction supersedes a pending settlement frame', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    setViewportWidth(1400);
    groupLayout = {
      'editor-main': 100 - pctOf(480),
      'agents-column': pctOf(480),
    };
    const frames = controlAnimationFrames();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      render(<EditorArea {...baseProps} agentsVisible />);
      groupLayout = {
        'editor-main': 100 - pctOf(250),
        'agents-column': pctOf(250),
      };
      mockPanelPx = 250;
      mockPanelPercentage = pctOf(250);
      rejectNextGroupLayoutWrite = true;
      const handle = getAgentsHandle();

      act(() => {
        fireEvent.pointerDown(handle, { pointerId: 1 });
        fireEvent.pointerUp(window, { pointerId: 1 });
      });
      const pendingAfterFirstRelease = frames.pendingCount();

      groupLayout = {
        'editor-main': 100 - pctOf(600),
        'agents-column': pctOf(600),
      };
      mockPanelPx = 600;
      mockPanelPercentage = pctOf(600);
      act(() => {
        fireEvent.pointerDown(handle, { pointerId: 2 });
      });
      const pendingDuringSecondDrag = frames.pendingCount();
      act(() => {
        fireEvent.pointerUp(window, { pointerId: 2 });
      });
      frames.run(30);
      act(() => vi.advanceTimersByTime(60_000));

      expect.soft(pendingAfterFirstRelease).toBeGreaterThan(0);
      expect.soft(pendingDuringSecondDrag).toBe(0);
      expect.soft(groupLayout['agents-column']).toBeCloseTo(pctOf(600), 3);
      expect(warnSpy.mock.calls).toEqual([]);
    } finally {
      cleanup();
      warnSpy.mockRestore();
      frames.restore();
      vi.useRealTimers();
    }
  });

  test('unmount cancels a pending agents pointer settlement frame', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    setViewportWidth(1400);
    groupLayout = {
      'editor-main': 100 - pctOf(480),
      'agents-column': pctOf(480),
    };
    const frames = controlAnimationFrames();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const view = render(<EditorArea {...baseProps} agentsVisible />);
      groupLayout = {
        'editor-main': 100 - pctOf(250),
        'agents-column': pctOf(250),
      };
      mockPanelPx = 250;
      mockPanelPercentage = pctOf(250);
      rejectNextGroupLayoutWrite = true;
      const handle = getAgentsHandle();

      act(() => {
        fireEvent.pointerDown(handle, { pointerId: 1 });
        fireEvent.pointerUp(window, { pointerId: 1 });
      });
      const pendingBeforeUnmount = frames.pendingCount();
      const writesBeforeUnmount = groupSetLayoutCalls.length;
      act(() => view.unmount());
      const pendingAfterUnmount = frames.pendingCount();
      frames.run(30);
      act(() => vi.advanceTimersByTime(60_000));

      expect.soft(pendingBeforeUnmount).toBeGreaterThan(0);
      expect.soft(pendingAfterUnmount).toBe(0);
      expect.soft(groupSetLayoutCalls).toHaveLength(writesBeforeUnmount);
      expect.soft(groupLayout['agents-column']).toBeCloseTo(pctOf(250), 3);
      expect(warnSpy.mock.calls).toEqual([]);
    } finally {
      warnSpy.mockRestore();
      frames.restore();
      vi.useRealTimers();
    }
  });

  test('releasing an agents-handle drag above the minimum commits the measured width', () => {
    setViewportWidth(1400);
    render(<EditorArea {...baseProps} agentsVisible />);
    groupLayout = { 'editor-main': 100 - pctOf(600), 'agents-column': pctOf(600) };
    groupSetLayoutCalls = [];
    const handle = getAgentsHandle();
    act(() => {
      fireEvent.pointerDown(handle, { pointerId: 1 });
    });
    mockPanelPx = 600;
    mockPanelPercentage = pctOf(600);
    act(() => {
      fireEvent.pointerUp(window, { pointerId: 1 });
    });
    expect(groupSetLayoutCalls.at(-1)?.['agents-column']).toBeCloseTo(pctOf(600), 3);
    expect(localStorage.getItem('ok-terminal-width-v1')).toBe('600');
  });

  test('a close-threshold release without a visibility callback restores the preferred width', () => {
    setViewportWidth(1400);
    render(<EditorArea {...baseProps} agentsVisible onAgentsVisibleChange={undefined} />);
    groupLayout = { 'editor-main': 100 - pctOf(100), 'agents-column': pctOf(100) };
    groupSetLayoutCalls = [];
    const handle = getAgentsHandle();
    act(() => {
      fireEvent.pointerDown(handle, { pointerId: 1 });
    });
    mockPanelPx = 100;
    mockPanelPercentage = pctOf(100);
    act(() => {
      fireEvent.pointerUp(window, { pointerId: 1 });
    });
    expect(groupSetLayoutCalls.at(-1)?.['agents-column']).toBeCloseTo(pctOf(480), 3);
  });

  test('a close-threshold fallback reports the closed target when settlement exhausts', () => {
    setViewportWidth(1400);
    groupLayout = {
      'editor-main': 100 - pctOf(480),
      'agents-column': pctOf(480),
    };
    const frames = controlAnimationFrames();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      render(<EditorArea {...baseProps} agentsVisible onAgentsVisibleChange={undefined} />);
      groupLayout = {
        'editor-main': 100 - pctOf(100),
        'agents-column': pctOf(100),
      };
      mockPanelPx = 100;
      mockPanelPercentage = pctOf(100);
      rejectGroupLayoutWrites = true;

      act(() => {
        fireEvent.pointerDown(getAgentsHandle(), { pointerId: 1 });
        fireEvent.pointerUp(window, { pointerId: 1 });
      });
      frames.run(30);

      expect(frames.pendingCount()).toBe(0);
      expect(warnSpy.mock.calls).toEqual([
        [
          JSON.stringify({
            event: 'rail-layout-retry-exhausted',
            error: 'Rail layout did not apply within the retry budget',
            decision: 'close',
            targetWidthPx: 0,
          }),
        ],
      ]);
    } finally {
      warnSpy.mockRestore();
      frames.restore();
    }
  });

  test('transient drag widths never reach durable storage', () => {
    vi.useFakeTimers();
    try {
      setViewportWidth(1400);
      render(<EditorArea {...baseProps} agentsVisible />);
      const handle = getAgentsHandle();
      act(() => {
        fireEvent.pointerDown(handle, { pointerId: 1 });
        railPanelOnResizeById.get(AGENTS_COLUMN_ID)?.({
          asPercentage: pctOf(250),
          inPixels: 250,
        });
        vi.advanceTimersByTime(101);
      });
      expect(localStorage.getItem('ok-terminal-width-v1')).toBeNull();
      act(() => {
        fireEvent.pointerCancel(window, { pointerId: 1 });
      });
    } finally {
      vi.useRealTimers();
    }
  });

  test('names the agents-only separator for the Agents pane it resizes', () => {
    setViewportWidth(1400);
    render(<EditorArea {...baseProps} agentsVisible />);

    const handle = screen.getByRole('separator', { name: 'Agents' });
    expect(handle).toBe(getAgentsHandle());
    expect(handle.getAttribute('aria-controls')).toBe(AGENTS_COLUMN_ID);
  });

  test('names the side panel and right terminal separators for the panes they resize', () => {
    setViewportWidth(1400);
    docCtx = DOC_LIVE_CTX;
    render(<EditorArea {...baseProps} agentsVisible terminalVisible terminalPlacement="right" />);

    expect(
      screen
        .getByRole('separator', { name: 'Resize document panel' })
        .getAttribute('aria-controls'),
    ).toBe('doc-panel');
    expect(
      screen.getByRole('separator', { name: 'Resize terminal' }).getAttribute('aria-controls'),
    ).toBe(TERMINAL_COLUMN_ID);
    expect(screen.getByRole('separator', { name: 'Terminal' })).toBe(getAgentsHandle());
  });

  test('keyboard resizing floors only the focused agents separator', () => {
    setViewportWidth(1400);
    render(<EditorArea {...baseProps} agentsVisible terminalVisible terminalPlacement="right" />);
    const handle = getAgentsHandle();
    expect(screen.getByRole('separator', { name: 'Terminal' })).toBe(handle);
    expect(handle.getAttribute('aria-controls')).toBe(TERMINAL_COLUMN_ID);
    handle.focus();
    const activeElement = document.activeElement;
    groupLayout = {
      'editor-main': 70,
      'terminal-column': 10,
      'agents-column': 20,
    };
    groupSetLayoutCalls = [];
    act(() => {
      groupOnLayoutChanged?.(groupLayout, { isUserInteraction: true });
    });
    expect(groupSetLayoutCalls.at(-1)?.['agents-column']).toBeCloseTo(pctOf(320), 3);
    expect(document.activeElement).toBe(activeElement);
    expect(localStorage.getItem('ok-terminal-width-v1')).toBeNull();

    const terminalHandle = screen.getAllByTestId('resizable-handle').at(-2);
    terminalHandle?.focus();
    groupSetLayoutCalls = [];
    act(() => {
      groupOnLayoutChanged?.(groupLayout, { isUserInteraction: true });
    });
    expect(groupSetLayoutCalls).toHaveLength(0);
  });

  test('keyboard resizing reaches the minimum after the first layout write is refused', () => {
    setViewportWidth(1400);
    groupLayout = {
      'editor-main': 100 - pctOf(480),
      'agents-column': pctOf(480),
    };
    const frames = controlAnimationFrames();
    try {
      render(<EditorArea {...baseProps} agentsVisible />);
      getAgentsHandle().focus();
      groupLayout = {
        'editor-main': 100 - pctOf(250),
        'agents-column': pctOf(250),
      };
      rejectNextGroupLayoutWrite = true;

      act(() => {
        groupOnLayoutChanged?.(groupLayout, { isUserInteraction: true });
      });

      expect(groupLayout['agents-column']).toBeCloseTo(pctOf(250), 3);
      frames.run(1);
      expect(groupLayout['agents-column']).toBeCloseTo(pctOf(320), 3);
      expect(frames.pendingCount()).toBe(0);
    } finally {
      frames.restore();
    }
  });

  test('keyboard retry recomputes the minimum after the group width changes', () => {
    setViewportWidth(1400);
    groupLayout = {
      'editor-main': 100 - pctOf(480),
      'agents-column': pctOf(480),
    };
    const frames = controlAnimationFrames();
    try {
      render(<EditorArea {...baseProps} agentsVisible />);
      getAgentsHandle().focus();
      groupLayout = {
        'editor-main': 100 - pctOf(250),
        'agents-column': pctOf(250),
      };
      rejectNextGroupLayoutWrite = true;

      act(() => {
        groupOnLayoutChanged?.(groupLayout, { isUserInteraction: true });
      });

      const writesAfterRejectedAttempt = groupSetLayoutCalls.length;
      mockGroupPx = 0;
      frames.run(1);
      expect(groupSetLayoutCalls).toHaveLength(writesAfterRejectedAttempt);
      expect(frames.pendingCount()).toBe(1);

      mockGroupPx = 1000;
      frames.run(1);

      expect(groupLayout['agents-column']).toBeCloseTo(32, 3);
      expect(document.getElementById('agents-column')?.getBoundingClientRect().width).toBeCloseTo(
        320,
        3,
      );
      expect(frames.pendingCount()).toBe(0);
    } finally {
      frames.restore();
    }
  });

  test('keyboard resizing reports exhaustion with its minimum width target', () => {
    setViewportWidth(1400);
    groupLayout = {
      'editor-main': 100 - pctOf(480),
      'agents-column': pctOf(480),
    };
    const frames = controlAnimationFrames();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      render(<EditorArea {...baseProps} agentsVisible />);
      getAgentsHandle().focus();
      groupLayout = {
        'editor-main': 100 - pctOf(250),
        'agents-column': pctOf(250),
      };
      rejectGroupLayoutWrites = true;

      act(() => {
        groupOnLayoutChanged?.(groupLayout, { isUserInteraction: true });
      });
      frames.run(30);

      expect(groupLayout['agents-column']).toBeCloseTo(pctOf(250), 3);
      expect(frames.pendingCount()).toBe(0);
      expect(warnSpy.mock.calls).toEqual([
        [
          JSON.stringify({
            event: 'rail-layout-retry-exhausted',
            error: 'Rail layout did not apply within the retry budget',
            decision: 'keyboard-settle-minimum',
            targetWidthPx: MIN_AGENTS_PANEL_WIDTH,
          }),
        ],
      ]);
    } finally {
      warnSpy.mockRestore();
      frames.restore();
    }
  });

  test('a newer keyboard width cancels a refused minimum settlement', () => {
    setViewportWidth(1400);
    groupLayout = {
      'editor-main': 100 - pctOf(480),
      'agents-column': pctOf(480),
    };
    const frames = controlAnimationFrames();
    try {
      render(<EditorArea {...baseProps} agentsVisible />);
      getAgentsHandle().focus();
      groupLayout = {
        'editor-main': 100 - pctOf(250),
        'agents-column': pctOf(250),
      };
      rejectNextGroupLayoutWrite = true;
      act(() => {
        groupOnLayoutChanged?.(groupLayout, { isUserInteraction: true });
      });
      expect(frames.pendingCount()).toBe(1);

      groupLayout = {
        'editor-main': 100 - pctOf(600),
        'agents-column': pctOf(600),
      };
      act(() => {
        groupOnLayoutChanged?.(groupLayout, { isUserInteraction: true });
      });
      frames.run(30);

      expect(groupLayout['agents-column']).toBeCloseTo(pctOf(600), 3);
      expect(frames.pendingCount()).toBe(0);
    } finally {
      frames.restore();
    }
  });

  test('a focused keyboard width supersedes a refused pointer settlement', () => {
    setViewportWidth(1400);
    groupLayout = {
      'editor-main': 100 - pctOf(480),
      'agents-column': pctOf(480),
    };
    const frames = controlAnimationFrames();
    try {
      render(<EditorArea {...baseProps} agentsVisible />);
      groupLayout = {
        'editor-main': 100 - pctOf(250),
        'agents-column': pctOf(250),
      };
      mockPanelPx = 250;
      mockPanelPercentage = pctOf(250);
      rejectNextGroupLayoutWrite = true;
      const handle = getAgentsHandle();

      act(() => {
        fireEvent.pointerDown(handle, { pointerId: 1 });
        fireEvent.pointerUp(window, { pointerId: 1 });
      });
      expect(frames.pendingCount()).toBe(1);

      handle.focus();
      groupLayout = {
        'editor-main': 100 - pctOf(600),
        'agents-column': pctOf(600),
      };
      mockPanelPx = 600;
      mockPanelPercentage = pctOf(600);
      act(() => {
        groupOnLayoutChanged?.(groupLayout, { isUserInteraction: true });
      });
      frames.run(30);

      expect(groupLayout['agents-column']).toBeCloseTo(pctOf(600), 3);
      expect(frames.pendingCount()).toBe(0);
    } finally {
      frames.restore();
    }
  });

  test('a different focused handle supersedes a refused keyboard settlement', () => {
    setViewportWidth(1400);
    docCtx = FOLDER_DOC_CTX;
    groupLayout = {
      'editor-main': 100 - pctOf(480),
      'agents-column': pctOf(480),
    };
    innerLayout = innerRowWithDoc(320, 1360 - 480);
    const frames = controlAnimationFrames();
    try {
      render(<EditorArea {...baseProps} agentsVisible />);
      getAgentsHandle().focus();
      groupLayout = {
        'editor-main': 100 - pctOf(250),
        'agents-column': pctOf(250),
      };
      innerLayout = innerRowWithDoc(320, 1360 - 250);
      rejectNextGroupLayoutWrite = true;
      act(() => {
        groupOnLayoutChanged?.(groupLayout, { isUserInteraction: true });
      });
      expect(frames.pendingCount()).toBe(1);

      const docPanel = document.getElementById('doc-panel');
      const docHandle = docPanel?.previousElementSibling;
      if (!(docHandle instanceof HTMLElement)) throw new Error('doc-panel resize handle not found');
      docHandle.focus();
      groupLayout = {
        'editor-main': 100 - pctOf(600),
        'agents-column': pctOf(600),
      };
      innerLayout = innerRowWithDoc(320, 1360 - 600);
      act(() => {
        innerRowHandlers.onLayoutChanged?.(innerLayout, { isUserInteraction: true });
      });
      frames.run(30);

      expect(groupLayout['agents-column']).toBeCloseTo(pctOf(600), 3);
      expect(frames.pendingCount()).toBe(0);
    } finally {
      frames.restore();
    }
  });

  test.each([
    { label: 'doc', panelId: 'doc-panel', terminalVisible: false },
    { label: 'Terminal', panelId: 'terminal-column', terminalVisible: true },
  ])(
    'a $label handle drag pauses a refused keyboard settlement',
    ({ panelId, terminalVisible }) => {
      setViewportWidth(1400);
      if (!terminalVisible) docCtx = FOLDER_DOC_CTX;
      const outerRowWith = (agentsPx: number): MockLayout =>
        terminalVisible
          ? {
              'editor-main': 100 - pctOf(320 + agentsPx),
              'terminal-column': pctOf(320),
              'agents-column': pctOf(agentsPx),
            }
          : { 'editor-main': 100 - pctOf(agentsPx), 'agents-column': pctOf(agentsPx) };
      groupLayout = outerRowWith(480);
      if (!terminalVisible) innerLayout = innerRowWithDoc(320, 1360 - 480);
      const frames = controlAnimationFrames();
      try {
        render(
          <EditorArea
            {...baseProps}
            agentsVisible
            terminalVisible={terminalVisible}
            terminalPlacement="right"
          />,
        );
        getAgentsHandle().focus();
        groupLayout = outerRowWith(250);
        if (!terminalVisible) innerLayout = innerRowWithDoc(320, 1360 - 250);
        rejectNextGroupLayoutWrite = true;
        act(() => {
          groupOnLayoutChanged?.(groupLayout, { isUserInteraction: true });
        });
        expect(frames.pendingCount()).toBe(1);

        const panel = document.getElementById(panelId);
        const handle = panel?.previousElementSibling;
        if (!(handle instanceof HTMLElement)) throw new Error(`${panelId} resize handle not found`);
        const writesBeforeDrag = groupSetLayoutCalls.length;
        act(() => {
          fireEvent.pointerDown(handle, { pointerId: 1 });
        });
        handle.focus();
        act(() => {
          if (panelId === 'doc-panel') {
            innerRowHandlers.onLayoutChanged?.(innerLayout, { isUserInteraction: true });
          } else {
            groupOnLayoutChanged?.(groupLayout, { isUserInteraction: true });
          }
        });
        frames.run(30);

        expect(groupLayout['agents-column']).toBeCloseTo(pctOf(250), 3);
        expect(groupSetLayoutCalls).toHaveLength(writesBeforeDrag);
        expect(frames.pendingCount()).toBe(1);

        act(() => {
          fireEvent.pointerUp(window, { pointerId: 1 });
        });
        frames.run(1);

        expect(groupLayout['agents-column']).toBeCloseTo(pctOf(320), 3);
        expect(frames.pendingCount()).toBe(0);
      } finally {
        frames.restore();
      }
    },
  );

  test('keyboard resizing uses the current group box when panel pixels lag the layout callback', () => {
    setViewportWidth(1200);
    render(<EditorArea {...baseProps} agentsVisible />);
    const handle = getAgentsHandle();
    handle.focus();
    const panelWidths = [880, 0, 320];
    const panelElements = screen
      .getByTestId('resizable-group')
      .querySelectorAll(':scope > [data-slot="resizable-panel"]');
    expect(panelElements).toHaveLength(panelWidths.length);
    panelElements.forEach((element, index) => {
      Object.defineProperty(element, 'getBoundingClientRect', {
        configurable: true,
        value: () => {
          const width = panelWidths[index] ?? 0;
          return { width, height: 0, top: 0, left: 0, right: width, bottom: 0, x: 0, y: 0 };
        },
      });
    });
    mockPanelPercentage = (260 / 1200) * 100;
    mockPanelPx = 320.004;
    groupLayout = {
      'editor-main': 100 - mockPanelPercentage,
      'terminal-column': 0,
      'agents-column': mockPanelPercentage,
    };
    groupSetLayoutCalls = [];

    act(() => {
      groupOnLayoutChanged?.(groupLayout, { isUserInteraction: true });
    });

    expect(groupSetLayoutCalls.at(-1)?.['agents-column']).toBeCloseTo((320 / 1200) * 100, 3);
  });

  test('keyboard collapse leaves logical visibility unchanged', () => {
    setViewportWidth(1400);
    const visibleChanges: boolean[] = [];
    render(
      <EditorArea
        {...baseProps}
        agentsVisible
        onAgentsVisibleChange={(visible: boolean) => {
          visibleChanges.push(visible);
        }}
      />,
    );
    getAgentsHandle().focus();
    groupLayout = {
      'editor-main': 100,
      'terminal-column': 0,
      'agents-column': 0,
    };
    groupSetLayoutCalls = [];
    act(() => {
      groupOnLayoutChanged?.(groupLayout, { isUserInteraction: true });
      railPanelOnResizeById.get(AGENTS_COLUMN_ID)?.({ asPercentage: 0, inPixels: 0 });
    });
    expect(groupSetLayoutCalls).toHaveLength(0);
    expect(visibleChanges).toHaveLength(0);
  });

  test('releasing an agents-handle drag with the column still open does NOT hide the panel', async () => {
    setViewportWidth(1400);
    const visibleChanges: boolean[] = [];
    render(
      <EditorArea
        {...baseProps}
        agentsVisible
        onAgentsVisibleChange={(visible: boolean) => {
          visibleChanges.push(visible);
        }}
      />,
    );
    const handle = getAgentsHandle();
    act(() => {
      fireEvent.pointerDown(handle);
    });
    act(() => {
      fireEvent.pointerUp(window);
    });
    expect(visibleChanges).toHaveLength(0);
  });

  test('a pointercancel-terminated drag still clears the flag that gates the layout assert', async () => {
    setViewportWidth(1400);
    const view = render(<EditorArea {...baseProps} agentsVisible />);
    const handle = getAgentsHandle();
    act(() => {
      fireEvent.pointerDown(handle);
    });
    act(() => {
      fireEvent.pointerCancel(window);
    });
    groupSetLayoutCalls = [];

    groupLayout = { 'editor-main': 70, 'agents-column': 30 };
    view.rerender(<EditorArea {...baseProps} agentsVisible={false} />);
    await act(async () => {});
    expect(groupSetLayoutCalls.length).toBeGreaterThan(0);
  });

  test('a pointercancel restores the rail pins rather than committing a drag-to-close', async () => {
    setViewportWidth(1400);
    const visibleChanges: boolean[] = [];
    render(
      <EditorArea
        {...baseProps}
        agentsVisible
        onAgentsVisibleChange={(visible: boolean) => {
          visibleChanges.push(visible);
        }}
      />,
    );
    groupLayout = { 'editor-main': 70, 'agents-column': 30 };
    const handle = getAgentsHandle();
    act(() => {
      fireEvent.pointerDown(handle);
    });
    panelIsCollapsed = true;
    act(() => {
      fireEvent.pointerCancel(window);
    });
    expect(visibleChanges).toHaveLength(0);
    expect(groupSetLayoutCalls.at(-1)?.['agents-column']).toBeCloseTo(pctOf(480), 3);
  });

  test('a drag interrupted by unmount does not commit a drag-to-close afterwards', async () => {
    setViewportWidth(1400);
    const visibleChanges: boolean[] = [];
    const view = render(
      <EditorArea
        {...baseProps}
        agentsVisible
        onAgentsVisibleChange={(visible: boolean) => {
          visibleChanges.push(visible);
        }}
      />,
    );
    const handle = getAgentsHandle();
    act(() => {
      fireEvent.pointerDown(handle, { pointerId: 1 });
    });
    panelIsCollapsed = true;
    act(() => {
      view.unmount();
    });
    act(() => {
      fireEvent.pointerUp(window, { pointerId: 1 });
    });
    expect(visibleChanges).toHaveLength(0);
  });

  test('a different pointer cancelling does not end an in-flight drag', async () => {
    setViewportWidth(1400);
    const view = render(<EditorArea {...baseProps} agentsVisible />);
    const handle = getAgentsHandle();
    act(() => {
      fireEvent.pointerDown(handle, { pointerId: 1 });
    });
    groupSetLayoutCalls = [];
    groupLayout = { 'editor-main': 70, 'agents-column': 30 };

    act(() => {
      fireEvent.pointerCancel(window, { pointerId: 2 });
    });
    expect(groupSetLayoutCalls).toHaveLength(0);

    view.rerender(<EditorArea {...baseProps} agentsVisible={false} />);
    await act(async () => {});
    expect(groupSetLayoutCalls).toHaveLength(0);

    act(() => {
      fireEvent.pointerCancel(window, { pointerId: 1 });
    });
    expect(groupSetLayoutCalls.length).toBeGreaterThan(0);
  });
});

describe('EditorArea agents panel region', () => {
  beforeEach(() => {
    cleanup();
    docCtx = EMPTY_DOC_CTX;
  });

  test('the agents panel mounts in the panels region, not the header', () => {
    render(
      <EditorArea
        editorMode="wysiwyg"
        onModeChange={() => {}}
        activeTab="timeline"
        onActiveTabChange={() => {}}
        terminalBridge={{ terminal: {} } as never}
        onAgentsVisibleChange={() => {}}
        onTerminalVisibleChange={() => {}}
        agentsVisible
      />,
    );
    const header = document.querySelector('[data-editor-area-header]');
    const panels = document.querySelector('[data-editor-area-panels]');
    const agentMount = document.querySelector('[data-agents-panel-mount]');

    expect(header).toBeTruthy();
    expect(agentMount).toBeTruthy();
    expect(panels?.contains(agentMount)).toBe(true);
    expect(header?.contains(agentMount)).toBe(false);
  });
});

describe('EditorArea terminal placement', () => {
  beforeEach(() => {
    cleanup();
    docCtx = DOC_LIVE_CTX;
  });

  test('places a visible right terminal between the document and agents rails', () => {
    const placements: unknown[] = [];
    render(
      <EditorArea
        editorMode="wysiwyg"
        onModeChange={() => {}}
        activeTab="timeline"
        onActiveTabChange={() => {}}
        terminalBridge={{} as never}
        terminalVisible
        terminalPlacement="right"
        agentsVisible
        onTerminalVisibleChange={() => {}}
        onSessionPlacements={(value) => placements.push(value)}
      />,
    );

    const documentPanel = document.getElementById('doc-panel');
    const terminalPanel = document.getElementById('terminal-column');
    const agentsPanel = document.getElementById('agents-column');
    expect(terminalPanel).not.toBeNull();
    expect(
      documentPanel?.compareDocumentPosition(terminalPanel as Node) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      terminalPanel?.compareDocumentPosition(agentsPanel as Node) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(screen.getByTestId('terminal-dock').getAttribute('data-placement')).toBe('right');
    const latest = placements.at(-1) as {
      terminal?: { container?: Element; isShowing?: boolean };
    };
    expect(latest.terminal?.container).toBe(document.querySelector('[data-terminal-panel-mount]'));
    expect(latest.terminal?.isShowing).toBe(true);
  });
});

describe('EditorArea folder-view terminal host', () => {
  beforeEach(() => {
    cleanup();
    docCtx = FOLDER_DOC_CTX;
  });

  test('hosts the docked terminal in folder view when a terminal bridge is present', () => {
    render(
      <EditorArea
        editorMode="wysiwyg"
        onModeChange={() => {}}
        activeTab="timeline"
        onActiveTabChange={() => {}}
        terminalBridge={{} as never}
        terminalVisible
        onTerminalVisibleChange={() => {}}
      />,
    );

    const dock = screen.getByTestId('terminal-dock');
    expect(dock.getAttribute('data-visible')).toBe('true');
    expect(dock.querySelector('[data-testid="folder-overview"]')).not.toBeNull();
  });

  test('renders the folder view; the dock shell is present but inactive on the web host', () => {
    renderEditorArea();

    expect(screen.getByTestId('terminal-dock').getAttribute('data-visible')).toBe('false');
    expect(screen.getByTestId('folder-overview').textContent).toBe('folder');
  });
});

describe('EditorArea large-file-view terminal host', () => {
  beforeEach(() => {
    cleanup();
    docCtx = LARGE_FILE_DOC_CTX;
  });

  test('hosts the docked terminal in the large-file view when a bridge is present', () => {
    render(
      <EditorArea
        editorMode="wysiwyg"
        onModeChange={() => {}}
        activeTab="timeline"
        onActiveTabChange={() => {}}
        terminalBridge={{} as never}
        terminalVisible
        onTerminalVisibleChange={() => {}}
      />,
    );

    const dock = screen.getByTestId('terminal-dock');
    expect(dock.getAttribute('data-visible')).toBe('true');
    expect(dock.querySelector('[data-testid="large-file-state"]')).not.toBeNull();
  });

  test('renders the large-file view; the dock shell is present but inactive on the web host', () => {
    renderEditorArea();

    expect(screen.getByTestId('terminal-dock').getAttribute('data-visible')).toBe('false');
    expect(screen.getByTestId('large-file-state')).toBeTruthy();
  });
});

describe('EditorArea asset-view terminal host', () => {
  beforeEach(() => {
    cleanup();
    docCtx = ASSET_DOC_CTX;
  });

  test('hosts the docked terminal in the asset view when a bridge is present', () => {
    render(
      <EditorArea
        editorMode="wysiwyg"
        onModeChange={() => {}}
        activeTab="timeline"
        onActiveTabChange={() => {}}
        terminalBridge={{} as never}
        terminalVisible
        onTerminalVisibleChange={() => {}}
      />,
    );

    const dock = screen.getByTestId('terminal-dock');
    expect(dock.getAttribute('data-visible')).toBe('true');
    expect(dock.querySelector('[data-testid="asset-preview"]')).not.toBeNull();
  });

  test('renders the asset view; the dock shell is present but inactive on the web host', () => {
    renderEditorArea();

    expect(screen.getByTestId('terminal-dock').getAttribute('data-visible')).toBe('false');
    expect(screen.getByTestId('asset-preview')).toBeTruthy();
  });
});

describe('EditorArea terminal persists across view-kind switches', () => {
  beforeEach(() => {
    cleanup();
    terminalDockMounts = 0;
    docCtx = FOLDER_DOC_CTX;
  });

  test('keeps a single TerminalDock instance mounted while the active view kind changes', () => {
    const props = {
      editorMode: 'wysiwyg' as const,
      onModeChange: () => {},
      activeTab: 'timeline' as const,
      onActiveTabChange: () => {},
      terminalBridge: {} as never,
      terminalVisible: true,
      onTerminalVisibleChange: () => {},
    };
    const { rerender } = render(<EditorArea {...props} />);
    const mountsAfterInitial = terminalDockMounts;
    expect(mountsAfterInitial).toBeGreaterThan(0);
    expect(
      screen.getByTestId('terminal-dock').querySelector('[data-testid="folder-overview"]'),
    ).not.toBeNull();

    docCtx = ASSET_DOC_CTX;
    rerender(<EditorArea {...props} />);
    expect(
      screen.getByTestId('terminal-dock').querySelector('[data-testid="asset-preview"]'),
    ).not.toBeNull();

    docCtx = LARGE_FILE_DOC_CTX;
    rerender(<EditorArea {...props} />);
    expect(
      screen.getByTestId('terminal-dock').querySelector('[data-testid="large-file-state"]'),
    ).not.toBeNull();

    expect(terminalDockMounts).toBe(mountsAfterInitial);
  });
});

describe('EditorArea hash-load skeleton renders inside the editor card (cold start)', () => {
  beforeEach(() => {
    cleanup();
    docCtx = DOC_COLD_CTX;
  });
  afterEach(() => {
    window.location.hash = '';
  });

  test('renders the load skeleton in the document area, with the panel rows and the side panel slot in place', () => {
    window.location.hash = '#/some-doc';
    render(
      <EditorArea
        editorMode="wysiwyg"
        onModeChange={() => {}}
        activeTab="timeline"
        onActiveTabChange={() => {}}
        terminalBridge={{} as never}
        terminalVisible
        onTerminalVisibleChange={() => {}}
      />,
    );

    const skeleton = screen.getByTestId('editor-skeleton');
    expect(skeleton.closest('[data-editor-workspace-column]')).not.toBeNull();
    expect(skeleton.closest('[data-slot="pane-card"][data-pane="editor"]')).not.toBeNull();
    expect(screen.getByTestId('resizable-group')).toBeTruthy();
    expect(renderedInnerPanelIds()).toEqual(['doc-panel']);
    expect(document.getElementById('doc-panel')?.getAttribute('data-max-size')).toBe('600px');
  });

  test('keeps the file list drawn in the editor card while the skeleton shows', () => {
    window.location.hash = '#/some-doc';
    render(
      <FileListHostProvider enabled fileList={<nav data-testid="cold-load-file-list" />}>
        <EditorArea
          editorMode="wysiwyg"
          onModeChange={() => {}}
          activeTab="timeline"
          onActiveTabChange={() => {}}
        />
      </FileListHostProvider>,
    );

    expect(screen.getByTestId('editor-skeleton')).toBeTruthy();
    const card = document.querySelector('[data-slot="pane-card"][data-pane="editor"]');
    expect(card?.contains(screen.getByTestId('cold-load-file-list'))).toBe(true);
    expect(card?.contains(screen.getByTestId('editor-skeleton'))).toBe(true);
  });

  test('ignores a side panel toggle while the skeleton holds the slot, so no pin is written before the target is known', () => {
    localStorage.clear();
    window.location.hash = '#/some-folder';
    render(
      <EditorArea
        editorMode="wysiwyg"
        onModeChange={() => {}}
        activeTab="timeline"
        onActiveTabChange={() => {}}
      />,
    );
    expect(screen.getByTestId('editor-skeleton')).toBeTruthy();

    act(() => emitLocalMenuAction('toggle-doc-panel'));

    expect(localStorage.getItem('ok-sidebar-pins-v2')).toBeNull();
  });

  test('keeps the side panel slot the same panel when the document arrives, so its width restore is undisturbed', () => {
    window.location.hash = '#/docs/notes';
    const props = {
      editorMode: 'wysiwyg' as const,
      onModeChange: () => {},
      activeTab: 'timeline' as const,
      onActiveTabChange: () => {},
    };
    const { rerender } = render(<EditorArea {...props} />);
    const docPanel = document.getElementById('doc-panel');
    expect(docPanel?.getAttribute('data-max-size')).toBe('600px');

    act(() => {
      docCtx = DOC_LIVE_CTX;
    });
    rerender(<EditorArea {...props} />);

    expect(screen.queryByTestId('editor-skeleton')).toBeNull();
    expect(document.getElementById('doc-panel')).toBe(docPanel);
    expect(docPanel?.getAttribute('data-max-size')).toBe('600px');
    expect(renderedInnerPanelIds()).toEqual(['doc-panel']);
  });
});

describe('EditorArea document panel host ownership', () => {
  beforeEach(() => {
    cleanup();
    docCtx = DOC_LIVE_CTX;
  });

  test('releases the document panel host when the editor area unmounts', () => {
    const { unmount } = render(
      <EditorArea
        editorMode="wysiwyg"
        onModeChange={() => {}}
        activeTab="outline"
        onActiveTabChange={() => {}}
      />,
    );
    const panel = document.getElementById('doc-panel');
    const dock = panel?.firstElementChild;
    const host = dock?.firstElementChild;
    expect(panel).not.toBeNull();
    expect(host).not.toBeNull();
    expect(host?.parentElement).toBe(dock);

    unmount();

    expect(document.getElementById('doc-panel')).toBeNull();
    expect(host?.parentElement).toBeNull();
  });
});

describe('EditorArea terminal persists across a mid-session cold navigation', () => {
  beforeEach(() => {
    cleanup();
    terminalDockMounts = 0;
    window.location.hash = '';
    docCtx = FOLDER_LIVE_CTX;
  });
  afterEach(() => {
    window.location.hash = '';
  });

  test('keeps the dock mounted when a tab close/switch transiently nulls the provider', () => {
    const props = {
      editorMode: 'wysiwyg' as const,
      onModeChange: () => {},
      activeTab: 'timeline' as const,
      onActiveTabChange: () => {},
      terminalBridge: {} as never,
      terminalVisible: true,
      onTerminalVisibleChange: () => {},
    };
    const { rerender } = render(<EditorArea {...props} />);
    const mountsAfterInitial = terminalDockMounts;
    expect(mountsAfterInitial).toBeGreaterThan(0);
    expect(
      screen.getByTestId('terminal-dock').querySelector('[data-testid="folder-overview"]'),
    ).not.toBeNull();

    act(() => {
      docCtx = DOC_COLD_CTX;
      window.location.hash = '#/some-doc';
    });
    rerender(<EditorArea {...props} />);

    const dock = screen.getByTestId('terminal-dock');
    expect(dock.querySelector('[data-testid="editor-skeleton"]')).not.toBeNull();
    expect(terminalDockMounts).toBe(mountsAfterInitial);
    expect(screen.getByTestId('resizable-group')).toBeTruthy();
  });

  test('web host keeps chat on screen through a mid-session cold nav, with the skeleton in the document area', () => {
    const webProps = {
      editorMode: 'wysiwyg' as const,
      onModeChange: () => {},
      activeTab: 'timeline' as const,
      onActiveTabChange: () => {},
      agentsVisible: true,
      onAgentsVisibleChange: () => {},
    };
    const { rerender } = render(<EditorArea {...webProps} />);
    const agentsMount = document.querySelector('[data-agents-panel-mount]');
    expect(agentsMount).not.toBeNull();
    act(() => {
      docCtx = DOC_COLD_CTX;
      window.location.hash = '#/some-doc';
    });
    rerender(<EditorArea {...webProps} />);

    const skeleton = screen.getByTestId('editor-skeleton');
    expect(skeleton.closest('[data-editor-workspace-column]')).not.toBeNull();
    expect(screen.getByTestId('resizable-group')).toBeTruthy();
    expect(document.querySelector('[data-agents-panel-mount]')).toBe(agentsMount);
  });
});

describe('EditorArea doc-panel tab requests', () => {
  function TabHost({
    initialTab,
    onActiveTabChange,
  }: {
    initialTab: PanelTab;
    onActiveTabChange?: (tab: PanelTab) => void;
  }) {
    const [tab, setTab] = useState<PanelTab>(initialTab);
    return (
      <TooltipProvider>
        <EditorArea
          editorMode="wysiwyg"
          onModeChange={() => {}}
          activeTab={tab}
          onActiveTabChange={(nextTab) => {
            onActiveTabChange?.(nextTab);
            setTab(nextTab);
          }}
        />
      </TooltipProvider>
    );
  }

  function mountTabHost(initialTab: PanelTab, onActiveTabChange?: (tab: PanelTab) => void) {
    const resizeObserver = installResizeObserver();
    const view = render(<TabHost initialTab={initialTab} onActiveTabChange={onActiveTabChange} />);
    const card = document.querySelector<HTMLElement>('[data-slot="pane-card"][data-pane="editor"]');
    const inner = document.querySelector<HTMLElement>('[data-editor-inner-panels]');
    if (card == null || inner == null) throw new Error('the editor card or inner row is absent');
    for (const element of [card, inner]) {
      Object.defineProperty(element, 'getBoundingClientRect', {
        configurable: true,
        value: () => ({ width: rowPx('inner'), height: 0, top: 0, left: 0 }),
      });
    }
    resizeObserver.fire('[data-slot="pane-card"][data-pane="editor"]');
    resizeObserver.fire('[data-editor-inner-panels]');
    return { view, resizeObserver };
  }

  const infoWidthPx = () => document.getElementById('doc-panel')?.getBoundingClientRect().width;
  const docPanelToggle = () => {
    const toggle = document.querySelector<HTMLElement>('[data-doc-panel-toggle]');
    if (toggle == null) throw new Error('the document panel toggle is absent');
    return toggle;
  };

  beforeEach(() => {
    cleanup();
    localStorage.clear();
    localStorage.setItem(
      SIDEBAR_PINS_KEY,
      JSON.stringify({ right: { above: 'collapsed', below: 'collapsed', embedded: 'collapsed' } }),
    );
    docCtx = { ...DOC_LIVE_CTX, docPanelMode: 'doc' };
    groupLayout = { 'editor-main': 100 };
    innerLayout = { ...INNER_LAYOUT_DOC_CLOSED };
    groupSetLayoutCalls = [];
    mockGroupPx = 1360;
    Object.defineProperty(window, 'innerWidth', {
      value: 1400,
      configurable: true,
      writable: true,
    });
    panelIsCollapsed = true;
    deliverDocPanelResizeAfterLayout = true;
    closeActivityPanelCalls = 0;
  });

  test('a doc-scoped problems request opens the Problems tab and expands the collapsed rail', async () => {
    const { resizeObserver } = mountTabHost('timeline');
    try {
      expect(infoWidthPx()).toBe(0);
      expect(docPanelToggle().getAttribute('aria-expanded')).toBe('false');

      const storedPins = localStorage.getItem('ok-sidebar-pins-v2');
      act(() => requestDocPanelTab('problems', { scope: 'doc' }));
      await act(async () => {});

      expect(localStorage.getItem('ok-sidebar-pins-v2')).toBe(storedPins);

      expect(screen.getByRole('tabpanel').getAttribute('id')).toBe('panel-problems');
      expect(screen.getByTestId('panel-scope-doc').getAttribute('data-state')).toBe('on');
      expect(docPanelToggle().getAttribute('aria-expanded')).toBe('true');
      expect(infoWidthPx()).toBeCloseTo(320, 0);
      expect(innerResidualWidthPx()).toBeGreaterThanOrEqual(300);
    } finally {
      resizeObserver.restore();
    }
  });

  test('a panel already parked on Problems in project scope comes back in doc scope', async () => {
    const { resizeObserver } = mountTabHost('problems');
    try {
      act(() => requestDocPanelTab('problems', { scope: 'doc' }));
      await act(async () => {});
      fireEvent.click(screen.getByTestId('panel-scope-project'));
      expect(screen.getByTestId('problems-project-scope')).toBeTruthy();
      fireEvent.click(docPanelToggle());
      await act(async () => {});
      expect(infoWidthPx()).toBe(0);
      expect(docPanelToggle().getAttribute('aria-expanded')).toBe('false');

      act(() => requestDocPanelTab('problems', { scope: 'doc' }));
      await act(async () => {});

      expect(screen.getByRole('tabpanel').getAttribute('id')).toBe('panel-problems');
      expect(screen.getByTestId('panel-scope-doc').getAttribute('data-state')).toBe('on');
      expect(screen.queryByTestId('problems-project-scope')).toBeNull();
      expect(infoWidthPx()).toBeCloseTo(320, 0);
      expect(innerResidualWidthPx()).toBeGreaterThanOrEqual(300);
    } finally {
      resizeObserver.restore();
    }
  });

  test('a tab request takes the rail back from the agent drill-in', () => {
    docCtx = { ...DOC_LIVE_CTX, docPanelMode: 'agent', docPanelAgentId: 'agent-1' };
    const { resizeObserver } = mountTabHost('timeline');
    expect(screen.queryByRole('tabpanel')).toBeNull();

    act(() => requestDocPanelTab('problems', { scope: 'doc' }));

    expect(closeActivityPanelCalls).toBe(1);
    resizeObserver.restore();
  });

  test('re-rendering does not stack the subscription, and unmounting drops it', () => {
    const onActiveTabChange = vi.fn();
    const { view, resizeObserver } = mountTabHost('timeline', onActiveTabChange);
    try {
      for (let i = 0; i < 3; i += 1) {
        view.rerender(<TabHost initialTab="timeline" onActiveTabChange={onActiveTabChange} />);
      }

      act(() => requestDocPanelTab('problems', { scope: 'doc' }));
      expect(onActiveTabChange).toHaveBeenCalledTimes(1);
      expect(onActiveTabChange).toHaveBeenCalledWith('problems');
      expect(infoWidthPx()).toBeCloseTo(320, 0);

      view.unmount();
      act(() => requestDocPanelTab('problems', { scope: 'doc' }));
      expect(onActiveTabChange).toHaveBeenCalledTimes(1);
    } finally {
      resizeObserver.restore();
    }
  });
});

describe('EditorArea rail mount inert', () => {
  const railProps = {
    editorMode: 'wysiwyg',
    onModeChange: () => {},
    activeTab: 'timeline',
    onActiveTabChange: () => {},
    onAgentsVisibleChange: () => {},
  } as const;

  beforeEach(() => {
    cleanup();
    panelIsCollapsed = false;
    mockPanelPercentage = null;
    mockPanelPx = null;
    railPanelOnResizeById.clear();
  });

  const renderArea = (props: Record<string, unknown>) =>
    render(
      <TooltipProvider>
        <EditorArea {...railProps} {...props} />
      </TooltipProvider>,
    );

  test('both rail mounts are inert while their columns are absent', () => {
    const { container } = renderArea({});

    expect(
      container.querySelector('[data-agents-panel-mount]')?.getAttribute('inert'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-terminal-panel-mount]')?.getAttribute('inert'),
    ).not.toBeNull();
  });

  test('both rail mounts stay focusable while their columns are open', () => {
    const { container } = renderArea({
      agentsVisible: true,
      terminalBridge: { terminal: {} } as never,
      terminalVisible: true,
      terminalPlacement: 'right',
    });

    expect(container.querySelector('[data-agents-panel-mount]')?.getAttribute('inert')).toBeNull();
    expect(
      container.querySelector('[data-terminal-panel-mount]')?.getAttribute('inert'),
    ).toBeNull();
  });

  test('a drag-collapsed rail column stays focusable while the hold bridges the drag and goes inert once pointerup clears its presence', () => {
    const RailVisibilityHost = () => {
      const [agentsVisible, setAgentsVisible] = useState(true);
      const [terminalVisible, setTerminalVisible] = useState(true);
      return (
        <TooltipProvider>
          <EditorArea
            {...railProps}
            agentsVisible={agentsVisible}
            onAgentsVisibleChange={setAgentsVisible}
            terminalBridge={{ terminal: {} } as never}
            terminalVisible={terminalVisible}
            terminalPlacement="right"
            onTerminalVisibleChange={setTerminalVisible}
          />
        </TooltipProvider>
      );
    };
    const { container } = render(<RailVisibilityHost />);
    const agentsMount = () => container.querySelector('[data-agents-panel-mount]');
    const terminalMount = () => container.querySelector('[data-terminal-panel-mount]');
    const railHandle = (position: -1 | -2) => {
      const handle = screen.getAllByTestId('resizable-handle').at(position);
      if (handle == null) throw new Error('rail resize handle not found');
      return handle;
    };
    expect(agentsMount()?.getAttribute('inert')).toBeNull();
    expect(terminalMount()?.getAttribute('inert')).toBeNull();

    act(() => {
      fireEvent.pointerDown(railHandle(-1), { pointerId: 1 });
    });
    act(() => {
      railPanelOnResizeById.get(AGENTS_COLUMN_ID)?.({ asPercentage: 0, inPixels: 0 });
    });
    expect(agentsMount()?.getAttribute('inert')).toBeNull();

    panelIsCollapsed = true;
    mockPanelPercentage = 0;
    mockPanelPx = 0;
    act(() => {
      fireEvent.pointerUp(window, { pointerId: 1 });
    });
    expect(agentsMount()?.getAttribute('inert')).not.toBeNull();

    act(() => {
      fireEvent.pointerDown(railHandle(-2), { pointerId: 2 });
    });
    act(() => {
      railPanelOnResizeById.get(TERMINAL_COLUMN_ID)?.({ asPercentage: 0, inPixels: 0 });
    });
    expect(terminalMount()?.getAttribute('inert')).toBeNull();

    act(() => {
      fireEvent.pointerUp(window, { pointerId: 2 });
    });
    expect(terminalMount()?.getAttribute('inert')).not.toBeNull();
    expect(agentsMount()?.getAttribute('inert')).not.toBeNull();
  });

  test('a present-but-measured-collapsed rail reports isShowing false so reveal focus waits for expansion', () => {
    const placements: Array<{
      agents?: { isShowing?: boolean };
      terminal?: { isShowing?: boolean };
    }> = [];
    const { container } = renderArea({
      agentsVisible: true,
      terminalBridge: { terminal: {} } as never,
      terminalVisible: true,
      terminalPlacement: 'right',
      onSessionPlacements: (placement: unknown) =>
        placements.push(
          placement as {
            agents?: { isShowing?: boolean };
            terminal?: { isShowing?: boolean };
          },
        ),
    });
    expect(placements.at(-1)?.agents?.isShowing).toBe(true);
    expect(placements.at(-1)?.terminal?.isShowing).toBe(true);

    act(() => {
      railPanelOnResizeById.get(AGENTS_COLUMN_ID)?.({ asPercentage: 0, inPixels: 0 });
    });
    expect(
      container.querySelector('[data-agents-panel-mount]')?.getAttribute('inert'),
    ).not.toBeNull();
    expect(placements.at(-1)?.agents?.isShowing).toBe(false);

    act(() => {
      railPanelOnResizeById.get(TERMINAL_COLUMN_ID)?.({ asPercentage: 0, inPixels: 0 });
    });
    expect(
      container.querySelector('[data-terminal-panel-mount]')?.getAttribute('inert'),
    ).not.toBeNull();
    expect(placements.at(-1)?.terminal?.isShowing).toBe(false);

    act(() => {
      railPanelOnResizeById.get(AGENTS_COLUMN_ID)?.({ asPercentage: 25, inPixels: 300 });
    });
    expect(container.querySelector('[data-agents-panel-mount]')?.getAttribute('inert')).toBeNull();
    expect(placements.at(-1)?.agents?.isShowing).toBe(true);

    act(() => {
      railPanelOnResizeById.get(TERMINAL_COLUMN_ID)?.({ asPercentage: 25, inPixels: 300 });
    });
    expect(
      container.querySelector('[data-terminal-panel-mount]')?.getAttribute('inert'),
    ).toBeNull();
    expect(placements.at(-1)?.terminal?.isShowing).toBe(true);
  });

  test('a drag that dips a rail to zero and back — repeatedly — never flips its showing signal', () => {
    const placements: Array<{
      agents?: { isShowing?: boolean };
      terminal?: { isShowing?: boolean };
    }> = [];
    const { container } = renderArea({
      agentsVisible: true,
      terminalBridge: { terminal: {} } as never,
      terminalVisible: true,
      terminalPlacement: 'right',
      onSessionPlacements: (placement: unknown) =>
        placements.push(
          placement as {
            agents?: { isShowing?: boolean };
            terminal?: { isShowing?: boolean };
          },
        ),
    });
    expect(placements.at(-1)?.agents?.isShowing).toBe(true);
    expect(placements.at(-1)?.terminal?.isShowing).toBe(true);

    const railHandle = (position: -1 | -2) => {
      const handle = screen.getAllByTestId('resizable-handle').at(position);
      if (handle == null) throw new Error('rail resize handle not found');
      return handle;
    };
    const dip = (columnId: string) => {
      act(() => {
        railPanelOnResizeById.get(columnId)?.({ asPercentage: 0, inPixels: 0 });
      });
    };
    const recover = (columnId: string) => {
      act(() => {
        railPanelOnResizeById.get(columnId)?.({ asPercentage: 25, inPixels: 300 });
      });
    };

    const agentsDragStart = placements.length;
    act(() => {
      fireEvent.pointerDown(railHandle(-1), { pointerId: 1 });
    });
    for (let i = 0; i < 2; i += 1) {
      dip(AGENTS_COLUMN_ID);
      expect(
        container.querySelector('[data-agents-panel-mount]')?.getAttribute('inert'),
      ).toBeNull();
      expect(placements.at(-1)?.agents?.isShowing).toBe(true);
      recover(AGENTS_COLUMN_ID);
      expect(
        container.querySelector('[data-agents-panel-mount]')?.getAttribute('inert'),
      ).toBeNull();
      expect(placements.at(-1)?.agents?.isShowing).toBe(true);
    }
    act(() => {
      fireEvent.pointerUp(window, { pointerId: 1 });
    });
    expect(placements.at(-1)?.agents?.isShowing).toBe(true);
    expect(
      placements.slice(agentsDragStart).some((placement) => placement.agents?.isShowing === false),
    ).toBe(false);

    const terminalDragStart = placements.length;
    act(() => {
      fireEvent.pointerDown(railHandle(-2), { pointerId: 2 });
    });
    for (let i = 0; i < 2; i += 1) {
      dip(TERMINAL_COLUMN_ID);
      expect(
        container.querySelector('[data-terminal-panel-mount]')?.getAttribute('inert'),
      ).toBeNull();
      expect(placements.at(-1)?.terminal?.isShowing).toBe(true);
      recover(TERMINAL_COLUMN_ID);
      expect(
        container.querySelector('[data-terminal-panel-mount]')?.getAttribute('inert'),
      ).toBeNull();
      expect(placements.at(-1)?.terminal?.isShowing).toBe(true);
    }
    act(() => {
      fireEvent.pointerUp(window, { pointerId: 2 });
    });
    expect(placements.at(-1)?.terminal?.isShowing).toBe(true);
    expect(
      placements
        .slice(terminalDragStart)
        .some((placement) => placement.terminal?.isShowing === false),
    ).toBe(false);

    act(() => {
      railPanelOnResizeById.get(AGENTS_COLUMN_ID)?.({ asPercentage: 0, inPixels: 0 });
    });
    expect(placements.at(-1)?.agents?.isShowing).toBe(false);
    act(() => {
      railPanelOnResizeById.get(TERMINAL_COLUMN_ID)?.({ asPercentage: 0, inPixels: 0 });
    });
    expect(placements.at(-1)?.terminal?.isShowing).toBe(false);
  });

  test('a pointercancel at measured collapse holds the showing signal until the drag-free expansion lands', () => {
    const placements: Array<{
      agents?: { isShowing?: boolean };
      terminal?: { isShowing?: boolean };
    }> = [];
    const { container } = renderArea({
      agentsVisible: true,
      terminalBridge: { terminal: {} } as never,
      terminalVisible: true,
      terminalPlacement: 'right',
      onSessionPlacements: (placement: unknown) =>
        placements.push(
          placement as {
            agents?: { isShowing?: boolean };
            terminal?: { isShowing?: boolean };
          },
        ),
    });

    const railHandle = (position: -1 | -2) => {
      const handle = screen.getAllByTestId('resizable-handle').at(position);
      if (handle == null) throw new Error('rail resize handle not found');
      return handle;
    };

    const agentsDragStart = placements.length;
    act(() => {
      fireEvent.pointerDown(railHandle(-1), { pointerId: 1 });
    });
    act(() => {
      railPanelOnResizeById.get(AGENTS_COLUMN_ID)?.({ asPercentage: 0, inPixels: 0 });
    });
    panelIsCollapsed = true;
    act(() => {
      fireEvent.pointerCancel(window, { pointerId: 1 });
    });
    expect(container.querySelector('[data-agents-panel-mount]')?.getAttribute('inert')).toBeNull();
    expect(placements.at(-1)?.agents?.isShowing).toBe(true);
    expect(
      placements.slice(agentsDragStart).some((placement) => placement.agents?.isShowing === false),
    ).toBe(false);

    panelIsCollapsed = false;
    act(() => {
      railPanelOnResizeById.get(AGENTS_COLUMN_ID)?.({ asPercentage: 25, inPixels: 300 });
    });
    expect(container.querySelector('[data-agents-panel-mount]')?.getAttribute('inert')).toBeNull();
    expect(placements.at(-1)?.agents?.isShowing).toBe(true);
    act(() => {
      railPanelOnResizeById.get(AGENTS_COLUMN_ID)?.({ asPercentage: 0, inPixels: 0 });
    });
    expect(placements.at(-1)?.agents?.isShowing).toBe(false);

    const terminalDragStart = placements.length;
    act(() => {
      fireEvent.pointerDown(railHandle(-2), { pointerId: 2 });
    });
    act(() => {
      railPanelOnResizeById.get(TERMINAL_COLUMN_ID)?.({ asPercentage: 0, inPixels: 0 });
    });
    panelIsCollapsed = true;
    act(() => {
      fireEvent.pointerCancel(window, { pointerId: 2 });
    });
    expect(
      container.querySelector('[data-terminal-panel-mount]')?.getAttribute('inert'),
    ).toBeNull();
    expect(placements.at(-1)?.terminal?.isShowing).toBe(true);
    expect(
      placements
        .slice(terminalDragStart)
        .some((placement) => placement.terminal?.isShowing === false),
    ).toBe(false);

    panelIsCollapsed = false;
    act(() => {
      railPanelOnResizeById.get(TERMINAL_COLUMN_ID)?.({ asPercentage: 25, inPixels: 300 });
    });
    expect(
      container.querySelector('[data-terminal-panel-mount]')?.getAttribute('inert'),
    ).toBeNull();
    expect(placements.at(-1)?.terminal?.isShowing).toBe(true);
    act(() => {
      railPanelOnResizeById.get(TERMINAL_COLUMN_ID)?.({ asPercentage: 0, inPixels: 0 });
    });
    expect(placements.at(-1)?.terminal?.isShowing).toBe(false);
  });
});

type Observation = {
  callback: ResizeObserverCallback;
  observer: ResizeObserver;
  target: Element;
};
const installResizeObserver = () => {
  const original = globalThis.ResizeObserver;
  const observations = new Set<Observation>();
  class TestResizeObserver implements ResizeObserver {
    readonly callback: ResizeObserverCallback;
    constructor(callback: ResizeObserverCallback) {
      this.callback = callback;
    }
    observe(target: Element) {
      observations.add({ callback: this.callback, observer: this, target });
    }
    unobserve(target: Element) {
      for (const observation of observations) {
        if (observation.observer === this && observation.target === target) {
          observations.delete(observation);
        }
      }
    }
    disconnect() {
      for (const observation of observations) {
        if (observation.observer === this) observations.delete(observation);
      }
    }
  }
  Object.defineProperty(globalThis, 'ResizeObserver', {
    value: TestResizeObserver,
    configurable: true,
    writable: true,
  });
  return {
    fire: (selector: string) => {
      const target = document.querySelector(selector);
      const matching = [...observations].filter((entry) => entry.target === target);
      if (matching.length === 0) throw new Error(`${selector} is not observed`);
      act(() => {
        for (const observation of matching) observation.callback([], observation.observer);
      });
    },
    restore: () => {
      Object.defineProperty(globalThis, 'ResizeObserver', {
        value: original,
        configurable: true,
        writable: true,
      });
    },
  };
};

describe('EditorArea editor card rows', () => {
  const rowProps = {
    editorMode: 'wysiwyg',
    onModeChange: () => {},
    activeTab: 'timeline',
    onActiveTabChange: () => {},
    terminalBridge: {} as never,
    onAgentsVisibleChange: () => {},
    onTerminalVisibleChange: () => {},
  } as const;
  const FILE_LIST_PX = 288;
  const SHELL_CHROME_PX = 8;
  const setViewportWidth = (px: number) => {
    Object.defineProperty(window, 'innerWidth', { value: px, configurable: true, writable: true });
  };
  const pctOfRow = (px: number, rowPx: number) => (px / rowPx) * 100;
  const docHandle = () => {
    const handle = document.getElementById('doc-panel')?.previousElementSibling;
    if (!(handle instanceof HTMLElement)) throw new Error('doc-panel resize handle not found');
    return handle;
  };
  const agentsHandle = () => {
    const handle = screen.getAllByTestId('resizable-handle').at(-1);
    if (handle == null) throw new Error('agents resize handle not found');
    return handle;
  };
  const terminalHandle = () => {
    const handle = document.querySelector<HTMLElement>('[data-terminal-panel-handle]');
    if (handle == null) throw new Error('terminal resize handle not found');
    return handle;
  };
  const flushFrame = () => act(async () => {});
  const measureEditorCardForRow = (resizeObserver: ReturnType<typeof installResizeObserver>) => {
    const card = document.querySelector<HTMLElement>('[data-slot="pane-card"][data-pane="editor"]');
    if (card == null) throw new Error('the editor card is absent');
    Object.defineProperty(card, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({ width: rowPx('inner'), height: 0, top: 0, left: 0 }),
    });
    resizeObserver.fire('[data-slot="pane-card"][data-pane="editor"]');
  };

  beforeEach(() => {
    cleanup();
    localStorage.clear();
    docCtx = EMPTY_DOC_CTX;
    groupLayout = {};
    groupSetLayoutCalls = [];
    rejectNextGroupLayoutWrite = false;
    rejectGroupLayoutWrites = false;
    panelIsCollapsed = false;
    mockGroupPx = 1360;
    mockPanelPercentage = null;
    mockPanelPx = null;
    toastInfoMessages = [];
  });

  test('a project window puts the tab row, the workspace and the side panel inside one editor card row', () => {
    setViewportWidth(1400);
    docCtx = DOC_LIVE_CTX;
    render(<EditorArea {...rowProps} agentsVisible terminalVisible terminalPlacement="right" />);

    const card = document.querySelector('[data-slot="pane-card"][data-pane="editor"]');
    const outer = screen.getByTestId('resizable-group');
    const inner = screen.getByTestId('resizable-group-inner');
    const header = document.querySelector('[data-editor-area-header]');
    const column = document.querySelector('[data-editor-workspace-column]');
    const docPanel = document.getElementById('doc-panel');
    const terminalPanel = document.getElementById('terminal-column');
    const agentsPanel = document.getElementById('agents-column');
    if (card == null || header == null || column == null || docPanel == null) {
      throw new Error('editor card structure is incomplete');
    }

    expect(card.getAttribute('data-variant')).toBe('card');
    expect(card.closest('[data-panel]')).toBe(outer.firstElementChild);
    expect(outer.querySelector(':scope > [data-slot="pane-card"]')).toBeNull();
    expect(card.contains(inner)).toBe(true);
    expect(inner.contains(docPanel)).toBe(true);
    expect(inner.contains(column)).toBe(true);
    expect(column.firstElementChild).toBe(header);
    expect(header.contains(screen.getByTestId('workspace-tabs'))).toBe(true);
    expect(docPanel.contains(header)).toBe(false);
    expect(card.contains(terminalPanel)).toBe(false);
    expect(card.contains(agentsPanel)).toBe(false);
    expect(
      docPanel.compareDocumentPosition(terminalPanel as Node) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(document.querySelector('[data-editor-inner-panels]')?.firstElementChild).toBe(inner);
  });

  test('a note window keeps the tab row target above the row and renders the flat card', () => {
    Object.defineProperty(window, 'okDesktop', {
      configurable: true,
      value: {
        config: { mode: 'note' },
        editor: { notifyViewMenuStateChanged: () => {} },
      },
    });
    try {
      render(<EditorArea {...rowProps} />);
      const panels = document.querySelector('[data-editor-area-panels]');
      const header = document.querySelector('[data-editor-area-header]');
      const card = document.querySelector('[data-slot="pane-card"][data-pane="editor"]');
      expect(header?.nextElementSibling).toBe(panels);
      expect(panels?.contains(header)).toBe(false);
      expect(card?.getAttribute('data-variant')).toBe('flat');
      expect(screen.getByTestId('resizable-group-inner').contains(card)).toBe(false);
      expect(card?.contains(screen.getByTestId('resizable-group-inner'))).toBe(true);
    } finally {
      Reflect.deleteProperty(window, 'okDesktop');
    }
  });

  test('a single-file window renders the normal editor card', () => {
    Object.defineProperty(window, 'okDesktop', {
      configurable: true,
      value: {
        config: { singleFile: true },
        editor: { notifyViewMenuStateChanged: () => {} },
      },
    });
    try {
      render(
        <SingleFileModeProvider>
          <EditorArea {...rowProps} />
        </SingleFileModeProvider>,
      );
      const card = document.querySelector('[data-slot="pane-card"][data-pane="editor"]');
      expect(card?.getAttribute('data-variant')).toBe('card');
    } finally {
      Reflect.deleteProperty(window, 'okDesktop');
    }
  });

  test('while the chat divider is dragged the inner row follows the outer move in the same write and keeps the side panel width', async () => {
    setViewportWidth(1400);
    docCtx = DOC_LIVE_CTX;
    groupLayout = {
      'editor-main': 100 - pctOfRow(480, 1360),
      'agents-column': pctOfRow(480, 1360),
    };
    innerLayout = innerRowWithDoc(320, 1360 - 480);
    render(<EditorArea {...rowProps} agentsVisible />);
    await act(async () => {});
    groupSetLayoutCalls = [];
    innerSetLayoutCalls = [];

    act(() => {
      fireEvent.pointerDown(agentsHandle(), { pointerId: 1 });
      agentsHandle().setAttribute('data-separator', 'active');
    });
    groupLayout = {
      'editor-main': 100 - pctOfRow(600, 1360),
      'agents-column': pctOfRow(600, 1360),
    };
    act(() => {
      groupOnLayoutChange?.(groupLayout);
    });

    expect(groupSetLayoutCalls).toHaveLength(0);
    expect(lastInnerWritePx('doc-panel')).toBeCloseTo(320, 3);
    expect(document.getElementById('doc-panel')?.getBoundingClientRect().width).toBeCloseTo(320, 3);
    expect(innerResidualWidthPx()).toBeCloseTo(1360 - 600 - 320, 3);

    act(() => {
      groupOnLayoutChanged?.(groupLayout, { isUserInteraction: true });
      fireEvent.pointerUp(window, { pointerId: 1 });
    });
    expect(document.getElementById('doc-panel')?.getBoundingClientRect().width).toBeCloseTo(320, 3);
  });

  test('a collapsed side panel stays collapsed while the outer row is dragged', async () => {
    setViewportWidth(1024);
    docCtx = DOC_LIVE_CTX;
    groupLayout = {
      'editor-main': 100 - pctOfRow(480, 1360),
      'agents-column': pctOfRow(480, 1360),
    };
    render(<EditorArea {...rowProps} agentsVisible />);
    await act(async () => {});
    innerSetLayoutCalls = [];

    act(() => {
      fireEvent.pointerDown(agentsHandle(), { pointerId: 1 });
      agentsHandle().setAttribute('data-separator', 'active');
    });
    groupLayout = {
      'editor-main': 100 - pctOfRow(600, 1360),
      'agents-column': pctOfRow(600, 1360),
    };
    act(() => {
      groupOnLayoutChange?.(groupLayout);
    });
    act(() => {
      groupOnLayoutChanged?.(groupLayout, { isUserInteraction: true });
      fireEvent.pointerUp(window, { pointerId: 1 });
    });

    for (const write of innerSetLayoutCalls) expect(write['doc-panel']).toBe(0);
    expect(document.getElementById('doc-panel')?.getBoundingClientRect().width).toBe(0);
  });

  test('each row marks only its own drag', () => {
    setViewportWidth(1400);
    docCtx = DOC_LIVE_CTX;
    render(<EditorArea {...rowProps} agentsVisible />);
    const outer = screen.getByTestId('resizable-group');
    const inner = screen.getByTestId('resizable-group-inner');

    act(() => {
      fireEvent.pointerDown(docHandle(), { pointerId: 1 });
    });
    expect(inner.getAttribute('data-dragging')).toBe('true');
    expect(outer.hasAttribute('data-dragging')).toBe(false);
    act(() => {
      fireEvent.pointerUp(window, { pointerId: 1 });
    });
    expect(inner.hasAttribute('data-dragging')).toBe(false);

    act(() => {
      fireEvent.pointerDown(agentsHandle(), { pointerId: 2 });
    });
    expect(outer.getAttribute('data-dragging')).toBe('true');
    expect(inner.hasAttribute('data-dragging')).toBe(false);
    act(() => {
      fireEvent.pointerUp(window, { pointerId: 2 });
    });
    expect(outer.hasAttribute('data-dragging')).toBe(false);
  });

  test('at a 1400px window with the file list open every column drops to its floor and the document keeps 159px', async () => {
    const rowPx = 1400 - FILE_LIST_PX - SHELL_CHROME_PX;
    setViewportWidth(1400);
    mockGroupPx = rowPx;
    docCtx = DOC_LIVE_CTX;
    const view = render(
      <EditorArea
        {...rowProps}
        agentsVisible={false}
        terminalVisible={false}
        terminalPlacement="right"
      />,
    );
    groupLayout = { 'editor-main': 40, 'terminal-column': 40, 'agents-column': 20 };
    innerLayout = { 'workspace-main': 50, 'doc-panel': 50 };
    groupSetLayoutCalls = [];
    innerSetLayoutCalls = [];

    view.rerender(
      <EditorArea {...rowProps} agentsVisible terminalVisible terminalPlacement="right" />,
    );
    await act(async () => {});

    const outer = groupSetLayoutCalls.at(-1);
    expect(outer).toBeDefined();
    expect(((outer?.['terminal-column'] ?? 0) / 100) * rowPx).toBeCloseTo(
      RIGHT_TERMINAL_PANEL_MIN_WIDTH_PX,
      3,
    );
    expect(((outer?.['agents-column'] ?? 0) / 100) * rowPx).toBeCloseTo(MIN_AGENTS_PANEL_WIDTH, 3);
    expect(lastInnerWritePx('doc-panel')).toBeCloseTo(300, 3);
    const innerWrite = innerSetLayoutCalls.at(-1);
    const innerWritePx = innerSetLayoutPx.at(-1) ?? 0;
    expect(innerWritePx - ((innerWrite?.['doc-panel'] ?? 0) / 100) * innerWritePx).toBeCloseTo(
      rowPx - RIGHT_TERMINAL_PANEL_MIN_WIDTH_PX - MIN_AGENTS_PANEL_WIDTH - 300,
      3,
    );
    expect(innerWritePx - ((innerWrite?.['doc-panel'] ?? 0) / 100) * innerWritePx).toBeCloseTo(
      159,
      3,
    );
  });

  test('at a 1300px window with a document open, chat and the right terminal cannot both stay', async () => {
    const rowPx = 1300 - FILE_LIST_PX - SHELL_CHROME_PX;
    setViewportWidth(1300);
    mockGroupPx = rowPx;
    mockPanelPx = 320;
    mockPanelPercentage = pctOfRow(320, rowPx);
    docCtx = DOC_LIVE_CTX;
    const terminalChanges: boolean[] = [];
    const view = render(
      <EditorArea
        {...rowProps}
        agentsVisible={false}
        terminalVisible
        terminalPlacement="right"
        onTerminalVisibleChange={(visible: boolean) => {
          terminalChanges.push(visible);
        }}
      />,
    );
    groupLayout = {
      'editor-main': 100 - pctOfRow(740, rowPx),
      'terminal-column': pctOfRow(740, rowPx),
      'agents-column': 0,
    };
    innerLayout = innerRowWithDoc(320, rowPx - 740);

    view.rerender(
      <EditorArea
        {...rowProps}
        agentsVisible
        terminalVisible
        terminalPlacement="right"
        onTerminalVisibleChange={(visible: boolean) => {
          terminalChanges.push(visible);
        }}
      />,
    );
    await act(async () => {});

    expect(terminalChanges).toEqual([false]);
    expect(toastInfoMessages).toEqual(['Terminal closed to make room for the agent panel.']);
  });

  function FileListShell({ children }: { children: ReactNode }) {
    return (
      <FileListHostProvider enabled fileList={<nav data-testid="card-file-list" />}>
        {children}
      </FileListHostProvider>
    );
  }
  const measureFileListSlot = () => {
    const slot = document.querySelector<HTMLElement>('[data-editor-file-list-slot]');
    if (slot == null) throw new Error('the editor card has no file list slot');
    Object.defineProperty(slot, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({
        width: mockFileListPx,
        height: 0,
        top: 0,
        left: 0,
        right: mockFileListPx,
        bottom: 0,
        x: 0,
        y: 0,
      }),
    });
    return slot;
  };

  test('draws the file list in the editor card slot, ahead of the content column', () => {
    docCtx = DOC_LIVE_CTX;
    render(
      <FileListShell>
        <EditorArea {...rowProps} agentsVisible={false} terminalVisible={false} />
      </FileListShell>,
    );

    const card = document.querySelector('[data-slot="pane-card"][data-pane="editor"]');
    const slot = measureFileListSlot();
    const content = card?.querySelector('[data-slot="sidebar-inset"]');
    expect(slot.parentElement).toBe(card);
    expect(slot.contains(screen.getByTestId('card-file-list'))).toBe(true);
    expect(content?.parentElement).toBe(card);
    expect(
      slot.compareDocumentPosition(content as Element) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(content?.contains(screen.getByTestId('resizable-group-inner'))).toBe(true);
  });

  test('with the file list inside the card, a 1400px window still floors every column and leaves the document 159px', async () => {
    const outerPx = 1400 - SHELL_CHROME_PX;
    const rowPx = outerPx - FILE_LIST_PX;
    setViewportWidth(1400);
    mockGroupPx = outerPx;
    mockFileListPx = FILE_LIST_PX;
    docCtx = DOC_LIVE_CTX;
    const view = render(
      <FileListShell>
        <EditorArea
          {...rowProps}
          agentsVisible={false}
          terminalVisible={false}
          terminalPlacement="right"
        />
      </FileListShell>,
    );
    measureFileListSlot();
    groupLayout = { 'editor-main': 40, 'terminal-column': 40, 'agents-column': 20 };
    innerLayout = { 'workspace-main': 50, 'doc-panel': 50 };
    groupSetLayoutCalls = [];
    innerSetLayoutCalls = [];

    view.rerender(
      <FileListShell>
        <EditorArea {...rowProps} agentsVisible terminalVisible terminalPlacement="right" />
      </FileListShell>,
    );
    await act(async () => {});
    await act(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );

    const outer = groupSetLayoutCalls.at(-1);
    expect(outer).toBeDefined();
    expect(((outer?.['terminal-column'] ?? 0) / 100) * outerPx).toBeCloseTo(
      RIGHT_TERMINAL_PANEL_MIN_WIDTH_PX,
      3,
    );
    expect(((outer?.['agents-column'] ?? 0) / 100) * outerPx).toBeCloseTo(
      MIN_AGENTS_PANEL_WIDTH,
      3,
    );
    expect(lastInnerWritePx('doc-panel')).toBeCloseTo(300, 3);
    const innerWrite = innerSetLayoutCalls.at(-1);
    const innerWritePx = innerSetLayoutPx.at(-1) ?? 0;
    expect(innerWritePx - ((innerWrite?.['doc-panel'] ?? 0) / 100) * innerWritePx).toBeCloseTo(
      rowPx - RIGHT_TERMINAL_PANEL_MIN_WIDTH_PX - MIN_AGENTS_PANEL_WIDTH - 300,
      3,
    );
    expect(innerWritePx - ((innerWrite?.['doc-panel'] ?? 0) / 100) * innerWritePx).toBeCloseTo(
      159,
      3,
    );
  });

  test('with the file list inside the card, a 1300px window still closes the right terminal for chat', async () => {
    const outerPx = 1300 - SHELL_CHROME_PX;
    const rowPx = outerPx - FILE_LIST_PX;
    setViewportWidth(1300);
    mockGroupPx = outerPx;
    mockFileListPx = FILE_LIST_PX;
    mockPanelPx = 320;
    mockPanelPercentage = pctOfRow(320, rowPx);
    docCtx = DOC_LIVE_CTX;
    const terminalChanges: boolean[] = [];
    const renderRow = (agentsVisible: boolean) => (
      <FileListShell>
        <EditorArea
          {...rowProps}
          agentsVisible={agentsVisible}
          terminalVisible
          terminalPlacement="right"
          onTerminalVisibleChange={(visible: boolean) => {
            terminalChanges.push(visible);
          }}
        />
      </FileListShell>
    );
    const view = render(renderRow(false));
    measureFileListSlot();
    groupLayout = {
      'editor-main': 100 - pctOfRow(740, outerPx),
      'terminal-column': pctOfRow(740, outerPx),
      'agents-column': 0,
    };
    innerLayout = innerRowWithDoc(320, rowPx - 740);

    view.rerender(renderRow(true));
    await act(async () => {});

    expect(terminalChanges).toEqual([false]);
    expect(toastInfoMessages).toEqual(['Terminal closed to make room for the agent panel.']);
  });

  test('a terminal close decided while Files is still collapsing applies once the file list has no width', async () => {
    const resizeObserver = installResizeObserver();
    try {
      const outerPx = 900 - SHELL_CHROME_PX;
      setViewportWidth(900);
      mockGroupPx = outerPx;
      mockFileListPx = FILE_LIST_PX;
      docCtx = DOC_LIVE_CTX;
      const terminalChanges: boolean[] = [];
      const renderRow = (agentsVisible: boolean) => (
        <FileListShell>
          <EditorArea
            {...rowProps}
            agentsVisible={agentsVisible}
            terminalVisible
            terminalPlacement="right"
            onTerminalVisibleChange={(visible: boolean) => {
              terminalChanges.push(visible);
            }}
          />
        </FileListShell>
      );
      const view = render(renderRow(false));
      measureFileListSlot();
      groupLayout = {
        'editor-main': 100 - pctOfRow(740, outerPx),
        'terminal-column': pctOfRow(740, outerPx),
        'agents-column': 0,
      };

      view.rerender(renderRow(true));
      await act(async () => {});
      expect(document.querySelector('[data-editor-file-list-slot]')).not.toBeNull();
      expect(toastInfoMessages).toEqual([]);

      mockFileListPx = 0;
      resizeObserver.fire('[data-editor-file-list-slot]');

      expect(terminalChanges).toEqual([false]);
      expect(toastInfoMessages).toEqual(['Terminal closed to make room for the agent panel.']);
    } finally {
      resizeObserver.restore();
    }
  });

  test('a transient over-wide side panel reading while chat opens does not close the right terminal at 1900px', async () => {
    const outerPx = 1900 - SHELL_CHROME_PX;
    const rowPx = outerPx - FILE_LIST_PX;
    setViewportWidth(1900);
    mockGroupPx = outerPx;
    mockFileListPx = FILE_LIST_PX;
    mockPanelPx = 1122;
    mockPanelPercentage = pctOfRow(1122, rowPx);
    docCtx = DOC_LIVE_CTX;
    const terminalChanges: boolean[] = [];
    const renderRow = (agentsVisible: boolean) => (
      <FileListShell>
        <EditorArea
          {...rowProps}
          agentsVisible={agentsVisible}
          terminalVisible
          terminalPlacement="right"
          onTerminalVisibleChange={(visible: boolean) => {
            terminalChanges.push(visible);
          }}
        />
      </FileListShell>
    );
    const view = render(renderRow(false));
    measureFileListSlot();
    groupLayout = {
      'editor-main': 100 - pctOfRow(740, outerPx),
      'terminal-column': pctOfRow(740, outerPx),
      'agents-column': 0,
    };
    innerLayout = innerRowWithDoc(320, rowPx - 740);

    view.rerender(renderRow(true));
    await act(async () => {});

    expect(terminalChanges).toEqual([]);
    expect(toastInfoMessages).toEqual([]);
  });

  test('opening the file list inside the card re-plans the side panel, right terminal and chat against the narrower row', async () => {
    const resizeObserver = installResizeObserver();
    try {
      const outerPx = 1400 - SHELL_CHROME_PX;
      setViewportWidth(1400);
      mockGroupPx = outerPx;
      mockFileListPx = 0;
      docCtx = DOC_LIVE_CTX;
      const renderRow = () => (
        <FileListShell>
          <EditorArea
            {...rowProps}
            agentsVisible
            terminalVisible
            terminalPlacement="right"
            terminalRightWidth={480}
          />
        </FileListShell>
      );
      render(renderRow());
      measureFileListSlot();
      await flushFrame();
      groupLayout = { 'editor-main': 40, 'terminal-column': 40, 'agents-column': 20 };
      innerLayout = { 'workspace-main': 50, 'doc-panel': 50 };
      groupSetLayoutCalls = [];
      innerSetLayoutCalls = [];
      resizeObserver.fire('[data-editor-inner-panels]');
      const preferredOuter = groupSetLayoutCalls.at(-1) ?? groupLayout;
      expect(((preferredOuter['terminal-column'] ?? 0) / 100) * outerPx).toBeCloseTo(480, 3);
      expect(((preferredOuter['agents-column'] ?? 0) / 100) * outerPx).toBeCloseTo(480, 3);

      mockFileListPx = FILE_LIST_PX;
      groupSetLayoutCalls = [];
      innerSetLayoutCalls = [];
      resizeObserver.fire('[data-editor-inner-panels]');

      const flooredOuter = groupSetLayoutCalls.at(-1);
      expect(flooredOuter).toBeDefined();
      expect(((flooredOuter?.['terminal-column'] ?? 0) / 100) * outerPx).toBeCloseTo(
        RIGHT_TERMINAL_PANEL_MIN_WIDTH_PX,
        3,
      );
      expect(((flooredOuter?.['agents-column'] ?? 0) / 100) * outerPx).toBeCloseTo(
        MIN_AGENTS_PANEL_WIDTH,
        3,
      );
      expect(lastInnerWritePx('doc-panel')).toBeCloseTo(300, 3);
    } finally {
      resizeObserver.restore();
    }
  });

  test('at a 1400px window with a document open, chat joins the right terminal', async () => {
    const resizeObserver = installResizeObserver();
    try {
      const rowPx = 1400 - FILE_LIST_PX - SHELL_CHROME_PX;
      setViewportWidth(1400);
      mockGroupPx = rowPx;
      mockPanelPx = 320;
      mockPanelPercentage = pctOfRow(320, rowPx);
      docCtx = DOC_LIVE_CTX;
      const terminalChanges: boolean[] = [];
      const agentsChanges: boolean[] = [];
      const view = render(
        <EditorArea
          {...rowProps}
          agentsVisible={false}
          terminalVisible
          terminalPlacement="right"
          onAgentsVisibleChange={(visible: boolean) => {
            agentsChanges.push(visible);
          }}
          onTerminalVisibleChange={(visible: boolean) => {
            terminalChanges.push(visible);
          }}
        />,
      );
      groupLayout = {
        'editor-main': 100 - pctOfRow(740, rowPx),
        'terminal-column': pctOfRow(740, rowPx),
        'agents-column': 0,
      };
      innerLayout = innerRowWithDoc(320, rowPx - 740);
      const inner = document.querySelector<HTMLElement>('[data-editor-inner-panels]');
      if (inner == null) throw new Error('the editor inner row is absent');
      Object.defineProperty(inner, 'getBoundingClientRect', {
        configurable: true,
        value: () => ({ width: rowPx - 740 }),
      });
      resizeObserver.fire('[data-editor-inner-panels]');

      view.rerender(
        <EditorArea
          {...rowProps}
          agentsVisible
          terminalVisible
          terminalPlacement="right"
          onAgentsVisibleChange={(visible: boolean) => {
            agentsChanges.push(visible);
          }}
          onTerminalVisibleChange={(visible: boolean) => {
            terminalChanges.push(visible);
          }}
        />,
      );
      await act(async () => {});

      expect(terminalChanges).toEqual([]);
      expect(agentsChanges).toEqual([]);
      expect(toastInfoMessages).toEqual([]);
    } finally {
      resizeObserver.restore();
    }
  });

  test('a re-plan and an admission check that arrive during a side-panel drag wait for the drag to end', async () => {
    const resizeObserver = installResizeObserver();
    try {
      setViewportWidth(2000);
      mockGroupPx = 2000;
      mockPanelPx = 320;
      docCtx = DOC_LIVE_CTX;
      const agentsChanges: boolean[] = [];
      groupLayout = {
        'editor-main': 100 - pctOfRow(740 + 480, 2000),
        'terminal-column': pctOfRow(740, 2000),
        'agents-column': pctOfRow(480, 2000),
      };
      innerLayout = innerRowWithDoc(320, 2000 - 740 - 480);
      render(
        <EditorArea
          {...rowProps}
          agentsVisible
          terminalVisible
          terminalPlacement="right"
          onAgentsVisibleChange={(visible: boolean) => {
            agentsChanges.push(visible);
          }}
        />,
      );
      await act(async () => {});

      act(() => {
        fireEvent.pointerDown(docHandle(), { pointerId: 1 });
      });
      groupSetLayoutCalls = [];
      innerSetLayoutCalls = [];
      toastInfoMessages = [];
      mockGroupPx = 1000;
      resizeObserver.fire('[data-editor-area-panels]');
      resizeObserver.fire('[data-editor-inner-panels]');

      expect(groupSetLayoutCalls).toHaveLength(0);
      expect(innerSetLayoutCalls).toHaveLength(0);
      expect(agentsChanges).toEqual([]);
      expect(toastInfoMessages).toEqual([]);

      act(() => {
        fireEvent.pointerUp(window, { pointerId: 1 });
      });

      expect(groupSetLayoutCalls.length).toBeGreaterThan(0);
      expect(agentsChanges).toEqual([false]);
      expect(toastInfoMessages).toEqual(['Agent panel closed to keep Terminal readable.']);
    } finally {
      resizeObserver.restore();
    }
  });

  test('a chat drag the library starts beside the divider takes the drag lock, marks the outer row, and re-plans on release', async () => {
    const resizeObserver = installResizeObserver();
    try {
      setViewportWidth(2000);
      mockGroupPx = 2000;
      deliverDocPanelResizeAfterLayout = true;
      docCtx = DOC_LIVE_CTX;
      const agentsChanges: boolean[] = [];
      groupLayout = {
        'editor-main': 100 - pctOfRow(740 + 480, 2000),
        'terminal-column': pctOfRow(740, 2000),
        'agents-column': pctOfRow(480, 2000),
      };
      innerLayout = innerRowWithDoc(320, 2000 - 740 - 480);
      render(
        <EditorArea
          {...rowProps}
          agentsVisible
          terminalVisible
          terminalPlacement="right"
          onAgentsVisibleChange={(visible: boolean) => {
            agentsChanges.push(visible);
          }}
        />,
      );
      await act(async () => {});
      measureEditorCardForRow(resizeObserver);
      const outerRow = screen.getByTestId('resizable-group');
      expect(outerRow.getAttribute('data-dragging')).toBeNull();

      agentsHandle().setAttribute('data-separator', 'active');
      groupLayout = {
        'editor-main': 100 - pctOfRow(740 + 630, 2000),
        'terminal-column': pctOfRow(740, 2000),
        'agents-column': pctOfRow(630, 2000),
      };
      act(() => {
        groupOnLayoutChange?.(groupLayout);
        railPanelOnResizeById.get(AGENTS_COLUMN_ID)?.({
          asPercentage: groupLayout[AGENTS_COLUMN_ID],
          inPixels: 630,
        });
      });
      expect(outerRow.getAttribute('data-dragging')).toBe('true');
      expect(document.getElementById(AGENTS_COLUMN_ID)?.getBoundingClientRect().width).toBeCloseTo(
        630,
        0,
      );
      expect(lastInnerWritePx('doc-panel')).toBeCloseTo(320, 3);

      groupSetLayoutCalls = [];
      innerSetLayoutCalls = [];
      toastInfoMessages = [];
      setViewportWidth(1000);
      mockGroupPx = 1000;
      measureEditorCardForRow(resizeObserver);
      resizeObserver.fire('[data-editor-area-panels]');
      resizeObserver.fire('[data-editor-inner-panels]');

      expect(groupSetLayoutCalls).toHaveLength(0);
      expect(document.getElementById('doc-panel')?.getBoundingClientRect().width).toBe(0);
      expect(innerResidualWidthPx()).toBeGreaterThanOrEqual(300);
      expect(agentsChanges).toEqual([]);
      expect(toastInfoMessages).toEqual([]);

      setViewportWidth(2200);
      mockGroupPx = 2200;
      measureEditorCardForRow(resizeObserver);
      resizeObserver.fire('[data-editor-area-panels]');
      resizeObserver.fire('[data-editor-inner-panels]');
      expect(groupSetLayoutCalls).toHaveLength(0);
      expect(document.getElementById('doc-panel')?.getBoundingClientRect().width).toBeCloseTo(
        320,
        0,
      );
      expect(innerResidualWidthPx()).toBeGreaterThanOrEqual(300);
      expect(agentsChanges).toEqual([]);
      expect(toastInfoMessages).toEqual([]);

      setViewportWidth(1000);
      mockGroupPx = 1000;
      measureEditorCardForRow(resizeObserver);
      resizeObserver.fire('[data-editor-area-panels]');
      resizeObserver.fire('[data-editor-inner-panels]');
      expect(groupSetLayoutCalls).toHaveLength(0);
      expect(document.getElementById('doc-panel')?.getBoundingClientRect().width).toBe(0);
      expect(innerResidualWidthPx()).toBeGreaterThanOrEqual(300);

      setViewportWidth(850);
      mockGroupPx = 850;
      measureEditorCardForRow(resizeObserver);
      resizeObserver.fire('[data-editor-area-panels]');
      resizeObserver.fire('[data-editor-inner-panels]');
      expect(groupSetLayoutCalls).toHaveLength(0);
      expect(agentsChanges).toEqual([]);
      expect(toastInfoMessages).toEqual([]);

      agentsHandle().removeAttribute('data-separator');
      act(() => {
        fireEvent.pointerUp(window, { pointerId: 7 });
      });

      expect(outerRow.getAttribute('data-dragging')).toBeNull();
      expect(groupSetLayoutCalls.length).toBeGreaterThan(0);
      expect(agentsChanges).toEqual([false]);
      expect(toastInfoMessages).toEqual(['Agent panel closed to keep Terminal readable.']);
    } finally {
      resizeObserver.restore();
    }
  });

  test('a side-panel drag the library starts beside the divider takes the drag lock, marks the inner row, and re-plans on release', async () => {
    const resizeObserver = installResizeObserver();
    try {
      setViewportWidth(1400);
      mockGroupPx = 1360;
      docCtx = DOC_LIVE_CTX;
      groupLayout = {
        'editor-main': 100 - pctOfRow(480, 1360),
        'agents-column': pctOfRow(480, 1360),
      };
      innerLayout = innerRowWithDoc(320, 1360 - 480);
      render(<EditorArea {...rowProps} agentsVisible />);
      await act(async () => {});
      const innerRow = screen.getByTestId('resizable-group-inner');
      expect(innerRow.getAttribute('data-dragging')).toBeNull();

      docHandle().setAttribute('data-separator', 'active');
      innerLayout = innerRowWithDoc(360, 1360 - 480);
      act(() => {
        innerRowHandlers.onLayoutChange?.(innerLayout);
      });
      expect(innerRow.getAttribute('data-dragging')).toBe('true');

      groupSetLayoutCalls = [];
      innerSetLayoutCalls = [];
      mockGroupPx = 1000;
      resizeObserver.fire('[data-editor-area-panels]');
      resizeObserver.fire('[data-editor-inner-panels]');
      expect(groupSetLayoutCalls).toHaveLength(0);
      expect(innerSetLayoutCalls).toHaveLength(0);

      docHandle().removeAttribute('data-separator');
      act(() => {
        fireEvent.pointerUp(window, { pointerId: 7 });
      });
      expect(innerRow.getAttribute('data-dragging')).toBeNull();
      expect(groupSetLayoutCalls.length).toBeGreaterThan(0);
    } finally {
      resizeObserver.restore();
    }
  });

  test('the joint plan’s own outer write never adopts a drag from a separator that still reads active', async () => {
    setViewportWidth(1400);
    mockGroupPx = 1360;
    docCtx = DOC_LIVE_CTX;
    groupLayout = {
      'editor-main': 100 - pctOfRow(480, 1360),
      'agents-column': pctOfRow(480, 1360),
    };
    innerLayout = innerRowWithDoc(320, 1360 - 480);
    render(<EditorArea {...rowProps} agentsVisible />);
    await act(async () => {});
    const outerRow = screen.getByTestId('resizable-group');

    agentsHandle().setAttribute('data-separator', 'active');
    groupLayout = { 'editor-main': 60, 'agents-column': 40 };
    act(() => {
      groupOnLayoutChange?.(groupLayout);
    });
    expect(outerRow.getAttribute('data-dragging')).toBe('true');

    const echoOuterWrites = groupHandles.outer.setLayout;
    groupHandles.outer.setLayout = (layout: MockLayout) => {
      echoOuterWrites(layout);
      groupOnLayoutChange?.(layout);
    };
    try {
      groupSetLayoutCalls = [];
      act(() => {
        fireEvent.pointerUp(window, { pointerId: 7 });
      });
      expect(groupSetLayoutCalls.length).toBeGreaterThan(0);
      expect(outerRow.getAttribute('data-dragging')).toBeNull();
    } finally {
      groupHandles.outer.setLayout = echoOuterWrites;
    }
  });

  test('every side-panel drag end re-plans both rows', async () => {
    setViewportWidth(1400);
    docCtx = DOC_LIVE_CTX;
    groupLayout = {
      'editor-main': 100 - pctOfRow(480, 1360),
      'agents-column': pctOfRow(480, 1360),
    };
    innerLayout = innerRowWithDoc(320, 1360 - 480);
    render(<EditorArea {...rowProps} agentsVisible />);
    await act(async () => {});
    groupLayout = { 'editor-main': 60, 'agents-column': 40 };
    innerLayout = innerRowWithDoc(300, 0.6 * 1360);
    groupSetLayoutCalls = [];
    innerSetLayoutCalls = [];

    act(() => {
      fireEvent.pointerDown(docHandle(), { pointerId: 1 });
    });
    expect(groupSetLayoutCalls).toHaveLength(0);
    act(() => {
      fireEvent.pointerUp(window, { pointerId: 1 });
    });

    expect(((groupSetLayoutCalls.at(-1)?.['agents-column'] ?? 0) / 100) * 1360).toBeCloseTo(480, 3);
    expect(lastInnerWritePx('doc-panel')).toBeCloseTo(320, 3);
  });

  test('a chat drag the library started beside the divider commits the released width as the preferred width', async () => {
    const resizeObserver = installResizeObserver();
    try {
      setViewportWidth(1400);
      mockGroupPx = 1360;
      docCtx = DOC_LIVE_CTX;
      groupLayout = {
        'editor-main': 100 - pctOfRow(480, 1360),
        'agents-column': pctOfRow(480, 1360),
      };
      innerLayout = innerRowWithDoc(320, 1360 - 480);
      render(<EditorArea {...rowProps} agentsVisible />);
      await act(async () => {});

      agentsHandle().setAttribute('data-separator', 'active');
      groupLayout = {
        'editor-main': 100 - pctOfRow(630, 1360),
        'agents-column': pctOfRow(630, 1360),
      };
      act(() => {
        groupOnLayoutChange?.(groupLayout);
      });
      mockPanelPx = 630;
      mockPanelPercentage = pctOfRow(630, 1360);
      agentsHandle().removeAttribute('data-separator');
      act(() => {
        fireEvent.pointerUp(window, { pointerId: 7 });
      });
      mockPanelPx = null;
      mockPanelPercentage = null;

      groupSetLayoutCalls = [];
      mockGroupPx = 1300;
      resizeObserver.fire('[data-editor-area-panels]');
      expect(((groupSetLayoutCalls.at(-1)?.['agents-column'] ?? 0) / 100) * 1300).toBeCloseTo(
        630,
        3,
      );
    } finally {
      resizeObserver.restore();
    }
  });

  test('a chat drag the library started beside the divider that closes the column leaves it collapsed without changing visibility', async () => {
    setViewportWidth(1400);
    mockGroupPx = 1360;
    docCtx = DOC_LIVE_CTX;
    const agentsChanges: boolean[] = [];
    groupLayout = {
      'editor-main': 100 - pctOfRow(480, 1360),
      'agents-column': pctOfRow(480, 1360),
    };
    innerLayout = innerRowWithDoc(320, 1360 - 480);
    render(
      <EditorArea
        {...rowProps}
        agentsVisible
        onAgentsVisibleChange={(visible: boolean) => {
          agentsChanges.push(visible);
        }}
      />,
    );
    await act(async () => {});
    const outerRow = screen.getByTestId('resizable-group');

    agentsHandle().setAttribute('data-separator', 'active');
    groupLayout = { 'editor-main': 100, 'agents-column': 0 };
    act(() => {
      groupOnLayoutChange?.(groupLayout);
    });
    expect(outerRow.getAttribute('data-dragging')).toBe('true');
    groupSetLayoutCalls = [];
    mockPanelPx = 0;
    mockPanelPercentage = 0;
    panelIsCollapsed = true;
    agentsHandle().removeAttribute('data-separator');
    act(() => {
      fireEvent.pointerUp(window, { pointerId: 7 });
    });

    expect(outerRow.getAttribute('data-dragging')).toBeNull();
    expect(agentsChanges).toEqual([]);
    expect(groupSetLayoutCalls).toHaveLength(0);
  });

  test('a right-terminal drag the library starts beside the divider takes the drag lock, marks the outer row, and re-plans on release', async () => {
    const resizeObserver = installResizeObserver();
    try {
      setViewportWidth(2000);
      mockGroupPx = 2000;
      deliverDocPanelResizeAfterLayout = true;
      docCtx = DOC_LIVE_CTX;
      const agentsChanges: boolean[] = [];
      groupLayout = {
        'editor-main': 100 - pctOfRow(740 + 480, 2000),
        'terminal-column': pctOfRow(740, 2000),
        'agents-column': pctOfRow(480, 2000),
      };
      innerLayout = innerRowWithDoc(320, 2000 - 740 - 480);
      render(
        <EditorArea
          {...rowProps}
          agentsVisible
          terminalVisible
          terminalPlacement="right"
          onAgentsVisibleChange={(visible: boolean) => {
            agentsChanges.push(visible);
          }}
        />,
      );
      await act(async () => {});
      measureEditorCardForRow(resizeObserver);
      const outerRow = screen.getByTestId('resizable-group');
      expect(outerRow.getAttribute('data-dragging')).toBeNull();

      terminalHandle().setAttribute('data-separator', 'active');
      groupLayout = {
        'editor-main': 100 - pctOfRow(890 + 480, 2000),
        'terminal-column': pctOfRow(890, 2000),
        'agents-column': pctOfRow(480, 2000),
      };
      act(() => {
        groupOnLayoutChange?.(groupLayout);
        railPanelOnResizeById.get(TERMINAL_COLUMN_ID)?.({
          asPercentage: groupLayout[TERMINAL_COLUMN_ID],
          inPixels: 890,
        });
      });
      expect(outerRow.getAttribute('data-dragging')).toBe('true');
      expect(
        document.getElementById(TERMINAL_COLUMN_ID)?.getBoundingClientRect().width,
      ).toBeCloseTo(890, 0);
      expect(lastInnerWritePx('doc-panel')).toBeCloseTo(320, 3);

      groupSetLayoutCalls = [];
      innerSetLayoutCalls = [];
      toastInfoMessages = [];
      setViewportWidth(1000);
      mockGroupPx = 1000;
      measureEditorCardForRow(resizeObserver);
      resizeObserver.fire('[data-editor-area-panels]');
      resizeObserver.fire('[data-editor-inner-panels]');

      expect(groupSetLayoutCalls).toHaveLength(0);
      expect(document.getElementById('doc-panel')?.getBoundingClientRect().width).toBe(0);
      expect(innerResidualWidthPx()).toBeGreaterThanOrEqual(300);
      expect(agentsChanges).toEqual([]);
      expect(toastInfoMessages).toEqual([]);

      setViewportWidth(2200);
      mockGroupPx = 2200;
      measureEditorCardForRow(resizeObserver);
      resizeObserver.fire('[data-editor-area-panels]');
      resizeObserver.fire('[data-editor-inner-panels]');
      expect(groupSetLayoutCalls).toHaveLength(0);
      expect(document.getElementById('doc-panel')?.getBoundingClientRect().width).toBeCloseTo(
        320,
        0,
      );
      expect(innerResidualWidthPx()).toBeGreaterThanOrEqual(300);
      expect(agentsChanges).toEqual([]);
      expect(toastInfoMessages).toEqual([]);

      setViewportWidth(1000);
      mockGroupPx = 1000;
      measureEditorCardForRow(resizeObserver);
      resizeObserver.fire('[data-editor-area-panels]');
      resizeObserver.fire('[data-editor-inner-panels]');
      expect(groupSetLayoutCalls).toHaveLength(0);
      expect(document.getElementById('doc-panel')?.getBoundingClientRect().width).toBe(0);
      expect(innerResidualWidthPx()).toBeGreaterThanOrEqual(300);

      setViewportWidth(850);
      mockGroupPx = 850;
      measureEditorCardForRow(resizeObserver);
      resizeObserver.fire('[data-editor-area-panels]');
      resizeObserver.fire('[data-editor-inner-panels]');
      expect(groupSetLayoutCalls).toHaveLength(0);
      expect(agentsChanges).toEqual([]);
      expect(toastInfoMessages).toEqual([]);

      terminalHandle().removeAttribute('data-separator');
      act(() => {
        fireEvent.pointerUp(window, { pointerId: 7 });
      });
      await act(async () => {});

      expect(outerRow.getAttribute('data-dragging')).toBeNull();
      expect(groupSetLayoutCalls.length).toBeGreaterThan(0);
      expect(agentsChanges).toEqual([false]);
      expect(toastInfoMessages).toEqual(['Agent panel closed to keep Terminal readable.']);
    } finally {
      resizeObserver.restore();
    }
  });

  test('a right-terminal drag the library started beside the divider that closes the column leaves it collapsed without changing visibility', async () => {
    setViewportWidth(2000);
    mockGroupPx = 2000;
    docCtx = DOC_LIVE_CTX;
    const terminalChanges: boolean[] = [];
    groupLayout = {
      'editor-main': 100 - pctOfRow(740, 2000),
      'terminal-column': pctOfRow(740, 2000),
    };
    innerLayout = innerRowWithDoc(320, 2000 - 740);
    render(
      <EditorArea
        {...rowProps}
        terminalVisible
        terminalPlacement="right"
        onTerminalVisibleChange={(visible: boolean) => {
          terminalChanges.push(visible);
        }}
      />,
    );
    await act(async () => {});
    const outerRow = screen.getByTestId('resizable-group');

    terminalHandle().setAttribute('data-separator', 'active');
    groupLayout = { 'editor-main': 100, 'terminal-column': 0 };
    act(() => {
      groupOnLayoutChange?.(groupLayout);
    });
    expect(outerRow.getAttribute('data-dragging')).toBe('true');
    groupSetLayoutCalls = [];
    panelIsCollapsed = true;
    terminalHandle().removeAttribute('data-separator');
    act(() => {
      fireEvent.pointerUp(window, { pointerId: 7 });
    });

    expect(outerRow.getAttribute('data-dragging')).toBeNull();
    expect(terminalChanges).toEqual([]);
    expect(groupSetLayoutCalls).toHaveLength(0);
  });

  test('a drag end that closes a column leaves the follow-up pin to the column sync', () => {
    setViewportWidth(1400);
    docCtx = DOC_LIVE_CTX;
    const agentsChanges: boolean[] = [];
    render(
      <EditorArea
        {...rowProps}
        agentsVisible
        onAgentsVisibleChange={(visible: boolean) => {
          agentsChanges.push(visible);
        }}
      />,
    );
    groupLayout = { 'editor-main': 100, 'agents-column': 0 };
    groupSetLayoutCalls = [];
    act(() => {
      fireEvent.pointerDown(agentsHandle(), { pointerId: 1 });
    });
    mockPanelPx = 0;
    mockPanelPercentage = 0;
    panelIsCollapsed = true;
    act(() => {
      fireEvent.pointerUp(window, { pointerId: 1 });
    });

    expect(agentsChanges).toEqual([false]);
    expect(groupSetLayoutCalls).toHaveLength(0);
  });

  test('the inner row observer re-plans and re-checks admission on its own', async () => {
    const resizeObserver = installResizeObserver();
    try {
      setViewportWidth(2000);
      mockGroupPx = 2000;
      mockPanelPx = 320;
      docCtx = DOC_LIVE_CTX;
      const agentsChanges: boolean[] = [];
      groupLayout = {
        'editor-main': 100 - pctOfRow(740 + 480, 2000),
        'terminal-column': pctOfRow(740, 2000),
        'agents-column': pctOfRow(480, 2000),
      };
      innerLayout = innerRowWithDoc(320, 2000 - 740 - 480);
      render(
        <EditorArea
          {...rowProps}
          agentsVisible
          terminalVisible
          terminalPlacement="right"
          onAgentsVisibleChange={(visible: boolean) => {
            agentsChanges.push(visible);
          }}
        />,
      );
      await act(async () => {});
      groupSetLayoutCalls = [];
      innerSetLayoutCalls = [];

      mockGroupPx = 1000;
      resizeObserver.fire('[data-editor-inner-panels]');

      expect(groupSetLayoutCalls.length).toBeGreaterThan(0);
      expect(agentsChanges).toEqual([false]);
      expect(toastInfoMessages).toEqual(['Agent panel closed to keep Terminal readable.']);
    } finally {
      resizeObserver.restore();
    }
  });

  const renderWideRowsWithTerminalAndChat = async (agentsChanges: boolean[]) => {
    setViewportWidth(2000);
    mockGroupPx = 2000;
    mockPanelPx = 320;
    docCtx = DOC_LIVE_CTX;
    groupLayout = {
      'editor-main': 100 - pctOfRow(740 + 480, 2000),
      'terminal-column': pctOfRow(740, 2000),
      'agents-column': pctOfRow(480, 2000),
    };
    innerLayout = innerRowWithDoc(320, 2000 - 740 - 480);
    render(
      <EditorArea
        {...rowProps}
        agentsVisible
        terminalVisible
        terminalPlacement="right"
        onAgentsVisibleChange={(visible: boolean) => {
          agentsChanges.push(visible);
        }}
      />,
    );
    await act(async () => {});
  };

  test('the inner row observer skips the resize an outer row layout change explains while every pin is in place, and re-plans on the next one', async () => {
    const resizeObserver = installResizeObserver();
    try {
      const agentsChanges: boolean[] = [];
      await renderWideRowsWithTerminalAndChat(agentsChanges);
      groupSetLayoutCalls = [];
      innerSetLayoutCalls = [];

      mockGroupPx = 1000;
      act(() => groupOnLayoutChange?.(groupLayout));
      resizeObserver.fire('[data-editor-inner-panels]');
      await flushFrame();

      expect(groupSetLayoutCalls).toHaveLength(0);
      expect(innerSetLayoutCalls).toHaveLength(0);
      expect(agentsChanges).toEqual([]);
      expect(toastInfoMessages).toEqual([]);

      resizeObserver.fire('[data-editor-inner-panels]');
      await flushFrame();

      expect(groupSetLayoutCalls.length).toBeGreaterThan(0);
      expect(agentsChanges).toEqual([false]);
      expect(toastInfoMessages).toEqual(['Agent panel closed to keep Terminal readable.']);
    } finally {
      resizeObserver.restore();
    }
  });

  test('an outer layout change that leaves the editor column width alone does not swallow the next inner resize', async () => {
    const resizeObserver = installResizeObserver();
    try {
      const agentsChanges: boolean[] = [];
      await renderWideRowsWithTerminalAndChat(agentsChanges);
      act(() => groupOnLayoutChange?.(groupLayout));
      resizeObserver.fire('[data-editor-inner-panels]');
      await flushFrame();

      groupLayout = {
        'editor-main': groupLayout['editor-main'],
        'terminal-column': pctOfRow(700, 2000),
        'agents-column': pctOfRow(520, 2000),
      };
      act(() => groupOnLayoutChange?.(groupLayout));
      groupSetLayoutCalls = [];
      innerSetLayoutCalls = [];

      innerLayout = innerRowWithDoc(300, 2000 - 740 - 480);
      resizeObserver.fire('[data-editor-inner-panels]');
      await flushFrame();

      expect(innerSetLayoutCalls.length).toBeGreaterThan(0);
      expect(lastInnerWritePx('doc-panel')).toBeCloseTo(320, 0);
    } finally {
      resizeObserver.restore();
    }
  });

  test('the inner row observer still re-plans after an outer row layout change when the last plan left a pin unplaced', async () => {
    const resizeObserver = installResizeObserver();
    try {
      const agentsChanges: boolean[] = [];
      await renderWideRowsWithTerminalAndChat(agentsChanges);

      mockGroupPx = 0;
      resizeObserver.fire('[data-editor-area-panels]');
      await flushFrame();
      expect(agentsChanges).toEqual([]);
      groupSetLayoutCalls = [];
      innerSetLayoutCalls = [];

      mockGroupPx = 1000;
      act(() => groupOnLayoutChange?.(groupLayout));
      resizeObserver.fire('[data-editor-inner-panels]');
      await flushFrame();

      expect(groupSetLayoutCalls.length).toBeGreaterThan(0);
      expect(agentsChanges).toEqual([false]);
      expect(toastInfoMessages).toEqual(['Agent panel closed to keep Terminal readable.']);
    } finally {
      resizeObserver.restore();
    }
  });

  test('the observers stay off inside an embedded host', () => {
    const resizeObserver = installResizeObserver();
    const originalUserAgent = navigator.userAgent;
    Object.defineProperty(navigator, 'userAgent', {
      configurable: true,
      value: `${originalUserAgent} Claude/1.0`,
    });
    try {
      setViewportWidth(1400);
      docCtx = DOC_LIVE_CTX;
      render(<EditorArea {...rowProps} agentsVisible />);
      expect(() => resizeObserver.fire('[data-editor-area-panels]')).toThrow(/not observed/);
      groupSetLayoutCalls = [];
      innerSetLayoutCalls = [];
      resizeObserver.fire('[data-editor-inner-panels]');
      expect(groupSetLayoutCalls).toHaveLength(0);
      expect(innerSetLayoutCalls).toHaveLength(0);
    } finally {
      Object.defineProperty(navigator, 'userAgent', {
        configurable: true,
        value: originalUserAgent,
      });
      resizeObserver.restore();
    }
  });
});

describe('EditorArea terminal and chat cards', () => {
  const cardProps = {
    editorMode: 'wysiwyg',
    onModeChange: () => {},
    activeTab: 'timeline',
    onActiveTabChange: () => {},
    onAgentsVisibleChange: () => {},
    onTerminalVisibleChange: () => {},
  } as const;
  const setViewportWidth = (px: number) => {
    Object.defineProperty(window, 'innerWidth', { value: px, configurable: true, writable: true });
  };
  const pctOfRow = (px: number, rowPx: number) => (px / rowPx) * 100;
  const cardOf = (pane: PaneId) =>
    document.querySelector<HTMLElement>(`[data-slot="pane-card"][data-pane="${pane}"]`);

  beforeEach(() => {
    cleanup();
    localStorage.clear();
    docCtx = DOC_LIVE_CTX;
    groupLayout = {};
    groupSetLayoutCalls = [];
    rejectNextGroupLayoutWrite = false;
    rejectGroupLayoutWrites = false;
    panelIsCollapsed = false;
    mockGroupPx = 1360;
    mockPanelPercentage = null;
    mockPanelPx = null;
    toastInfoMessages = [];
    editorWorkspaceMounts = 0;
    setViewportWidth(1400);
  });

  test('a right terminal and chat are their own cards in their columns, and the editor card sits inside the terminal split', () => {
    render(
      <TooltipProvider>
        <EditorArea
          {...cardProps}
          terminalBridge={{} as never}
          terminalVisible
          terminalPlacement="right"
          agentsVisible
        />
      </TooltipProvider>,
    );

    const editorCard = cardOf('editor');
    const terminalCard = cardOf('terminal');
    const chatCard = cardOf('agents');
    expect(terminalCard?.getAttribute('data-placement')).toBe('right');
    expect(terminalCard?.getAttribute('data-variant')).toBe('card');
    expect(chatCard?.getAttribute('data-variant')).toBe('card');
    expect(document.getElementById('terminal-column')?.contains(terminalCard)).toBe(true);
    expect(document.getElementById('agents-column')?.contains(chatCard)).toBe(true);
    expect(terminalCard?.contains(document.querySelector('[data-terminal-panel-mount]'))).toBe(
      true,
    );
    expect(chatCard?.contains(document.querySelector('[data-agents-panel-mount]'))).toBe(true);
    expect(screen.getByTestId('terminal-dock').contains(editorCard)).toBe(true);
    expect(editorCard?.contains(terminalCard)).toBe(false);
    expect(editorCard?.contains(chatCard)).toBe(false);
  });

  test('without a terminal, as on the web, the terminal column keeps its mount but draws no card', () => {
    render(
      <TooltipProvider>
        <EditorArea {...cardProps} agentsVisible />
      </TooltipProvider>,
    );

    expect(cardOf('terminal')).toBeNull();
    expect(cardOf('agents')).not.toBeNull();
    expect(
      document
        .getElementById('terminal-column')
        ?.contains(document.querySelector('[data-terminal-panel-mount]')),
    ).toBe(true);
  });

  test('the chat and right terminal cards cast their shadow only while their column shows', () => {
    const area = (visible: boolean) => (
      <TooltipProvider>
        <EditorArea
          {...cardProps}
          terminalBridge={{} as never}
          terminalVisible={visible}
          terminalPlacement="right"
          agentsVisible={visible}
        />
      </TooltipProvider>
    );
    const expectShadow = (casting: boolean) => {
      for (const pane of ['terminal', 'agents'] as const) {
        const card = cardOf(pane);
        expect(card, `${pane} card`).not.toBeNull();
        if (casting) expectVisualClassTokensAbsent(card?.className, ['shadow-none']);
        else expectVisualClassTokens(card?.className, ['shadow-none']);
      }
    };
    const view = render(area(true));
    expectShadow(true);

    act(() => {
      railPanelOnResizeById.get(TERMINAL_COLUMN_ID)?.({ asPercentage: 0, inPixels: 0 });
      railPanelOnResizeById.get(AGENTS_COLUMN_ID)?.({ asPercentage: 0, inPixels: 0 });
    });
    expectShadow(false);

    act(() => {
      railPanelOnResizeById.get(TERMINAL_COLUMN_ID)?.({ asPercentage: 25, inPixels: 300 });
      railPanelOnResizeById.get(AGENTS_COLUMN_ID)?.({ asPercentage: 25, inPixels: 300 });
    });
    expectShadow(true);

    view.rerender(area(false));
    expectShadow(false);
  });

  test('main wraps the document column; the file list, chat and the side panel sit outside it as their own landmarks', () => {
    render(
      <TooltipProvider>
        <FileListHostProvider enabled fileList={<nav data-testid="landmark-file-list" />}>
          <EditorArea {...cardProps} agentsVisible />
        </FileListHostProvider>
      </TooltipProvider>,
    );

    const main = screen.getByRole('main');
    expect(main.hasAttribute('data-editor-workspace-column')).toBe(true);
    expect(main.contains(screen.getByTestId('workspace-tabs'))).toBe(true);
    expect(main.contains(screen.getByTestId('landmark-file-list'))).toBe(false);
    expect(cardOf('editor')?.contains(screen.getByTestId('landmark-file-list'))).toBe(true);
    const sidePanel = screen.getByRole('region', { name: 'Document panel' });
    expect(sidePanel.id).toBe('doc-panel');
    expect(main.contains(sidePanel)).toBe(false);
    const chat = screen.getByRole('region', { name: 'Agent panel' });
    expect(chat.hasAttribute('data-agents-panel-mount')).toBe(true);
    expect(main.contains(chat)).toBe(false);
    expect(main.contains(document.querySelector('[data-terminal-panel-mount]'))).toBe(false);
    expect(cardOf('editor')?.querySelector('[data-slot="sidebar-inset"]')?.contains(main)).toBe(
      true,
    );
  });

  test('the side panel toggle is one button at the end of the tab bar, only for an open document', () => {
    const { rerender } = render(
      <TooltipProvider>
        <EditorArea {...cardProps} />
      </TooltipProvider>,
    );

    const toggles = document.querySelectorAll('[data-doc-panel-toggle]');
    expect(toggles).toHaveLength(1);
    const header = document.querySelector('[data-editor-area-header]');
    expect(header?.contains(toggles[0] ?? null)).toBe(true);
    expect(toggles[0]?.getAttribute('aria-controls')).toBe('doc-panel');
    expect(toggles[0]?.getAttribute('aria-expanded')).toBe('true');
    expect(
      screen.getByTestId('workspace-tabs').compareDocumentPosition(toggles[0] as Node) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    fireEvent.click(toggles[0] as Element);
    act(() => {
      railPanelOnResizeById.get('doc-panel')?.({ asPercentage: 0, inPixels: 0 });
    });
    expect(document.querySelector('[data-doc-panel-toggle]')?.getAttribute('aria-expanded')).toBe(
      'false',
    );

    act(() => {
      docCtx = FOLDER_DOC_CTX;
    });
    rerender(
      <TooltipProvider>
        <EditorArea {...cardProps} />
      </TooltipProvider>,
    );
    expect(document.querySelector('[data-doc-panel-toggle]')).toBeNull();
  });

  test('the side panel toggle leaves the tab bar while the open document has a sync conflict', () => {
    const { rerender } = render(
      <TooltipProvider>
        <EditorArea {...cardProps} />
      </TooltipProvider>,
    );
    expect(document.querySelectorAll('[data-doc-panel-toggle]')).toHaveLength(1);

    conflictedDocName = 'docs/notes';
    rerender(
      <TooltipProvider>
        <EditorArea {...cardProps} />
      </TooltipProvider>,
    );

    const header = document.querySelector('[data-editor-area-header]');
    expect(header?.contains(screen.getByTestId('workspace-tabs'))).toBe(true);
    expect(document.querySelector('[data-doc-panel-toggle]')).toBeNull();
  });

  test('moving or hiding the terminal, and showing or hiding chat, never remounts the open editor', () => {
    const props = { ...cardProps, terminalBridge: {} as never };
    const { rerender } = render(
      <TooltipProvider>
        <EditorArea {...props} terminalVisible terminalPlacement="bottom" agentsVisible={false} />
      </TooltipProvider>,
    );
    const tabs = screen.getByTestId('workspace-tabs');
    const editorRegion = document.querySelector('[data-editor-region]');
    expect(editorWorkspaceMounts).toBe(1);

    const steps: Array<{
      terminalVisible: boolean;
      terminalPlacement: 'bottom' | 'right';
      agentsVisible: boolean;
    }> = [
      { terminalVisible: true, terminalPlacement: 'right', agentsVisible: false },
      { terminalVisible: true, terminalPlacement: 'right', agentsVisible: true },
      { terminalVisible: false, terminalPlacement: 'right', agentsVisible: true },
      { terminalVisible: true, terminalPlacement: 'bottom', agentsVisible: true },
      { terminalVisible: false, terminalPlacement: 'bottom', agentsVisible: false },
      { terminalVisible: true, terminalPlacement: 'bottom', agentsVisible: false },
    ];
    for (const step of steps) {
      rerender(
        <TooltipProvider>
          <EditorArea {...props} {...step} />
        </TooltipProvider>,
      );
    }
    act(() => emitLocalMenuAction('toggle-doc-panel'));
    act(() => emitLocalMenuAction('toggle-doc-panel'));

    expect(editorWorkspaceMounts).toBe(1);
    expect(screen.getByTestId('workspace-tabs')).toBe(tabs);
    expect(document.querySelector('[data-editor-region]')).toBe(editorRegion);
    expect(screen.getByRole('main').contains(tabs)).toBe(true);
  });

  test('a single-file window renders every normal card', () => {
    Object.defineProperty(window, 'okDesktop', {
      configurable: true,
      value: {
        config: { singleFile: true },
        editor: { notifyViewMenuStateChanged: () => {} },
      },
    });
    try {
      render(
        <TooltipProvider>
          <SingleFileModeProvider>
            <EditorArea
              {...cardProps}
              terminalBridge={{} as never}
              terminalVisible
              terminalPlacement="right"
              agentsVisible
            />
          </SingleFileModeProvider>
        </TooltipProvider>,
      );
      expect(cardOf('editor')?.getAttribute('data-variant')).toBe('card');
      expect(cardOf('terminal')?.getAttribute('data-variant')).toBe('card');
      expect(cardOf('agents')?.getAttribute('data-variant')).toBe('card');
      expect(screen.getByRole('main').contains(screen.getByTestId('workspace-tabs'))).toBe(true);
    } finally {
      Reflect.deleteProperty(window, 'okDesktop');
    }
  });

  test('inside an embedded host the cards render as in a project window while the host rules hold', () => {
    const originalUserAgent = navigator.userAgent;
    Object.defineProperty(navigator, 'userAgent', {
      configurable: true,
      value: `${originalUserAgent} Cursor/1.0`,
    });
    try {
      render(
        <TooltipProvider>
          <EditorArea {...cardProps} agentsVisible={false} />
        </TooltipProvider>,
      );
      expect(cardOf('editor')?.getAttribute('data-variant')).toBe('card');
      expect(cardOf('agents')?.getAttribute('data-variant')).toBe('card');
      expect(screen.queryByTestId('bottom-composer')).toBeNull();
      expect(document.getElementById('doc-panel')?.hasAttribute('inert')).toBe(true);
      expect(document.querySelector('[data-doc-panel-toggle]')?.getAttribute('aria-expanded')).toBe(
        'false',
      );
    } finally {
      Object.defineProperty(navigator, 'userAgent', {
        configurable: true,
        value: originalUserAgent,
      });
    }
    cleanup();
    render(
      <TooltipProvider>
        <EditorArea {...cardProps} agentsVisible={false} />
      </TooltipProvider>,
    );
    expect(screen.getByTestId('bottom-composer')).toBeTruthy();
  });

  test('the joint plan keeps a minimum width for Chat beside a right Terminal in both shared card shells', async () => {
    const initialOuterWidthPx = 1600;
    const outerWidthPx = 1128;
    const planAgentsWidth = async (singleFile: boolean) => {
      cleanup();
      localStorage.clear();
      localStorage.setItem(AGENTS_PANEL_WIDTH_KEY, '480');
      localStorage.setItem(DOC_PANEL_WIDTH_KEY, '320');
      localStorage.setItem(
        SIDEBAR_PINS_KEY,
        JSON.stringify({ right: { above: 'open', below: 'open', embedded: 'open' } }),
      );
      setViewportWidth(initialOuterWidthPx);
      mockGroupPx = initialOuterWidthPx;
      mockInnerPx = null;
      mockFileListPx = 0;
      mockPanelPx = null;
      mockPanelPercentage = null;
      panelIsCollapsed = false;
      panelRefCalls = 0;
      lastDeliveredDocPanelSize = null;
      deliverDocPanelResizeAfterLayout = true;
      railPanelOnResizeById.clear();
      groupLayout = {
        'editor-main': 100 - pctOfRow(RIGHT_TERMINAL_PANEL_MIN_WIDTH_PX + 480, initialOuterWidthPx),
        'terminal-column': pctOfRow(RIGHT_TERMINAL_PANEL_MIN_WIDTH_PX, initialOuterWidthPx),
        'agents-column': pctOfRow(480, initialOuterWidthPx),
      };
      innerLayout = innerRowWithDoc(
        320,
        initialOuterWidthPx - RIGHT_TERMINAL_PANEL_MIN_WIDTH_PX - 480,
      );
      committedGroupLayout = { ...groupLayout };
      committedInnerLayout = { ...innerLayout };
      groupSetLayoutCalls = [];
      innerSetLayoutCalls = [];
      innerSetLayoutPx = [];
      toastInfoMessages = [];
      Reflect.deleteProperty(window, 'okDesktop');
      if (singleFile) {
        Object.defineProperty(window, 'okDesktop', {
          configurable: true,
          value: {
            config: { singleFile: true },
            editor: { notifyViewMenuStateChanged: () => {} },
          },
        });
      }
      const resizeObserver = installResizeObserver();
      try {
        const withColumns = {
          ...cardProps,
          terminalBridge: {} as never,
          terminalVisible: true,
          terminalPlacement: 'right',
          terminalRightWidth: RIGHT_TERMINAL_PANEL_MIN_WIDTH_PX,
        } as const;
        const wrap = (node: ReactNode) =>
          singleFile ? (
            <TooltipProvider>
              <SingleFileModeProvider>{node}</SingleFileModeProvider>
            </TooltipProvider>
          ) : (
            <TooltipProvider>{node}</TooltipProvider>
          );
        render(wrap(<EditorArea {...withColumns} agentsVisible />));
        const card = cardOf('editor');
        const inner = document.querySelector<HTMLElement>('[data-editor-inner-panels]');
        if (card == null || inner == null)
          throw new Error('the editor card or inner row is absent');
        for (const element of [card, inner]) {
          Object.defineProperty(element, 'getBoundingClientRect', {
            configurable: true,
            value: () => ({ width: rowPx('inner'), height: 0, top: 0, left: 0 }),
          });
        }
        resizeObserver.fire('[data-slot="pane-card"][data-pane="editor"]');
        resizeObserver.fire('[data-editor-inner-panels]');
        await act(async () => {});
        const initialInfoWidthPx = document
          .getElementById('doc-panel')
          ?.getBoundingClientRect().width;
        const initialDocumentWidthPx = innerResidualWidthPx();
        const initialCardWidthPx = card.getBoundingClientRect().width;
        groupSetLayoutCalls = [];
        setViewportWidth(outerWidthPx);
        mockGroupPx = outerWidthPx;
        resizeObserver.fire('[data-slot="pane-card"][data-pane="editor"]');
        resizeObserver.fire('[data-editor-area-panels]');
        resizeObserver.fire('[data-editor-inner-panels]');
        resizeObserver.fire('[data-slot="pane-card"][data-pane="editor"]');
        await act(async () => {});
        return {
          initialInfoWidthPx,
          initialDocumentWidthPx,
          initialCardWidthPx,
          chatWidthPx: document.getElementById(AGENTS_COLUMN_ID)?.getBoundingClientRect().width,
          terminalWidthPx: document.getElementById(TERMINAL_COLUMN_ID)?.getBoundingClientRect()
            .width,
          infoWidthPx: document.getElementById('doc-panel')?.getBoundingClientRect().width,
          documentWidthPx: innerResidualWidthPx(),
          cardWidthPx: card.getBoundingClientRect().width,
          chatLayoutWrites: groupSetLayoutCalls.filter((layout) => layout[AGENTS_COLUMN_ID] > 0)
            .length,
          toasts: [...toastInfoMessages],
        };
      } finally {
        cleanup();
        resizeObserver.restore();
        Reflect.deleteProperty(window, 'okDesktop');
      }
    };

    const project = await planAgentsWidth(false);
    const singleFile = await planAgentsWidth(true);
    for (const variant of [project, singleFile]) {
      expect(variant.initialCardWidthPx).toBeCloseTo(
        initialOuterWidthPx - RIGHT_TERMINAL_PANEL_MIN_WIDTH_PX - 480,
        0,
      );
      expect(variant.initialInfoWidthPx).toBeCloseTo(320, 0);
      expect(variant.initialDocumentWidthPx).toBeGreaterThanOrEqual(300);
      expect(variant.chatLayoutWrites).toBeGreaterThan(0);
      expect(variant.chatWidthPx).toBeGreaterThanOrEqual(MIN_AGENTS_PANEL_WIDTH);
      expect(variant.chatWidthPx).toBeCloseTo(480, 0);
      expect(variant.terminalWidthPx).toBeCloseTo(RIGHT_TERMINAL_PANEL_MIN_WIDTH_PX, 0);
      expect(variant.infoWidthPx).toBe(0);
      expect(variant.documentWidthPx).toBeGreaterThanOrEqual(300);
      expect(variant.cardWidthPx).toBeCloseTo(
        outerWidthPx - RIGHT_TERMINAL_PANEL_MIN_WIDTH_PX - 480,
        0,
      );
      expect(variant.toasts).toEqual([]);
    }
    expect(singleFile.chatWidthPx).toBeCloseTo(project.chatWidthPx, 3);
  });
});

describe('EditorArea with the editor hidden', () => {
  const hiddenProps = {
    editorMode: 'wysiwyg',
    onModeChange: () => {},
    activeTab: 'timeline',
    onActiveTabChange: () => {},
    terminalBridge: {} as never,
    onAgentsVisibleChange: () => {},
    onTerminalVisibleChange: () => {},
  } as const;
  const ROW_PX = 1360;
  const pctOfRow = (px: number) => (px / ROW_PX) * 100;
  const editorColumn = () => {
    const column = document.querySelector<HTMLElement>(
      '[data-editor-row="outer"] > [data-panel]:not([id])',
    );
    if (column == null) throw new Error('editor column not rendered');
    return column;
  };
  const agentsHandle = () => {
    const handle = document.querySelector<HTMLElement>('[data-agents-panel-resize-handle]');
    if (handle == null) throw new Error('agents resize handle not found');
    return handle;
  };
  const terminalHandle = () => {
    const handle = document.querySelector<HTMLElement>('[data-terminal-panel-handle]');
    if (handle == null) throw new Error('terminal resize handle not found');
    return handle;
  };
  const settle = () => act(async () => {});

  beforeEach(() => {
    cleanup();
    localStorage.clear();
    docCtx = DOC_LIVE_CTX;
    groupLayout = {};
    groupSetLayoutCalls = [];
    rejectNextGroupLayoutWrite = false;
    rejectGroupLayoutWrites = false;
    panelIsCollapsed = false;
    mockGroupPx = ROW_PX;
    mockPanelPercentage = null;
    mockPanelPx = null;
    toastInfoMessages = [];
    Object.defineProperty(window, 'innerWidth', {
      value: 1400,
      configurable: true,
      writable: true,
    });
  });

  test('chat alone fills the row and the editor column may reach zero', async () => {
    const view = render(<EditorArea {...hiddenProps} agentsVisible />);
    groupLayout = { 'editor-main': 65, 'terminal-column': 0, 'agents-column': 35 };
    await settle();
    const innerWritesBeforeHide = innerSetLayoutCalls.length;

    view.rerender(<EditorArea {...hiddenProps} agentsVisible editorVisible={false} />);
    await settle();

    expect(groupSetLayoutCalls.at(-1)).toEqual({
      'editor-main': 0,
      'terminal-column': 0,
      'agents-column': 100,
    });
    expect(innerSetLayoutCalls).toHaveLength(innerWritesBeforeHide);
    expect(editorColumn().getAttribute('data-min-size')).toBe('0%');
    expect(document.getElementById('agents-column')?.getAttribute('data-max-size')).toBe('100%');
    expect(agentsHandle().style.display).toBe('none');
  });

  test.each([
    {
      pane: 'Chat',
      open: { agentsVisible: true },
      closed: { agentsVisible: false },
    },
    {
      pane: 'a right Terminal',
      open: { terminalVisible: true, terminalPlacement: 'right' },
      closed: { terminalVisible: false, terminalPlacement: 'right' },
    },
  ] as const)(
    'closing $pane while the editor is hidden mounts no composer until the editor shows',
    async ({ open, closed }) => {
      const view = render(<EditorArea {...hiddenProps} {...closed} />);
      await settle();
      expect(screen.queryByTestId('bottom-composer')).not.toBeNull();
      view.rerender(<EditorArea {...hiddenProps} {...open} />);
      await settle();
      expect(
        screen.queryByTestId('bottom-composer'),
        'precondition: an open pane beside the shown editor keeps the composer out',
      ).toBeNull();

      view.rerender(<EditorArea {...hiddenProps} {...open} editorVisible={false} />);
      await settle();
      view.rerender(<EditorArea {...hiddenProps} {...closed} editorVisible={false} />);
      await settle();
      expect(
        screen.queryByTestId('bottom-composer'),
        'a hidden editor keeps the pane visibility it had when it was last shown, so closing the ' +
          'pane under it must not mount a composer inside the hidden card. Reading either pane ' +
          'live, or dropping its field from that snapshot, mounts one here',
      ).toBeNull();

      view.rerender(<EditorArea {...hiddenProps} {...closed} />);
      await settle();
      expect(
        screen.queryByTestId('bottom-composer'),
        'showing the editor again with no pane open has to bring the composer back, so the ' +
          'hidden-state absence above is the snapshot and not a gate that never opens',
      ).not.toBeNull();
    },
  );

  test('a right terminal and chat share the row in proportion to their current widths', async () => {
    groupLayout = { 'editor-main': 40, 'terminal-column': 25, 'agents-column': 35 };
    const view = render(
      <EditorArea
        {...hiddenProps}
        agentsVisible
        terminalVisible
        terminalPlacement="right"
        terminalRightWidth={400}
      />,
    );
    groupLayout = { 'editor-main': 40, 'terminal-column': 25, 'agents-column': 35 };
    await settle();

    view.rerender(
      <EditorArea
        {...hiddenProps}
        agentsVisible
        terminalVisible
        terminalPlacement="right"
        terminalRightWidth={400}
        editorVisible={false}
      />,
    );
    await settle();

    const written = groupSetLayoutCalls.at(-1);
    expect(written?.['editor-main']).toBe(0);
    expect(written?.['terminal-column']).toBeCloseTo((25 / (25 + 35)) * 100);
    expect(written?.['agents-column']).toBeCloseTo((35 / (25 + 35)) * 100);
    expect(terminalHandle().style.display).toBe('none');
    expect(agentsHandle().style.display).toBe('');
  });

  test('with no right column the editor column keeps the row and nothing is written', async () => {
    const view = render(<EditorArea {...hiddenProps} />);
    groupLayout = { 'editor-main': 100, 'terminal-column': 0, 'agents-column': 0 };
    await settle();
    const writesBeforeHide = groupSetLayoutCalls.length;

    view.rerender(<EditorArea {...hiddenProps} editorVisible={false} />);
    await settle();

    expect(groupSetLayoutCalls).toHaveLength(writesBeforeHide);
    expect(editorColumn().getAttribute('data-min-size')).toBe('0%');
  });

  test('showing the editor re-plans both rows back to the pre-hide chat width', async () => {
    const view = render(<EditorArea {...hiddenProps} agentsVisible />);
    groupLayout = { 'editor-main': 65, 'terminal-column': 0, 'agents-column': 35 };
    await settle();
    view.rerender(<EditorArea {...hiddenProps} agentsVisible editorVisible={false} />);
    await settle();
    expect(groupLayout['agents-column']).toBe(100);
    const innerWritesWhileHidden = innerSetLayoutCalls.length;

    view.rerender(<EditorArea {...hiddenProps} agentsVisible />);
    await settle();

    const chatPct = pctOfRow(getInitialAgentsPanelWidth());
    expect(groupLayout['agents-column']).toBeCloseTo(chatPct);
    expect(groupLayout['editor-main']).toBeCloseTo(100 - chatPct);
    expect(editorColumn().getAttribute('data-min-size')).toBe('5%');
    expect(document.getElementById('agents-column')?.getAttribute('data-max-size')).toBe('95%');
    expect(agentsHandle().style.display).toBe('');
    expect(innerSetLayoutCalls.length).toBeGreaterThanOrEqual(innerWritesWhileHidden);
  });

  const editorCard = () => {
    const card = document.querySelector<HTMLElement>('[data-slot="pane-card"][data-pane="editor"]');
    if (card == null) throw new Error('editor card not rendered');
    return card;
  };

  test('hiding keeps the same editor card, workspace and file list mounted, pinned at their size and out of reach', async () => {
    const view = render(
      <FileListHostProvider enabled>
        <EditorArea {...hiddenProps} agentsVisible />
      </FileListHostProvider>,
    );
    groupLayout = { 'editor-main': 65, 'terminal-column': 0, 'agents-column': 35 };
    await settle();
    const card = editorCard();
    const fileListSlot = document.querySelector('[data-editor-file-list-slot]');
    const tabsTarget = document.querySelector('[data-editor-area-header]');
    Object.defineProperty(card, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({ width: 840, height: 610, top: 0, left: 0, right: 840, bottom: 610 }),
    });
    const workspaceMountsBefore = editorWorkspaceMounts;

    view.rerender(
      <FileListHostProvider enabled>
        <EditorArea {...hiddenProps} agentsVisible editorVisible={false} />
      </FileListHostProvider>,
    );
    await settle();

    expect(editorCard()).toBe(card);
    expect(document.querySelector('[data-editor-file-list-slot]')).toBe(fileListSlot);
    expect(document.querySelector('[data-editor-area-header]')).toBe(tabsTarget);
    expect(editorWorkspaceMounts).toBe(workspaceMountsBefore);
    expect(card.hasAttribute('inert')).toBe(true);
    expect(card.classList.contains('invisible')).toBe(true);
    expect(card.style.width).toBe('840px');
    expect(card.style.height).toBe('610px');
    expect(editorColumn().style.overflow).toBe('hidden');

    view.rerender(
      <FileListHostProvider enabled>
        <EditorArea {...hiddenProps} agentsVisible />
      </FileListHostProvider>,
    );
    await settle();
    await act(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));

    expect(groupLayout['editor-main']).toBeGreaterThan(0);
    expect(editorCard()).toBe(card);
    expect(editorWorkspaceMounts).toBe(workspaceMountsBefore);
    expect(card.hasAttribute('inert')).toBe(false);
    expect(card.classList.contains('invisible')).toBe(false);
    expect(card.style.width).toBe('');
    expect(editorColumn().style.overflow).toBe('visible');
  });

  test('hiding the editor while focus is inside it moves focus to the header Editor button', async () => {
    const editorButton = document.createElement('button');
    editorButton.setAttribute('data-header-pane-button', 'editor');
    document.body.append(editorButton);
    const view = render(<EditorArea {...hiddenProps} agentsVisible />);
    const region = document.querySelector<HTMLElement>('[data-editor-region]');
    region?.focus();
    expect(document.activeElement).toBe(region);

    view.rerender(<EditorArea {...hiddenProps} agentsVisible editorVisible={false} />);
    await settle();

    expect(document.activeElement).toBe(editorButton);
    editorButton.remove();
  });

  test('showing the editor from the header Editor button moves focus into the editor', async () => {
    const editorButton = document.createElement('button');
    editorButton.setAttribute('data-header-pane-button', 'editor');
    document.body.append(editorButton);
    const view = render(<EditorArea {...hiddenProps} agentsVisible editorVisible={false} />);
    await settle();
    editorButton.focus();

    view.rerender(<EditorArea {...hiddenProps} agentsVisible />);
    await settle();

    expect(document.activeElement).toBe(document.querySelector('[data-editor-region]'));
    editorButton.remove();
  });

  test('showing the editor after Nothing open lets go of focus lands in the editor, not the page', async () => {
    const view = render(<EditorArea {...hiddenProps} editorVisible={false} />);
    await settle();
    const nothingOpen = document.querySelector<HTMLElement>('[data-nothing-open]');
    nothingOpen?.focus();
    expect(document.activeElement).toBe(nothingOpen);

    view.rerender(<EditorArea {...hiddenProps} />);
    await settle();

    expect(document.querySelector('[data-nothing-open]')).toBeNull();
    expect(document.activeElement).toBe(document.querySelector('[data-editor-region]'));
  });

  test('showing the editor while focus is in another pane leaves it there', async () => {
    const composer = document.createElement('textarea');
    document.body.append(composer);
    const view = render(<EditorArea {...hiddenProps} agentsVisible editorVisible={false} />);
    await settle();
    composer.focus();

    view.rerender(<EditorArea {...hiddenProps} agentsVisible />);
    await settle();

    expect(document.activeElement).toBe(composer);
    composer.remove();
  });

  test('a chat divider dragged while the editor is hidden is not saved, and showing the editor restores the pre-hide widths', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const pastWidthWriteDebounceMs = 101;
      const terminalWidths: number[] = [];
      const props = {
        ...hiddenProps,
        agentsVisible: true,
        terminalVisible: true,
        terminalPlacement: 'right',
        terminalRightWidth: 400,
        onTerminalRightWidthChange: (px: number) => terminalWidths.push(px),
      } as const;
      const view = render(<EditorArea {...props} />);
      groupLayout = { 'editor-main': 40, 'terminal-column': 25, 'agents-column': 35 };
      await settle();

      fireEvent.pointerDown(terminalHandle(), { pointerId: 6 });
      act(() => {
        railPanelOnResizeById.get('terminal-column')?.({
          asPercentage: pctOfRow(400),
          inPixels: 400,
        });
      });
      act(() => {
        window.dispatchEvent(new PointerEvent('pointerup', { pointerId: 6 }));
      });
      act(() => vi.advanceTimersByTime(pastWidthWriteDebounceMs));
      expect(terminalWidths).toEqual([400]);

      view.rerender(<EditorArea {...props} editorVisible={false} />);
      await settle();
      const preferredChatPx = getInitialAgentsPanelWidth();

      fireEvent.pointerDown(agentsHandle(), { pointerId: 7 });
      groupLayout = { 'editor-main': 0, 'terminal-column': 30, 'agents-column': 70 };
      mockPanelPx = 0.7 * ROW_PX;
      act(() => {
        railPanelOnResizeById.get('terminal-column')?.({
          asPercentage: 30,
          inPixels: 0.3 * ROW_PX,
        });
      });
      act(() => {
        window.dispatchEvent(new PointerEvent('pointerup', { pointerId: 7 }));
      });
      await settle();

      expect(groupLayout).toEqual({ 'editor-main': 0, 'terminal-column': 30, 'agents-column': 70 });
      expect(localStorage.getItem(AGENTS_PANEL_WIDTH_KEY)).toBeNull();
      act(() => vi.advanceTimersByTime(pastWidthWriteDebounceMs));
      expect(terminalWidths).toEqual([400]);

      mockPanelPx = null;
      view.rerender(<EditorArea {...props} />);
      await settle();
      await act(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));

      expect(groupLayout['agents-column']).toBeCloseTo(pctOfRow(preferredChatPx));
      expect(groupLayout['terminal-column']).toBeCloseTo(pctOfRow(400));
    } finally {
      vi.useRealTimers();
    }
  });

  test('chat is marked as the only pane only while the editor is hidden and no terminal shows', async () => {
    const mount = () => document.querySelector('[data-agents-panel-mount]');
    const view = render(<EditorArea {...hiddenProps} agentsVisible />);
    groupLayout = { 'editor-main': 65, 'terminal-column': 0, 'agents-column': 35 };
    await settle();
    expect(mount()?.hasAttribute('data-chat-alone')).toBe(false);

    view.rerender(<EditorArea {...hiddenProps} agentsVisible editorVisible={false} />);
    await settle();
    expect(mount()?.hasAttribute('data-chat-alone')).toBe(true);

    view.rerender(
      <EditorArea
        {...hiddenProps}
        agentsVisible
        editorVisible={false}
        terminalVisible
        terminalPlacement="right"
      />,
    );
    await settle();
    expect(mount()?.hasAttribute('data-chat-alone')).toBe(false);
  });

  test('Nothing open appears only when the editor, chat and terminal are all hidden', async () => {
    const view = render(<EditorArea {...hiddenProps} agentsVisible editorVisible={false} />);
    await settle();
    expect(document.querySelector('[data-nothing-open]')).toBeNull();

    view.rerender(<EditorArea {...hiddenProps} editorVisible={false} />);
    await settle();
    const nothingOpen = document.querySelector('[data-nothing-open]');
    expect(nothingOpen?.parentElement).toBe(document.querySelector('[data-editor-area-panels]'));

    view.rerender(<EditorArea {...hiddenProps} />);
    await settle();
    expect(document.querySelector('[data-nothing-open]')).toBeNull();
  });

  test('hiding the last pane while focus is in the editor moves focus to Nothing open', async () => {
    const view = render(<EditorArea {...hiddenProps} />);
    const region = document.querySelector<HTMLElement>('[data-editor-region]');
    region?.focus();

    view.rerender(<EditorArea {...hiddenProps} editorVisible={false} />);
    await settle();

    expect(document.activeElement).toBe(document.querySelector('[data-nothing-open]'));
  });

  test('a column closing while the editor is hidden hands its width to the other column, not the hidden editor', async () => {
    const view = render(
      <EditorArea {...hiddenProps} agentsVisible terminalVisible terminalPlacement="right" />,
    );
    groupLayout = { 'editor-main': 40, 'terminal-column': 25, 'agents-column': 35 };
    await settle();
    view.rerender(
      <EditorArea
        {...hiddenProps}
        agentsVisible
        terminalVisible
        terminalPlacement="right"
        editorVisible={false}
      />,
    );
    await settle();

    view.rerender(
      <EditorArea
        {...hiddenProps}
        agentsVisible={false}
        terminalVisible
        terminalPlacement="right"
        editorVisible={false}
      />,
    );
    act(() => {
      railPanelOnResizeById.get('agents-column')?.({ asPercentage: 40, inPixels: 544 });
    });
    await settle();

    expect(groupLayout).toEqual({ 'editor-main': 0, 'terminal-column': 100, 'agents-column': 0 });
  });

  test('hiding the editor beside chat keeps the column that holds a bottom terminal at its share', async () => {
    const props = { ...hiddenProps, agentsVisible: true, terminalVisible: true } as const;
    groupLayout = { 'editor-main': 65, 'terminal-column': 0, 'agents-column': 35 };
    const view = render(<EditorArea {...props} terminalPlacement="bottom" />);
    groupLayout = { 'editor-main': 65, 'terminal-column': 0, 'agents-column': 35 };
    await settle();

    view.rerender(<EditorArea {...props} terminalPlacement="bottom" editorVisible={false} />);
    await settle();

    expect(groupLayout).toEqual({ 'editor-main': 65, 'terminal-column': 0, 'agents-column': 35 });
    expect(editorColumn().getAttribute('data-min-size')).toBe('5%');
    expect(document.getElementById('agents-column')?.getAttribute('data-max-size')).toBe('95%');
    expect(agentsHandle().style.display).toBe('');
  });

  test('a bottom terminal opened beside chat alone takes back the column at chat’s preferred width', async () => {
    const view = render(<EditorArea {...hiddenProps} agentsVisible editorVisible={false} />);
    groupLayout = { 'editor-main': 0, 'terminal-column': 0, 'agents-column': 100 };
    await settle();

    view.rerender(
      <EditorArea
        {...hiddenProps}
        agentsVisible
        terminalVisible
        terminalPlacement="bottom"
        editorVisible={false}
      />,
    );
    await settle();

    const chatPct = pctOfRow(getInitialAgentsPanelWidth());
    expect(Object.keys(groupSetLayoutCalls.at(-1) ?? {})).toEqual([
      'editor-main',
      'terminal-column',
      'agents-column',
    ]);
    expect(groupLayout['editor-main']).toBeCloseTo(100 - chatPct);
    expect(groupLayout['terminal-column']).toBe(0);
    expect(groupLayout['agents-column']).toBeCloseTo(chatPct);
  });

  test('chat opened beside a full-height bottom terminal takes its preferred width, not the whole row', async () => {
    const props = { ...hiddenProps, terminalVisible: true, editorVisible: false } as const;
    const view = render(<EditorArea {...props} terminalPlacement="bottom" />);
    groupLayout = { 'editor-main': 100, 'terminal-column': 0, 'agents-column': 0 };
    await settle();

    view.rerender(<EditorArea {...props} terminalPlacement="bottom" agentsVisible />);
    await settle();

    const chatPct = pctOfRow(getInitialAgentsPanelWidth());
    expect(groupLayout['editor-main']).toBeCloseTo(100 - chatPct);
    expect(groupLayout['agents-column']).toBeCloseTo(chatPct);
  });
});
