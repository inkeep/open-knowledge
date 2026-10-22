import type { HocuspocusProvider } from '@hocuspocus/provider';
import { act, cleanup, fireEvent, render as rtlRender, screen } from '@testing-library/react';
import {
  type ComponentProps,
  type CSSProperties,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { DEFAULT_DOCK_TREE, type DockNode, moveDockPane } from '@/lib/dock-tree';
import {
  __resetPaneVisibilityStoreForTests,
  type PaneId,
  type PaneVisibilityRequest,
  paneVisibilityStore,
} from '@/lib/pane-visibility-store';
import { SIDEBAR_PINS_KEY } from '@/lib/sidebar-pin-store';
import { swapEditorSidebars } from '@/lib/sidebar-side-store';
import type { PanelTab } from './DocPanel';
import type { SessionPlacements } from './EditorArea';
import { FileListHostProvider } from './FileListHost';

type SettingsDialogShellProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

let settingsRouteOpen = false;
let closeSettingsRouteMock = vi.fn(() => {});
let shellProps: SettingsDialogShellProps[] = [];
const panelOnResizeById = new Map<
  string,
  ((size: { asPercentage: number; inPixels: number }) => void) | null
>();

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

vi.doMock('@/components/EditorSkeleton', () => ({
  EditorSkeleton: () => <div data-testid="editor-skeleton" />,
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

type MockLayout = Record<string, number>;

const INNER_LAYOUT_DOC_CLOSED: MockLayout = { 'workspace-main': 100, 'doc-panel': 0 };
const WORKSPACE_WIDTH_PX = 1360;
const WORKSPACE_HEIGHT_PX = 800;
let innerLayout: MockLayout = { ...INNER_LAYOUT_DOC_CLOSED };
let innerSetLayoutCalls: MockLayout[] = [];
let innerSetLayoutPx: number[] = [];
let innerOnLayoutChange: ((layout: MockLayout) => void) | null = null;
let panelIsCollapsed = false;
let mockEditorUnitPx = 1360;
let mockFileListPx = 0;
let mockPanelPercentage: number | null = null;
let mockPanelPx: number | null = null;
let deliverDocPanelResizeAfterLayout = false;
let refuseNextInnerLayoutWrite = false;
let refuseInnerLayoutWrites = false;
let innerLayoutWriteError: Error | null = null;
let innerLayoutReads = 0;
let lastDeliveredDocPanelSize: { asPercentage: number; inPixels: number } | null = null;

beforeEach(() => {
  mockPanelPercentage = null;
  mockPanelPx = null;
  innerLayout = { ...INNER_LAYOUT_DOC_CLOSED };
  innerSetLayoutCalls = [];
  innerSetLayoutPx = [];
  innerOnLayoutChange = null;
  deliverDocPanelResizeAfterLayout = false;
  refuseNextInnerLayoutWrite = false;
  refuseInnerLayoutWrites = false;
  innerLayoutWriteError = null;
  innerLayoutReads = 0;
  lastDeliveredDocPanelSize = null;
  mockFileListPx = 0;
  conflictedDocName = null;
  const measure = HTMLElement.prototype.getBoundingClientRect;
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement,
  ) {
    if (!this.hasAttribute('data-dock-workspace')) return measure.call(this);
    return {
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: WORKSPACE_WIDTH_PX,
      bottom: WORKSPACE_HEIGHT_PX,
      width: WORKSPACE_WIDTH_PX,
      height: WORKSPACE_HEIGHT_PX,
      toJSON() {},
    } as DOMRect;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
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

function innerRowPx(): number {
  return Math.max(0, mockEditorUnitPx - mockFileListPx);
}

function mockedPanelWidthPx(element: HTMLElement): number {
  if (element.id !== '') return ((innerLayout[element.id] ?? 0) / 100) * innerRowPx();
  let claimedPercentage = 0;
  for (const sibling of element.parentElement?.querySelectorAll<HTMLElement>(
    ':scope > [data-panel]',
  ) ?? []) {
    if (sibling.id !== '') claimedPercentage += innerLayout[sibling.id] ?? 0;
  }
  return (Math.max(0, 100 - claimedPercentage) / 100) * innerRowPx();
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

function docPanelSizeFromRow() {
  const pct = innerLayout['doc-panel'] ?? 0;
  return { asPercentage: pct, inPixels: (pct / 100) * innerRowPx() };
}

const innerGroupHandle = {
  getLayout: () => {
    innerLayoutReads += 1;
    return innerLayout;
  },
  setLayout: (layout: MockLayout) => {
    innerSetLayoutCalls.push(layout);
    innerSetLayoutPx.push(innerRowPx());
    if (innerLayoutWriteError !== null) throw innerLayoutWriteError;
    if (refuseInnerLayoutWrites) return;
    if (refuseNextInnerLayoutWrite) {
      refuseNextInnerLayoutWrite = false;
      return;
    }
    innerLayout = layout;
    if (!deliverDocPanelResizeAfterLayout) return;
    const size = docPanelSizeFromRow();
    if (
      lastDeliveredDocPanelSize?.asPercentage === size.asPercentage &&
      lastDeliveredDocPanelSize.inPixels === size.inPixels
    ) {
      return;
    }
    lastDeliveredDocPanelSize = size;
    panelIsCollapsed = size.asPercentage === 0;
    panelOnResizeById.get('doc-panel')?.(size);
  },
};

vi.doMock('react-resizable-panels', () => ({
  usePanelRef: () => ({
    current: {
      collapse: () => {},
      expand: () => {},
      getSize: () => {
        const fromRow = docPanelSizeFromRow();
        return {
          asPercentage: mockPanelPercentage ?? fromRow.asPercentage,
          inPixels: mockPanelPx ?? fromRow.inPixels,
        };
      },
      isCollapsed: () =>
        deliverDocPanelResizeAfterLayout ? innerLayout['doc-panel'] === 0 : panelIsCollapsed,
    },
  }),
  useGroupRef: () => useRef<typeof innerGroupHandle | null>(null),
}));

vi.doMock('@/components/ui/resizable', () => ({
  ResizablePanelGroup: ({
    children,
    onLayoutChange,
    groupRef,
    'data-editor-row': row,
    'data-dragging': dragging,
  }: {
    children: ReactNode;
    onLayoutChange?: (layout: MockLayout) => void;
    groupRef?: { current: typeof innerGroupHandle | null };
    'data-editor-row'?: string;
    'data-dragging'?: boolean;
  }) => {
    if (groupRef != null) groupRef.current = innerGroupHandle;
    innerOnLayoutChange = onLayoutChange ?? null;
    return (
      <div
        data-testid="resizable-group-inner"
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
    if (id != null) panelOnResizeById.set(id, onResize ?? null);
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
      // oxlint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- mirrors react-resizable-panels' Separator, which renders tabIndex 0; a focusable separator is a widget.
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

const { EditorArea: DockedEditorArea } = await import('./EditorArea');
const { SidebarProvider } = await import('@/components/ui/sidebar');
const { TooltipProvider } = await import('@/components/ui/tooltip');
const { SingleFileModeProvider } = await import('@/lib/single-file-mode');
const { emitLocalMenuAction } = await import('@/lib/local-menu-action-bus');
const { requestDocPanelTab } = await import('./doc-panel-events');

const RIGHT_TERMINAL_TREE = moveDockPane(DEFAULT_DOCK_TREE, 'terminal', 'editor', 'end', 0.3);

type DockedEditorAreaProps = ComponentProps<typeof DockedEditorArea>;
type EditorAreaProps = Omit<DockedEditorAreaProps, 'dockTree' | 'onDockTreeChange'> &
  Partial<Pick<DockedEditorAreaProps, 'dockTree' | 'onDockTreeChange'>>;

function EditorArea({
  dockTree = DEFAULT_DOCK_TREE,
  onDockTreeChange = () => {},
  ...props
}: EditorAreaProps) {
  return <DockedEditorArea dockTree={dockTree} onDockTreeChange={onDockTreeChange} {...props} />;
}

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

function dockUnit(pane: PaneId): HTMLElement {
  const unit = document.querySelector<HTMLElement>(`[data-dock-unit="${pane}"]`);
  if (unit == null) throw new Error(`the ${pane} unit is absent`);
  return unit;
}

function unitPx(
  pane: PaneId,
  property: 'width' | 'height' | 'insetInlineStart' | 'insetBlockStart',
): number {
  return Number.parseFloat(dockUnit(pane).style[property]);
}

function dockSeam(name: string): HTMLElement {
  const seam = screen.getByRole('separator', { name });
  if (!seam.hasAttribute('data-dock-seam')) throw new Error(`${name} is not a dock seam`);
  return seam;
}

function paneCard(pane: PaneId): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-slot="pane-card"][data-pane="${pane}"]`);
}

function terminalMount(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-terminal-panel-mount]');
}

function agentsMount(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-agents-panel-mount]');
}

const flushFrame = () =>
  act(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));

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

  test('places the terminal unit beside the empty state when a terminal bridge is present', () => {
    render(
      <EditorArea
        editorMode="wysiwyg"
        onModeChange={() => {}}
        activeTab="timeline"
        onActiveTabChange={() => {}}
        terminalBridge={{} as never}
        terminalVisible
      />,
    );

    const emptyState = screen.getByTestId('empty-editor-state');
    expect(dockUnit('editor').contains(emptyState)).toBe(true);
    expect(emptyState.getAttribute('data-terminal-open')).toBe('true');
    expect(emptyState.getAttribute('data-agents-open')).toBe('false');
    expect(dockUnit('terminal').hidden).toBe(false);
    expect(dockUnit('terminal').contains(terminalMount())).toBe(true);
  });

  test('collapses the empty state to the header-only view when the agents panel is open', () => {
    render(
      <EditorArea
        editorMode="wysiwyg"
        onModeChange={() => {}}
        activeTab="timeline"
        onActiveTabChange={() => {}}
        agentsVisible
      />,
    );

    const emptyState = screen.getByTestId('empty-editor-state');
    expect(emptyState.getAttribute('data-agents-open')).toBe('true');
    expect(emptyState.getAttribute('data-terminal-open')).toBe('false');
  });

  test('renders the empty state with no terminal unit on the web host', () => {
    render(
      <EditorArea
        editorMode="wysiwyg"
        onModeChange={() => {}}
        activeTab="timeline"
        onActiveTabChange={() => {}}
      />,
    );

    expect(dockUnit('terminal').hidden).toBe(true);
    expect(terminalMount()).toBeNull();
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
        dockTree={RIGHT_TERMINAL_TREE}
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
      />,
    );

    const emptyState = screen.getByTestId('empty-editor-state');
    expect(emptyState.getAttribute('data-terminal-open')).toBe('false');
    expect(emptyState.getAttribute('data-bottom-dock-open')).toBe('false');
  });
});

describe('EditorArea document panel slot', () => {
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
  } as const;

  const pctOf = (px: number) => (px / mockEditorUnitPx) * 100;

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

  const exhaustionReports = () => {
    const reports: Record<string, unknown>[] = [];
    vi.spyOn(console, 'warn').mockImplementation((message: unknown) => {
      const text = String(message);
      if (!text.startsWith('{')) return;
      const report = JSON.parse(text) as Record<string, unknown>;
      if (report.event === 'rail-layout-retry-exhausted') reports.push(report);
    });
    return reports;
  };

  const BLOCKED_INNER_ROW: MockLayout = { 'workspace-main': 100 };

  const expectPinRetryWaitingOnAFrame = (frames: ReturnType<typeof controlAnimationFrames>) => {
    const reads = innerLayoutReads;
    frames.run(frames.pendingCount());
    expect(innerLayoutReads).toBeGreaterThan(reads);
  };

  beforeEach(() => {
    cleanup();
    localStorage.clear();
    docCtx = EMPTY_DOC_CTX;
    panelIsCollapsed = false;
    mockEditorUnitPx = 1360;
  });

  test('opens the collapsed doc panel from the toggle', () => {
    setViewportWidth(1024);
    docCtx = DOC_LIVE_CTX;
    render(<EditorArea {...baseProps} />);
    innerSetLayoutCalls = [];

    act(() => emitLocalMenuAction('toggle-doc-panel'));

    const correctedInner = innerSetLayoutCalls.at(-1);
    expect(correctedInner?.['doc-panel']).toBeCloseTo(pctOf(320), 3);
    expect(lastInnerWritePx('doc-panel')).toBeCloseTo(320, 3);
    expect(correctedInner?.['workspace-main']).toBeCloseTo(100 - pctOf(320), 3);
  });

  test('a second toggle re-opens the doc panel the first toggle collapsed', () => {
    setViewportWidth(1400);
    docCtx = DOC_LIVE_CTX;
    render(<EditorArea {...baseProps} />);
    innerLayout = { 'workspace-main': 75, 'doc-panel': 25 };
    innerSetLayoutCalls = [];

    act(() => emitLocalMenuAction('toggle-doc-panel'));
    expect(innerSetLayoutCalls.at(-1)?.['doc-panel']).toBe(0);

    act(() => emitLocalMenuAction('toggle-doc-panel'));
    expect(innerSetLayoutCalls.at(-1)?.['doc-panel']).toBeCloseTo(pctOf(320), 3);
    expect(lastInnerWritePx('doc-panel')).toBeCloseTo(320, 3);
  });

  test('showing or hiding the agents pane keeps the side panel at its pixel width', async () => {
    setViewportWidth(1400);
    docCtx = DOC_LIVE_CTX;
    innerLayout = innerRowWithDoc(320, 1360);
    const view = render(<EditorArea {...baseProps} />);
    await act(async () => {});

    innerSetLayoutCalls = [];
    mockEditorUnitPx = 966;
    view.rerender(<EditorArea {...baseProps} agentsVisible />);
    await act(async () => {});
    expect(lastInnerWritePx('doc-panel')).toBeCloseTo(320, 3);

    innerSetLayoutCalls = [];
    mockEditorUnitPx = 1360;
    view.rerender(<EditorArea {...baseProps} />);
    await act(async () => {});
    expect(lastInnerWritePx('doc-panel')).toBeCloseTo(320, 3);
    expect(renderedInnerPanelIds()).toEqual(['doc-panel']);
  });

  test('showing or hiding the agents pane keeps a hidden side panel hidden', async () => {
    setViewportWidth(1400);
    docCtx = DOC_LIVE_CTX;
    innerLayout = innerRowWithDoc(320, 1360);
    const view = render(<EditorArea {...baseProps} />);
    await act(async () => {});
    act(() => emitLocalMenuAction('toggle-doc-panel'));
    expect(innerLayout['doc-panel']).toBe(0);
    const editorWidth = unitPx('editor', 'width');

    mockEditorUnitPx = 966;
    view.rerender(<EditorArea {...baseProps} agentsVisible />);
    await act(async () => {});
    expect(unitPx('editor', 'width')).toBeLessThan(editorWidth);
    expect(innerLayout['doc-panel']).toBe(0);

    mockEditorUnitPx = 1360;
    view.rerender(<EditorArea {...baseProps} />);
    await act(async () => {});
    expect(unitPx('editor', 'width')).toBe(editorWidth);
    expect(innerLayout['doc-panel']).toBe(0);
  });

  test('the side panel row keeps one panel-ID set from a document to a new tab', () => {
    setViewportWidth(1400);
    docCtx = DOC_LIVE_CTX;
    const view = render(<EditorArea {...baseProps} agentsVisible />);
    expect(renderedInnerPanelIds()).toEqual(['doc-panel']);

    docCtx = EMPTY_DOC_CTX;
    view.rerender(<EditorArea {...baseProps} agentsVisible />);

    expect(renderedInnerPanelIds()).toEqual(['doc-panel']);
    expect(document.getElementById('doc-panel')?.textContent).toBe('');
  });

  test('the side panel row keeps one panel-ID set across every view kind', () => {
    setViewportWidth(1400);
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
      expect(renderedInnerPanelIds()).toEqual(['doc-panel']);
    }
  });

  test('an empty slot is clamped out of flex flow', () => {
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
    expect(renderedInnerPanelIds()).toEqual(['doc-panel']);
    expect(document.getElementById('doc-panel')?.childElementCount).toBe(1);
    window.location.hash = '';
  });

  test('a document arriving opens the side panel even when the first write is refused', async () => {
    setViewportWidth(1400);
    const view = render(<EditorArea {...baseProps} />);
    await act(async () => {});
    innerSetLayoutCalls = [];

    refuseNextInnerLayoutWrite = true;
    docCtx = DOC_LIVE_CTX;
    view.rerender(<EditorArea {...baseProps} />);
    await act(async () => {});
    await flushFrame();

    expect(innerSetLayoutCalls.length).toBeGreaterThanOrEqual(2);
    expect(lastInnerWritePx('doc-panel')).toBeCloseTo(320, 3);
    expect(((innerLayout['doc-panel'] ?? 0) / 100) * innerRowPx()).toBeCloseTo(320, 3);
  });

  test('a side panel pin that never lands reports the width it aimed for and the width it got', async () => {
    setViewportWidth(1400);
    const view = render(<EditorArea {...baseProps} />);
    await act(async () => {});
    const reports = exhaustionReports();
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      callback(performance.now());
      return 1;
    });

    refuseInnerLayoutWrites = true;
    docCtx = DOC_LIVE_CTX;
    view.rerender(<EditorArea {...baseProps} />);
    await act(async () => {});

    expect(reports).toEqual([
      expect.objectContaining({
        decision: 'sync-doc-presence',
        targetWidthPx: 320,
        cause: 'width-missed',
        pinnedWidthPx: 320,
        landedWidthPx: 0,
      }),
    ]);
  });

  test('a side panel pin whose write keeps throwing reports the error it threw', async () => {
    setViewportWidth(1400);
    const view = render(<EditorArea {...baseProps} />);
    await act(async () => {});
    const reports = exhaustionReports();
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      callback(performance.now());
      return 1;
    });

    innerLayoutWriteError = new Error('Layout not found for Panel doc-panel');
    docCtx = DOC_LIVE_CTX;
    view.rerender(<EditorArea {...baseProps} />);
    await act(async () => {});

    expect(reports).toEqual([
      expect.objectContaining({
        decision: 'sync-doc-presence',
        cause: 'write-threw',
        writeError: 'Layout not found for Panel doc-panel',
      }),
    ]);
  });

  test('a side panel pin that stays blocked reports once at its deadline, with no frame to run', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    setViewportWidth(1400);
    const frames = controlAnimationFrames();
    const reports = exhaustionReports();
    try {
      const view = render(<EditorArea {...baseProps} />);
      innerLayout = { ...BLOCKED_INNER_ROW };
      docCtx = DOC_LIVE_CTX;
      view.rerender(<EditorArea {...baseProps} />);
      expectPinRetryWaitingOnAFrame(frames);
      expect(reports).toEqual([]);

      act(() => vi.advanceTimersByTime(60_000));

      expect(reports).toEqual([
        expect.objectContaining({
          decision: 'sync-doc-presence',
          cause: 'layout-without-doc-panel',
        }),
      ]);
      frames.run(frames.pendingCount(), 61_000);
      act(() => vi.advanceTimersByTime(60_000));
      expect(reports).toHaveLength(1);
    } finally {
      cleanup();
      frames.restore();
      vi.useRealTimers();
    }
  });

  test('a newer side panel change replaces a pin still waiting on a frame', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    setViewportWidth(1400);
    const frames = controlAnimationFrames();
    const reports = exhaustionReports();
    try {
      const view = render(<EditorArea {...baseProps} />);
      innerLayout = { ...BLOCKED_INNER_ROW };
      docCtx = DOC_LIVE_CTX;
      view.rerender(<EditorArea {...baseProps} />);
      expectPinRetryWaitingOnAFrame(frames);

      innerLayout = { 'workspace-main': 100, 'doc-panel': 0 };
      docCtx = EMPTY_DOC_CTX;
      view.rerender(<EditorArea {...baseProps} />);
      frames.run(frames.pendingCount(), 61_000);
      act(() => vi.advanceTimersByTime(60_000));

      expect(reports).toEqual([]);
    } finally {
      cleanup();
      frames.restore();
      vi.useRealTimers();
    }
  });

  test('unmounting cancels a side panel pin still waiting on a frame', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    setViewportWidth(1400);
    const frames = controlAnimationFrames();
    const reports = exhaustionReports();
    try {
      const view = render(<EditorArea {...baseProps} />);
      innerLayout = { ...BLOCKED_INNER_ROW };
      docCtx = DOC_LIVE_CTX;
      view.rerender(<EditorArea {...baseProps} />);
      expectPinRetryWaitingOnAFrame(frames);

      act(() => view.unmount());
      frames.run(frames.pendingCount(), 61_000);
      act(() => vi.advanceTimersByTime(60_000));

      expect(reports).toEqual([]);
    } finally {
      frames.restore();
      vi.useRealTimers();
    }
  });

  test('a side panel pin waits out a handle drag without writing or spending its retries, then lands', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    setViewportWidth(1400);
    const frames = controlAnimationFrames();
    const reports = exhaustionReports();
    try {
      const failing = render(<EditorArea {...baseProps} />);
      refuseInnerLayoutWrites = true;
      docCtx = DOC_LIVE_CTX;
      failing.rerender(<EditorArea {...baseProps} />);
      const FAILING_PIN_FRAME_CEILING = 10_000;
      let framesToGiveUp = 0;
      while (reports.length === 0 && frames.pendingCount() > 0) {
        if (framesToGiveUp === FAILING_PIN_FRAME_CEILING) {
          throw new Error(
            `a pin whose writes are refused was still retrying after ${FAILING_PIN_FRAME_CEILING} frames`,
          );
        }
        frames.run(1, 0);
        framesToGiveUp += 1;
      }
      expect(reports).toHaveLength(1);
      failing.unmount();
      reports.length = 0;
      refuseInnerLayoutWrites = false;

      innerLayout = innerRowWithDoc(320, 1360);
      const view = render(<EditorArea {...baseProps} />);
      const handle = document.getElementById('doc-panel')?.previousElementSibling;
      if (!(handle instanceof HTMLElement)) throw new Error('doc-panel resize handle not found');
      act(() => {
        fireEvent.pointerDown(handle, { pointerId: 1 });
      });
      innerSetLayoutCalls = [];

      docCtx = EMPTY_DOC_CTX;
      view.rerender(<EditorArea {...baseProps} />);
      frames.run(framesToGiveUp + 5, 0);
      expect(innerSetLayoutCalls).toEqual([]);
      expect(reports).toEqual([]);

      refuseInnerLayoutWrites = true;
      act(() => {
        fireEvent.pointerUp(window, { pointerId: 1 });
      });
      frames.run(1);
      expect(innerSetLayoutCalls.length).toBeGreaterThan(0);
      expect(reports).toEqual([]);

      refuseInnerLayoutWrites = false;
      frames.run(5);
      act(() => vi.advanceTimersByTime(60_000));

      expect(lastInnerWritePx('doc-panel')).toBe(0);
      expect(innerLayout['doc-panel']).toBe(0);
      expect(reports).toEqual([]);
    } finally {
      cleanup();
      frames.restore();
      vi.useRealTimers();
    }
  });

  test('emptying the slot hands its width to the editor; refilling takes it back', async () => {
    setViewportWidth(1400);
    docCtx = DOC_LIVE_CTX;
    const view = render(<EditorArea {...baseProps} />);
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
    render(<EditorArea {...baseProps} agentsVisible />);
    innerSetLayoutCalls = [];
    innerLayout = { 'workspace-main': 75, 'doc-panel': 25 };

    act(() => emitLocalMenuAction('toggle-doc-panel'));
    await act(async () => {});

    expect(innerSetLayoutCalls).toHaveLength(0);
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

describe('EditorArea dock units', () => {
  const unitProps = {
    editorMode: 'wysiwyg',
    onModeChange: () => {},
    activeTab: 'timeline',
    onActiveTabChange: () => {},
    terminalBridge: {} as never,
  } as const;

  beforeEach(() => {
    cleanup();
    localStorage.clear();
    docCtx = DOC_LIVE_CTX;
    editorWorkspaceMounts = 0;
  });

  test('places a bottom terminal under the editor, with chat beside the column', () => {
    render(<EditorArea {...unitProps} terminalVisible agentsVisible />);

    expect(unitPx('editor', 'insetInlineStart')).toBe(0);
    expect(unitPx('terminal', 'insetInlineStart')).toBe(0);
    expect(unitPx('terminal', 'insetBlockStart')).toBeGreaterThan(unitPx('editor', 'height'));
    expect(unitPx('terminal', 'width')).toBe(unitPx('editor', 'width'));
    expect(unitPx('agents', 'insetInlineStart')).toBeGreaterThan(unitPx('editor', 'width'));
    expect(unitPx('agents', 'height')).toBe(WORKSPACE_HEIGHT_PX);
    expect(paneCard('terminal')?.getAttribute('data-placement')).toBe('bottom');
  });

  test('places a right terminal between the editor and chat', () => {
    const placements: SessionPlacements[] = [];
    render(
      <EditorArea
        {...unitProps}
        dockTree={RIGHT_TERMINAL_TREE}
        terminalVisible
        agentsVisible
        onSessionPlacements={(value) => placements.push(value)}
      />,
    );

    const editorEnd = unitPx('editor', 'insetInlineStart') + unitPx('editor', 'width');
    const terminalStart = unitPx('terminal', 'insetInlineStart');
    const terminalEnd = terminalStart + unitPx('terminal', 'width');
    expect(terminalStart).toBeGreaterThan(editorEnd);
    expect(unitPx('agents', 'insetInlineStart')).toBeGreaterThan(terminalEnd);
    expect(unitPx('terminal', 'height')).toBe(WORKSPACE_HEIGHT_PX);
    expect(paneCard('terminal')?.getAttribute('data-placement')).toBe('right');
    expect(placements.at(-1)?.terminal.container).toBe(terminalMount());
    expect(placements.at(-1)?.terminal.isShowing).toBe(true);
  });

  test('a right terminal and chat are their own cards in their own units, outside the editor card', () => {
    render(
      <TooltipProvider>
        <EditorArea {...unitProps} dockTree={RIGHT_TERMINAL_TREE} terminalVisible agentsVisible />
      </TooltipProvider>,
    );

    const editorCard = paneCard('editor');
    const terminalCard = paneCard('terminal');
    const chatCard = paneCard('agents');
    expect(terminalCard?.getAttribute('data-variant')).toBe('card');
    expect(chatCard?.getAttribute('data-variant')).toBe('card');
    expect(dockUnit('editor').contains(editorCard)).toBe(true);
    expect(dockUnit('terminal').contains(terminalCard)).toBe(true);
    expect(dockUnit('agents').contains(chatCard)).toBe(true);
    expect(terminalCard?.contains(terminalMount())).toBe(true);
    expect(chatCard?.contains(agentsMount())).toBe(true);
    expect(editorCard?.contains(terminalCard)).toBe(false);
    expect(editorCard?.contains(chatCard)).toBe(false);
  });

  test('without a terminal, as on the web, the terminal unit stays hidden and draws no card', () => {
    render(
      <TooltipProvider>
        <EditorArea {...unitProps} terminalBridge={undefined} agentsVisible terminalVisible />
      </TooltipProvider>,
    );

    expect(paneCard('terminal')).toBeNull();
    expect(terminalMount()).toBeNull();
    expect(dockUnit('terminal').hidden).toBe(true);
    expect(paneCard('agents')).not.toBeNull();
    expect(unitPx('agents', 'height')).toBe(WORKSPACE_HEIGHT_PX);
    expect(unitPx('editor', 'height')).toBe(WORKSPACE_HEIGHT_PX);
  });

  test('pane mounts are inert while their panes are off', () => {
    render(<EditorArea {...unitProps} />);

    expect(agentsMount()?.hasAttribute('inert')).toBe(true);
    expect(terminalMount()?.hasAttribute('inert')).toBe(true);
    expect(dockUnit('agents').hidden).toBe(true);
    expect(dockUnit('terminal').hidden).toBe(true);
  });

  test('pane mounts stay focusable while their panes are on', () => {
    render(<EditorArea {...unitProps} agentsVisible terminalVisible />);

    expect(agentsMount()?.hasAttribute('inert')).toBe(false);
    expect(terminalMount()?.hasAttribute('inert')).toBe(false);
    expect(dockUnit('agents').hasAttribute('inert')).toBe(false);
    expect(dockUnit('terminal').hasAttribute('inert')).toBe(false);
  });

  test('a pane reports that it is showing only while it is on', () => {
    const placements: SessionPlacements[] = [];
    const area = (agentsVisible: boolean, terminalVisible: boolean) => (
      <EditorArea
        {...unitProps}
        agentsVisible={agentsVisible}
        terminalVisible={terminalVisible}
        onSessionPlacements={(value) => placements.push(value)}
      />
    );
    const view = render(area(true, true));
    expect(placements.at(-1)?.agents.isShowing).toBe(true);
    expect(placements.at(-1)?.terminal.isShowing).toBe(true);

    view.rerender(area(false, true));
    expect(placements.at(-1)?.agents.isShowing).toBe(false);
    expect(placements.at(-1)?.agents.container).toBe(agentsMount());
    expect(placements.at(-1)?.terminal.isShowing).toBe(true);

    view.rerender(area(false, false));
    expect(placements.at(-1)?.terminal.isShowing).toBe(false);
    expect(placements.at(-1)?.terminal.container).toBe(terminalMount());

    view.rerender(area(true, true));
    expect(placements.at(-1)?.agents.isShowing).toBe(true);
    expect(placements.at(-1)?.terminal.isShowing).toBe(true);
  });

  test('moving or hiding the terminal, and showing or hiding chat, never remounts the open editor', () => {
    const { rerender } = render(
      <TooltipProvider>
        <EditorArea {...unitProps} terminalVisible agentsVisible={false} />
      </TooltipProvider>,
    );
    const tabs = screen.getByTestId('workspace-tabs');
    const editorRegion = document.querySelector('[data-editor-region]');
    const terminal = terminalMount();
    const chat = agentsMount();
    expect(editorWorkspaceMounts).toBe(1);

    const steps: Array<{
      terminalVisible: boolean;
      dockTree: DockNode;
      agentsVisible: boolean;
    }> = [
      { terminalVisible: true, dockTree: RIGHT_TERMINAL_TREE, agentsVisible: false },
      { terminalVisible: true, dockTree: RIGHT_TERMINAL_TREE, agentsVisible: true },
      { terminalVisible: false, dockTree: RIGHT_TERMINAL_TREE, agentsVisible: true },
      { terminalVisible: true, dockTree: DEFAULT_DOCK_TREE, agentsVisible: true },
      { terminalVisible: false, dockTree: DEFAULT_DOCK_TREE, agentsVisible: false },
      { terminalVisible: true, dockTree: DEFAULT_DOCK_TREE, agentsVisible: false },
    ];
    for (const step of steps) {
      rerender(
        <TooltipProvider>
          <EditorArea {...unitProps} {...step} />
        </TooltipProvider>,
      );
    }
    act(() => emitLocalMenuAction('toggle-doc-panel'));
    act(() => emitLocalMenuAction('toggle-doc-panel'));

    expect(editorWorkspaceMounts).toBe(1);
    expect(screen.getByTestId('workspace-tabs')).toBe(tabs);
    expect(document.querySelector('[data-editor-region]')).toBe(editorRegion);
    expect(terminalMount()).toBe(terminal);
    expect(agentsMount()).toBe(chat);
    expect(screen.getByRole('main').contains(tabs)).toBe(true);
  });
});

describe('EditorArea dock seams', () => {
  const seamProps = {
    editorMode: 'wysiwyg',
    onModeChange: () => {},
    activeTab: 'timeline',
    onActiveTabChange: () => {},
    terminalBridge: {} as never,
  } as const;

  beforeEach(() => {
    cleanup();
    localStorage.clear();
    docCtx = DOC_LIVE_CTX;
  });

  test('names each seam for the pane it resizes, next to the side panel separator', () => {
    render(<EditorArea {...seamProps} agentsVisible terminalVisible />);

    expect(
      screen
        .getByRole('separator', { name: 'Resize document panel' })
        .getAttribute('aria-controls'),
    ).toBe('doc-panel');
    expect(dockSeam('Resize Agents').getAttribute('aria-controls')).toBe(dockUnit('agents').id);
    expect(dockSeam('Resize Agents').getAttribute('aria-orientation')).toBe('vertical');
    expect(dockSeam('Resize Terminal').getAttribute('aria-controls')).toBe(dockUnit('terminal').id);
    expect(dockSeam('Resize Terminal').getAttribute('aria-orientation')).toBe('horizontal');
  });

  test('a pane that is off takes its seam with it', () => {
    render(<EditorArea {...seamProps} agentsVisible />);

    expect(dockSeam('Resize Agents')).toBeTruthy();
    expect(screen.queryByRole('separator', { name: 'Resize Terminal' })).toBeNull();
  });

  test('a seam reports the resized tree, and the panes follow it', () => {
    function DockHost() {
      const [tree, setTree] = useState<DockNode>(DEFAULT_DOCK_TREE);
      return (
        <EditorArea
          {...seamProps}
          agentsVisible
          terminalVisible
          dockTree={tree}
          onDockTreeChange={(update) => {
            const next = update(tree);
            trees.push(next);
            setTree(next);
          }}
        />
      );
    }
    const trees: DockNode[] = [];
    render(<DockHost />);
    const agentsWidth = unitPx('agents', 'width');

    fireEvent.keyDown(dockSeam('Resize Agents'), { key: 'ArrowLeft' });

    expect(trees).toHaveLength(1);
    expect(unitPx('agents', 'width')).toBe(agentsWidth + 16);
  });

  test('a seam that resizes the editor re-pins the side panel at its pixel width without waiting for a frame', () => {
    Object.defineProperty(window, 'innerWidth', {
      value: 1400,
      configurable: true,
      writable: true,
    });
    mockEditorUnitPx = 1360;
    innerLayout = innerRowWithDoc(320, 1360);
    function DockHost() {
      const [tree, setTree] = useState<DockNode>(DEFAULT_DOCK_TREE);
      return <EditorArea {...seamProps} agentsVisible dockTree={tree} onDockTreeChange={setTree} />;
    }
    render(<DockHost />);
    innerSetLayoutCalls = [];

    mockEditorUnitPx = 1360 - 16;
    fireEvent.keyDown(dockSeam('Resize Agents'), { key: 'ArrowLeft' });

    expect(innerSetLayoutCalls.length).toBeGreaterThan(0);
    expect(lastInnerWritePx('doc-panel')).toBeCloseTo(320, 3);
  });

  test('a seam drag marks the dock workspace and not the side panel row', () => {
    render(<EditorArea {...seamProps} agentsVisible />);
    const workspace = document.querySelector('[data-dock-workspace]');
    const seam = dockSeam('Resize Agents');

    fireEvent.pointerDown(seam, { pointerId: 3, button: 0, clientX: 900 });

    expect(workspace?.hasAttribute('data-dragging')).toBe(true);
    expect(screen.getByTestId('resizable-group-inner').hasAttribute('data-dragging')).toBe(false);
    fireEvent.pointerUp(seam, { pointerId: 3, clientX: 900 });
    expect(workspace?.hasAttribute('data-dragging')).toBe(false);
  });
});

describe('EditorArea terminal unit across view kinds', () => {
  const viewKinds = [
    { name: 'folder', ctx: FOLDER_DOC_CTX, content: 'folder-overview' },
    { name: 'large-file', ctx: LARGE_FILE_DOC_CTX, content: 'large-file-state' },
    { name: 'asset', ctx: ASSET_DOC_CTX, content: 'asset-preview' },
  ] as const;

  beforeEach(() => {
    cleanup();
  });

  test.each(viewKinds)(
    'places the terminal unit beside the $name view when a bridge is present',
    ({ ctx, content }) => {
      docCtx = ctx;
      render(
        <EditorArea
          editorMode="wysiwyg"
          onModeChange={() => {}}
          activeTab="timeline"
          onActiveTabChange={() => {}}
          terminalBridge={{} as never}
          terminalVisible
        />,
      );

      expect(dockUnit('editor').contains(screen.getByTestId(content))).toBe(true);
      expect(dockUnit('terminal').hidden).toBe(false);
      expect(dockUnit('terminal').contains(terminalMount())).toBe(true);
    },
  );

  test.each(viewKinds)(
    'renders the $name view with no terminal unit on the web host',
    ({ ctx, content }) => {
      docCtx = ctx;
      renderEditorArea();

      expect(dockUnit('editor').contains(screen.getByTestId(content))).toBe(true);
      expect(dockUnit('terminal').hidden).toBe(true);
      expect(terminalMount()).toBeNull();
    },
  );

  test('keeps the same terminal mount while the active view kind changes', () => {
    docCtx = FOLDER_DOC_CTX;
    const props = {
      editorMode: 'wysiwyg' as const,
      onModeChange: () => {},
      activeTab: 'timeline' as const,
      onActiveTabChange: () => {},
      terminalBridge: {} as never,
      terminalVisible: true,
    };
    const { rerender } = render(<EditorArea {...props} />);
    const mount = terminalMount();
    expect(mount).not.toBeNull();

    for (const { ctx, content } of [...viewKinds].reverse()) {
      docCtx = ctx;
      rerender(<EditorArea {...props} />);
      expect(dockUnit('editor').contains(screen.getByTestId(content))).toBe(true);
      expect(terminalMount()).toBe(mount);
    }
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
      />,
    );

    const skeleton = screen.getByTestId('editor-skeleton');
    expect(skeleton.closest('[data-editor-workspace-column]')).not.toBeNull();
    expect(skeleton.closest('[data-slot="pane-card"][data-pane="editor"]')).not.toBeNull();
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
    window.location.hash = '';
    docCtx = FOLDER_LIVE_CTX;
  });
  afterEach(() => {
    window.location.hash = '';
  });

  test('keeps the terminal mount when a tab close/switch transiently nulls the provider', () => {
    const props = {
      editorMode: 'wysiwyg' as const,
      onModeChange: () => {},
      activeTab: 'timeline' as const,
      onActiveTabChange: () => {},
      terminalBridge: {} as never,
      terminalVisible: true,
    };
    const { rerender } = render(<EditorArea {...props} />);
    const mount = terminalMount();
    expect(mount).not.toBeNull();
    expect(dockUnit('editor').contains(screen.getByTestId('folder-overview'))).toBe(true);

    act(() => {
      docCtx = DOC_COLD_CTX;
      window.location.hash = '#/some-doc';
    });
    rerender(<EditorArea {...props} />);

    expect(dockUnit('editor').contains(screen.getByTestId('editor-skeleton'))).toBe(true);
    expect(terminalMount()).toBe(mount);
    expect(dockUnit('terminal').hidden).toBe(false);
  });

  test('web host keeps chat on screen through a mid-session cold nav, with the skeleton in the document area', () => {
    const webProps = {
      editorMode: 'wysiwyg' as const,
      onModeChange: () => {},
      activeTab: 'timeline' as const,
      onActiveTabChange: () => {},
      agentsVisible: true,
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
        value: () => ({ width: innerRowPx(), height: 0, top: 0, left: 0 }),
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
    innerLayout = { ...INNER_LAYOUT_DOC_CLOSED };
    mockEditorUnitPx = 1360;
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
  } as const;
  const setViewportWidth = (px: number) => {
    Object.defineProperty(window, 'innerWidth', { value: px, configurable: true, writable: true });
  };
  const docHandle = () => {
    const handle = document.getElementById('doc-panel')?.previousElementSibling;
    if (!(handle instanceof HTMLElement)) throw new Error('doc-panel resize handle not found');
    return handle;
  };

  beforeEach(() => {
    cleanup();
    localStorage.clear();
    docCtx = EMPTY_DOC_CTX;
    panelIsCollapsed = false;
    mockEditorUnitPx = 1360;
  });

  test('a project window puts the tab row, the workspace and the side panel inside one editor card', () => {
    setViewportWidth(1400);
    docCtx = DOC_LIVE_CTX;
    render(
      <EditorArea {...rowProps} agentsVisible terminalVisible dockTree={RIGHT_TERMINAL_TREE} />,
    );

    const card = paneCard('editor');
    const inner = screen.getByTestId('resizable-group-inner');
    const header = document.querySelector('[data-editor-area-header]');
    const column = document.querySelector('[data-editor-workspace-column]');
    const docPanel = document.getElementById('doc-panel');
    if (card == null || header == null || column == null || docPanel == null) {
      throw new Error('editor card structure is incomplete');
    }

    expect(card.getAttribute('data-variant')).toBe('card');
    expect(card.parentElement).toBe(dockUnit('editor'));
    expect(card.contains(inner)).toBe(true);
    expect(inner.contains(docPanel)).toBe(true);
    expect(inner.contains(column)).toBe(true);
    expect(column.firstElementChild).toBe(header);
    expect(header.contains(screen.getByTestId('workspace-tabs'))).toBe(true);
    expect(docPanel.contains(header)).toBe(false);
    expect(card.contains(terminalMount())).toBe(false);
    expect(card.contains(agentsMount())).toBe(false);
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

  test('a side panel drag marks only the side panel row', () => {
    setViewportWidth(1400);
    docCtx = DOC_LIVE_CTX;
    render(<EditorArea {...rowProps} agentsVisible />);
    const inner = screen.getByTestId('resizable-group-inner');
    const workspace = document.querySelector('[data-dock-workspace]');

    act(() => {
      fireEvent.pointerDown(docHandle(), { pointerId: 1 });
    });
    expect(inner.getAttribute('data-dragging')).toBe('true');
    expect(workspace?.hasAttribute('data-dragging')).toBe(false);
    act(() => {
      fireEvent.pointerUp(window, { pointerId: 1 });
    });
    expect(inner.hasAttribute('data-dragging')).toBe(false);
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

  test('a side-panel drag the library starts beside the divider takes the drag lock, marks the inner row, and re-pins on release', async () => {
    const resizeObserver = installResizeObserver();
    try {
      setViewportWidth(1400);
      docCtx = DOC_LIVE_CTX;
      innerLayout = innerRowWithDoc(320, 1360);
      render(<EditorArea {...rowProps} agentsVisible />);
      await act(async () => {});
      const innerRow = screen.getByTestId('resizable-group-inner');
      expect(innerRow.getAttribute('data-dragging')).toBeNull();

      docHandle().setAttribute('data-separator', 'active');
      innerLayout = innerRowWithDoc(360, 1360);
      act(() => {
        innerOnLayoutChange?.(innerLayout);
      });
      expect(innerRow.getAttribute('data-dragging')).toBe('true');

      innerSetLayoutCalls = [];
      mockEditorUnitPx = 1000;
      resizeObserver.fire('[data-editor-inner-panels]');
      await flushFrame();
      expect(innerSetLayoutCalls).toHaveLength(0);

      docHandle().removeAttribute('data-separator');
      act(() => {
        fireEvent.pointerUp(window, { pointerId: 7 });
      });
      expect(innerRow.getAttribute('data-dragging')).toBeNull();
      expect(innerSetLayoutCalls.length).toBeGreaterThan(0);
    } finally {
      resizeObserver.restore();
    }
  });

  test('every side-panel drag end re-pins the side panel width', async () => {
    setViewportWidth(1400);
    docCtx = DOC_LIVE_CTX;
    innerLayout = innerRowWithDoc(320, 1360);
    render(<EditorArea {...rowProps} agentsVisible />);
    await act(async () => {});
    innerLayout = innerRowWithDoc(300, 1360);
    innerSetLayoutCalls = [];

    act(() => {
      fireEvent.pointerDown(docHandle(), { pointerId: 1 });
    });
    expect(innerSetLayoutCalls).toHaveLength(0);
    act(() => {
      fireEvent.pointerUp(window, { pointerId: 1 });
    });

    expect(lastInnerWritePx('doc-panel')).toBeCloseTo(320, 3);
  });

  test('the inner row observer re-pins the side panel width on its own', async () => {
    const resizeObserver = installResizeObserver();
    try {
      setViewportWidth(2000);
      mockPanelPx = 320;
      docCtx = DOC_LIVE_CTX;
      innerLayout = innerRowWithDoc(320, 1360);
      render(<EditorArea {...rowProps} agentsVisible />);
      await act(async () => {});
      innerSetLayoutCalls = [];

      mockEditorUnitPx = 1000;
      resizeObserver.fire('[data-editor-inner-panels]');
      await flushFrame();

      expect(lastInnerWritePx('doc-panel')).toBeCloseTo(320, 3);
    } finally {
      resizeObserver.restore();
    }
  });

  test('the inner row observer stays off inside an embedded host', async () => {
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
      innerSetLayoutCalls = [];
      mockEditorUnitPx = 1000;
      resizeObserver.fire('[data-editor-inner-panels]');
      await flushFrame();
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
  } as const;
  const setViewportWidth = (px: number) => {
    Object.defineProperty(window, 'innerWidth', { value: px, configurable: true, writable: true });
  };
  const cardOf = paneCard;

  beforeEach(() => {
    cleanup();
    localStorage.clear();
    docCtx = DOC_LIVE_CTX;
    panelIsCollapsed = false;
    mockEditorUnitPx = 1360;
    editorWorkspaceMounts = 0;
    setViewportWidth(1400);
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
      panelOnResizeById.get('doc-panel')?.({ asPercentage: 0, inPixels: 0 });
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
              dockTree={RIGHT_TERMINAL_TREE}
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
});

describe('EditorArea with the editor hidden', () => {
  const hiddenProps = {
    editorMode: 'wysiwyg',
    onModeChange: () => {},
    activeTab: 'timeline',
    onActiveTabChange: () => {},
    terminalBridge: {} as never,
  } as const;
  const settle = () => act(async () => {});
  const unitStyles = () =>
    (['editor', 'agents', 'terminal'] as const).map((pane) => dockUnit(pane).getAttribute('style'));
  const rowShare = (tree: DockNode, pane: PaneId) => {
    if (!('items' in tree)) throw new Error('expected a row of panes');
    const item = tree.items.find(({ node }) => 'pane' in node && node.pane === pane);
    if (item === undefined) throw new Error(`${pane} is not in the row`);
    return item.size;
  };

  beforeEach(() => {
    cleanup();
    localStorage.clear();
    docCtx = DOC_LIVE_CTX;
    panelIsCollapsed = false;
    mockEditorUnitPx = 1360;
    Object.defineProperty(window, 'innerWidth', {
      value: 1400,
      configurable: true,
      writable: true,
    });
  });

  test('chat alone fills the workspace while the editor keeps its last size out of reach', async () => {
    const view = render(<EditorArea {...hiddenProps} agentsVisible />);
    await settle();
    const editorWidth = unitPx('editor', 'width');

    view.rerender(<EditorArea {...hiddenProps} agentsVisible editorVisible={false} />);
    await settle();

    expect(unitPx('agents', 'insetInlineStart')).toBe(0);
    expect(unitPx('agents', 'width')).toBe(WORKSPACE_WIDTH_PX);
    expect(dockUnit('editor').hasAttribute('data-dock-unit-off')).toBe(true);
    expect(unitPx('editor', 'width')).toBe(editorWidth);
    expect(document.querySelectorAll('[data-dock-seam]')).toHaveLength(0);
  });

  test.each([
    {
      pane: 'Chat',
      open: { agentsVisible: true },
      closed: { agentsVisible: false },
    },
    {
      pane: 'a right Terminal',
      open: { terminalVisible: true, dockTree: RIGHT_TERMINAL_TREE },
      closed: { terminalVisible: false, dockTree: RIGHT_TERMINAL_TREE },
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

  test('a right terminal and chat share the workspace in proportion to their shares of the tree', async () => {
    const view = render(
      <EditorArea {...hiddenProps} agentsVisible terminalVisible dockTree={RIGHT_TERMINAL_TREE} />,
    );
    await settle();

    view.rerender(
      <EditorArea
        {...hiddenProps}
        agentsVisible
        terminalVisible
        dockTree={RIGHT_TERMINAL_TREE}
        editorVisible={false}
      />,
    );
    await settle();

    const terminalWidth = unitPx('terminal', 'width');
    const agentsWidth = unitPx('agents', 'width');
    expect(unitPx('terminal', 'insetInlineStart')).toBe(0);
    expect(unitPx('agents', 'insetInlineStart') + agentsWidth).toBe(WORKSPACE_WIDTH_PX);
    expect(terminalWidth / agentsWidth).toBeCloseTo(
      rowShare(RIGHT_TERMINAL_TREE, 'terminal') / rowShare(RIGHT_TERMINAL_TREE, 'agents'),
      2,
    );
  });

  test('showing the editor again restores the layout it had before it was hidden', async () => {
    const changes: DockNode[] = [];
    const area = (editorVisible: boolean) => (
      <EditorArea
        {...hiddenProps}
        agentsVisible
        terminalVisible
        editorVisible={editorVisible}
        onDockTreeChange={(update) => changes.push(update(DEFAULT_DOCK_TREE))}
      />
    );
    const view = render(area(true));
    await settle();
    const before = unitStyles();

    view.rerender(area(false));
    await settle();
    expect(unitStyles()).not.toEqual(before);
    view.rerender(area(true));
    await settle();

    expect(unitStyles()).toEqual(before);
    expect(changes).toEqual([]);
  });

  test('hiding keeps the same editor card, workspace and file list mounted, at their size and out of reach', async () => {
    const view = render(
      <FileListHostProvider enabled>
        <EditorArea {...hiddenProps} agentsVisible />
      </FileListHostProvider>,
    );
    await settle();
    const card = paneCard('editor');
    const fileListSlot = document.querySelector('[data-editor-file-list-slot]');
    const tabsTarget = document.querySelector('[data-editor-area-header]');
    const width = unitPx('editor', 'width');
    const height = unitPx('editor', 'height');
    const workspaceMountsBefore = editorWorkspaceMounts;

    view.rerender(
      <FileListHostProvider enabled>
        <EditorArea {...hiddenProps} agentsVisible editorVisible={false} />
      </FileListHostProvider>,
    );
    await settle();

    expect(paneCard('editor')).toBe(card);
    expect(document.querySelector('[data-editor-file-list-slot]')).toBe(fileListSlot);
    expect(document.querySelector('[data-editor-area-header]')).toBe(tabsTarget);
    expect(editorWorkspaceMounts).toBe(workspaceMountsBefore);
    expect(card?.hasAttribute('inert')).toBe(true);
    expect(dockUnit('editor').hasAttribute('inert')).toBe(true);
    expect(dockUnit('editor').classList.contains('invisible')).toBe(true);
    expect(unitPx('editor', 'width')).toBe(width);
    expect(unitPx('editor', 'height')).toBe(height);

    view.rerender(
      <FileListHostProvider enabled>
        <EditorArea {...hiddenProps} agentsVisible />
      </FileListHostProvider>,
    );
    await settle();

    expect(paneCard('editor')).toBe(card);
    expect(editorWorkspaceMounts).toBe(workspaceMountsBefore);
    expect(card?.hasAttribute('inert')).toBe(false);
    expect(dockUnit('editor').hasAttribute('inert')).toBe(false);
    expect(dockUnit('editor').classList.contains('invisible')).toBe(false);
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

  test('a seam moved while the editor is hidden leaves the editor share alone', async () => {
    const trees: DockNode[] = [];
    function DockHost({ editorVisible }: { editorVisible: boolean }) {
      const [tree, setTree] = useState<DockNode>(RIGHT_TERMINAL_TREE);
      return (
        <EditorArea
          {...hiddenProps}
          agentsVisible
          terminalVisible
          editorVisible={editorVisible}
          dockTree={tree}
          onDockTreeChange={(update) => {
            const next = update(tree);
            trees.push(next);
            setTree(next);
          }}
        />
      );
    }
    const view = render(<DockHost editorVisible />);
    await settle();
    view.rerender(<DockHost editorVisible={false} />);
    await settle();
    const terminalWidth = unitPx('terminal', 'width');

    fireEvent.keyDown(dockSeam('Resize Agents'), { key: 'ArrowRight', shiftKey: true });
    await settle();

    const moved = trees.at(-1);
    if (moved === undefined) throw new Error('the seam reported no tree');
    expect(unitPx('terminal', 'width')).toBeGreaterThan(terminalWidth);
    expect(rowShare(moved, 'editor')).toBeCloseTo(rowShare(RIGHT_TERMINAL_TREE, 'editor'), 10);
    expect(rowShare(moved, 'terminal')).toBeGreaterThan(rowShare(RIGHT_TERMINAL_TREE, 'terminal'));
  });

  test('chat is marked as the only pane only while the editor is hidden and no terminal shows', async () => {
    const view = render(<EditorArea {...hiddenProps} agentsVisible />);
    await settle();
    expect(agentsMount()?.hasAttribute('data-chat-alone')).toBe(false);

    view.rerender(<EditorArea {...hiddenProps} agentsVisible editorVisible={false} />);
    await settle();
    expect(agentsMount()?.hasAttribute('data-chat-alone')).toBe(true);

    view.rerender(
      <EditorArea
        {...hiddenProps}
        agentsVisible
        editorVisible={false}
        terminalVisible
        dockTree={RIGHT_TERMINAL_TREE}
      />,
    );
    await settle();
    expect(agentsMount()?.hasAttribute('data-chat-alone')).toBe(false);
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

  test('hiding the editor above a bottom terminal hands the column to the terminal and keeps chat at its share', async () => {
    const area = (editorVisible: boolean) => (
      <EditorArea {...hiddenProps} agentsVisible terminalVisible editorVisible={editorVisible} />
    );
    const view = render(area(true));
    await settle();
    const agentsStyle = dockUnit('agents').getAttribute('style');
    const columnWidth = unitPx('editor', 'width');

    view.rerender(area(false));
    await settle();

    expect(unitPx('terminal', 'insetBlockStart')).toBe(0);
    expect(unitPx('terminal', 'height')).toBe(WORKSPACE_HEIGHT_PX);
    expect(unitPx('terminal', 'width')).toBe(columnWidth);
    expect(dockUnit('agents').getAttribute('style')).toBe(agentsStyle);
  });
});

describe('the document panel side', () => {
  const settle = () => act(async () => {});

  function docPanelFollowsColumn(): boolean {
    const column = document.querySelector('[data-editor-workspace-column]');
    const docPanel = document.querySelector('#doc-panel');
    if (column === null || docPanel === null)
      throw new Error('the editor column or doc panel is absent');
    return (column.compareDocumentPosition(docPanel) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
  }

  beforeEach(() => {
    cleanup();
    localStorage.clear();
  });

  test('a swap puts the document panel before the editor column in a window with a file sidebar, and a window without one keeps it after', async () => {
    swapEditorSidebars();
    try {
      const view = render(
        <FileListHostProvider enabled>
          <EditorArea
            editorMode="wysiwyg"
            onModeChange={() => {}}
            activeTab="timeline"
            onActiveTabChange={() => {}}
          />
        </FileListHostProvider>,
      );
      await settle();
      expect(docPanelFollowsColumn()).toBe(false);
      view.unmount();

      renderEditorArea();
      await settle();
      expect(docPanelFollowsColumn()).toBe(true);
    } finally {
      swapEditorSidebars();
    }
  });
});
