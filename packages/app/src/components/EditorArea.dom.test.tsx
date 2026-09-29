import type { HocuspocusProvider } from '@hocuspocus/provider';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { type ReactNode, useEffect, useState } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { MIN_AGENTS_PANEL_WIDTH } from '@/lib/agents-panel-width-store';
import type { PanelTab } from './DocPanel';

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
  }) => (
    <>
      {renderHeader(<div data-testid="workspace-tabs" />)}
      {renderPane({
        pane: { id: 'pane-test' },
        isFocused: true,
        activityDocName: null,
      })}
    </>
  ),
}));

let groupLayout: Record<string, number> = {};
let groupSetLayoutCalls: Array<Record<string, number>> = [];
let rejectNextGroupLayoutWrite = false;
let rejectGroupLayoutWrites = false;
let groupOnLayoutChanged:
  | ((layout: Record<string, number>, meta: { isUserInteraction: boolean }) => void)
  | null = null;
let panelIsCollapsed = false;
let mockGroupPx = 1360;
let mockPanelPercentage: number | null = null;
let mockPanelPx: number | null = null;
let panelExpandCalls = 0;
let deferPanelGeometryCommit = false;
let committedGroupLayout: Record<string, number> = {};

beforeEach(() => {
  mockPanelPercentage = null;
  mockPanelPx = null;
  rejectGroupLayoutWrites = false;
  deferPanelGeometryCommit = false;
  committedGroupLayout = {};
});

function geometryLayout(): Record<string, number> {
  return deferPanelGeometryCommit ? committedGroupLayout : groupLayout;
}

function mockedPanelWidthPx(element: HTMLElement): number {
  const layout = geometryLayout();
  if (element.id !== '') return ((layout[element.id] ?? 0) / 100) * mockGroupPx;
  const group = element.parentElement;
  if (group == null) return 0;
  let claimedPercentage = 0;
  for (const sibling of group.querySelectorAll<HTMLElement>(':scope > [data-panel]')) {
    if (sibling.id !== '') claimedPercentage += layout[sibling.id] ?? 0;
  }
  return (Math.max(0, 100 - claimedPercentage) / 100) * mockGroupPx;
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
vi.doMock('react-resizable-panels', () => ({
  usePanelRef: () => ({
    current: {
      collapse: () => {},
      expand: () => {
        panelExpandCalls += 1;
      },
      getSize: () => ({
        asPercentage: mockPanelPercentage ?? 25,
        inPixels: mockPanelPx ?? mockGroupPx / 4,
      }),
      isCollapsed: () => panelIsCollapsed,
    },
  }),
  useGroupRef: () => ({
    current: {
      getLayout: () => groupLayout,
      setLayout: (layout: Record<string, number>) => {
        groupSetLayoutCalls.push(layout);
        if (rejectNextGroupLayoutWrite) {
          rejectNextGroupLayoutWrite = false;
          return;
        }
        if (rejectGroupLayoutWrites) return;
        groupLayout = layout;
        if (deferPanelGeometryCommit) {
          queueMicrotask(() => {
            committedGroupLayout = layout;
          });
        } else {
          committedGroupLayout = layout;
        }
      },
    },
  }),
}));

vi.doMock('@/components/ui/resizable', () => ({
  ResizablePanelGroup: ({
    children,
    onLayoutChanged,
  }: {
    children: ReactNode;
    onLayoutChanged?: (
      layout: Record<string, number>,
      meta: { isUserInteraction: boolean },
    ) => void;
  }) => {
    groupOnLayoutChanged = onLayoutChanged ?? null;
    return (
      <div data-testid="resizable-group" data-group="true" data-slot="resizable-panel-group">
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
  }: {
    children: ReactNode;
    id?: string;
    minSize?: string | number;
    maxSize?: string | number;
    onResize?: (size: { asPercentage: number; inPixels: number }) => void;
  }) => {
    if (id != null) railPanelOnResizeById.set(id, onResize ?? null);
    return (
      <div
        id={id}
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
  }) => (
    <hr
      aria-controls={props['aria-controls']}
      aria-label={props['aria-label']}
      aria-valuenow={50}
      data-testid="resizable-handle"
      data-agents-panel-resize-handle={props['data-agents-panel-resize-handle']}
      onPointerDown={onPointerDown}
      tabIndex={0}
    />
  ),
}));

vi.doMock('@/hooks/use-doc-panel-layout', () => ({
  useDocPanelLayout: () => ({ layout: 'panel', autoCollapse: false }),
}));

vi.doMock('@/hooks/use-document-stats', () => ({
  useDocumentStats: () => null,
}));

vi.doMock('@/hooks/use-conflicts', () => ({
  useDocConflict: () => null,
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
const { TooltipProvider } = await import('@/components/ui/tooltip');
const { emitLocalMenuAction } = await import('@/lib/local-menu-action-bus');
const { requestDocPanelTab } = await import('./doc-panel-events');
const { AGENTS_COLUMN_ID, TERMINAL_COLUMN_ID } = await import('./editor-area-rail-registry');
const { MAX_RAIL_PIN_EXHAUSTED_REPORTS } = await import('./EditorArea');
const { RIGHT_TERMINAL_PANEL_MIN_WIDTH_PX } = await import('./right-rail-admission');

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
    panelExpandCalls = 0;
    deferPanelGeometryCommit = false;
    committedGroupLayout = {};
    groupOnLayoutChanged = null;
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
      'doc-panel': 0,
      'terminal-column': 0,
      'agents-column': 0,
    };
    groupSetLayoutCalls = [];

    act(() => emitLocalMenuAction('toggle-doc-panel'));

    const corrected = groupSetLayoutCalls.at(-1);
    expect(corrected?.['doc-panel']).toBeCloseTo(pctOf(320), 3);
    expect(corrected?.['terminal-column']).toBe(0);
    expect(corrected?.['agents-column']).toBe(0);
    expect(corrected?.['editor-main']).toBeCloseTo(100 - pctOf(320), 3);
  });

  test('a second toggle re-opens the doc panel the first toggle collapsed', () => {
    setViewportWidth(1400);
    docCtx = DOC_LIVE_CTX;
    render(<EditorArea {...baseProps} />);
    groupLayout = {
      'editor-main': 75,
      'doc-panel': 25,
      'terminal-column': 0,
      'agents-column': 0,
    };
    groupSetLayoutCalls = [];

    act(() => emitLocalMenuAction('toggle-doc-panel'));
    expect(groupSetLayoutCalls.at(-1)?.['doc-panel']).toBe(0);

    act(() => emitLocalMenuAction('toggle-doc-panel'));
    expect(groupSetLayoutCalls.at(-1)?.['doc-panel']).toBeCloseTo(pctOf(320), 3);
  });

  test('hiding the agents panel re-asserts the collapsed doc panel over the stale panel-set restore', async () => {
    setViewportWidth(1024);
    docCtx = DOC_LIVE_CTX;
    const view = render(<EditorArea {...baseProps} agentsVisible />);
    expect(groupSetLayoutCalls).toHaveLength(0);
    groupLayout = { 'editor-main': 70, 'doc-panel': 30 };
    view.rerender(<EditorArea {...baseProps} agentsVisible={false} />);
    await act(async () => {});
    const corrected = groupSetLayoutCalls.at(-1);
    expect(corrected).toBeDefined();
    expect(corrected?.['doc-panel']).toBe(0);
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
    groupLayout = {
      'editor-main': 100 - (320 / 1610) * 100 - (740 / 1610) * 100,
      'doc-panel': (320 / 1610) * 100,
      'terminal-column': (740 / 1610) * 100,
      'agents-column': 0,
    };
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

  const RAIL_LAYOUT_1610 = {
    'editor-main': 100 - (320 / 1610) * 100 - (740 / 1610) * 100,
    'doc-panel': (320 / 1610) * 100,
    'terminal-column': (740 / 1610) * 100,
    'agents-column': 0,
  };

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

  async function withSynchronousFrames(run: () => void) {
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
      run();
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
    groupLayout = { ...RAIL_LAYOUT_1610 };
    committedGroupLayout = { ...RAIL_LAYOUT_1610 };
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
    groupLayout = {
      'editor-main': 100 - (320 / 1610) * 100 - strandedTerminalPercentage,
      'doc-panel': (320 / 1610) * 100,
      'terminal-column': strandedTerminalPercentage,
      'agents-column': 0,
    };
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
    groupLayout = {
      'editor-main': 100 - (320 / 1610) * 100 - 44,
      'doc-panel': (320 / 1610) * 100,
      'terminal-column': 44,
      'agents-column': 0,
    };
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
      'doc-panel': 0,
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
      'editor-main': ((groupPx - terminalRenderedPx - docRenderedPx) / groupPx) * 100,
      'doc-panel': (docRenderedPx / groupPx) * 100,
      'terminal-column': (terminalRenderedPx / groupPx) * 100,
      'agents-column': 0,
    };

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
    groupLayout = {
      'editor-main': 100 - (320 / 1610) * 100 - 44,
      'doc-panel': (320 / 1610) * 100,
      'terminal-column': 44,
      'agents-column': 0,
    };
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
    groupLayout = {
      'editor-main': 100 - (320 / 1610) * 100 - 44,
      'doc-panel': (320 / 1610) * 100,
      'terminal-column': 44,
      'agents-column': 0,
    };
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

  test('revealing the agents panel keeps the open doc panel open despite a stale cached layout', async () => {
    setViewportWidth(1400);
    docCtx = DOC_LIVE_CTX;
    const view = render(<EditorArea {...baseProps} agentsVisible={false} />);
    groupLayout = { 'editor-main': 45, 'doc-panel': 25, 'agents-column': 30 };
    view.rerender(<EditorArea {...baseProps} agentsVisible />);
    await act(async () => {});
    const corrected = groupSetLayoutCalls.at(-1);
    expect(corrected).toBeDefined();
    expect(corrected?.['doc-panel']).toBeCloseTo(pctOf(320), 3);
    expect(corrected?.['agents-column']).toBeCloseTo(pctOf(480), 3);
    expect(corrected?.['editor-main']).toBeCloseTo(100 - pctOf(320) - pctOf(480), 3);
  });

  test('the rail keeps one panel-ID set from a document to a new tab', () => {
    setViewportWidth(1400);
    docCtx = DOC_LIVE_CTX;
    const view = render(<EditorArea {...baseProps} agentsVisible />);
    const withDocument = renderedPanelIds();
    expect(withDocument).toEqual(['doc-panel', 'terminal-column', 'agents-column']);

    docCtx = EMPTY_DOC_CTX;
    view.rerender(<EditorArea {...baseProps} agentsVisible />);

    expect(renderedPanelIds()).toEqual(withDocument);
    expect(document.getElementById('doc-panel')?.childElementCount).toBe(0);
  });

  test('the rail keeps one panel-ID set across every view kind', () => {
    setViewportWidth(1400);
    const expected = ['doc-panel', 'terminal-column', 'agents-column'];
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
    expect(renderedPanelIds()).toEqual(['doc-panel', 'terminal-column', 'agents-column']);
    expect(document.getElementById('doc-panel')?.childElementCount).toBe(1);
    window.location.hash = '';
  });

  test('emptying the slot hands its width to the editor; refilling takes it back', async () => {
    setViewportWidth(1400);
    docCtx = DOC_LIVE_CTX;
    const view = render(<EditorArea {...baseProps} />);
    groupLayout = {
      'editor-main': 60,
      'doc-panel': 40,
      'terminal-column': 0,
      'agents-column': 0,
    };
    groupSetLayoutCalls = [];

    docCtx = ASSET_DOC_CTX;
    view.rerender(<EditorArea {...baseProps} />);
    await act(async () => {});
    const emptied = groupSetLayoutCalls.at(-1);
    expect(emptied?.['doc-panel']).toBe(0);
    expect(emptied?.['editor-main']).toBe(100);

    groupLayout = { ...groupLayout, 'editor-main': 100, 'doc-panel': 0 };
    docCtx = DOC_LIVE_CTX;
    view.rerender(<EditorArea {...baseProps} />);
    await act(async () => {});
    const refilled = groupSetLayoutCalls.at(-1);
    expect(refilled?.['doc-panel']).toBeCloseTo(pctOf(320), 3);
    expect(refilled?.['editor-main']).toBeCloseTo(100 - pctOf(320), 3);
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
      'doc-panel': 0,
      'terminal-column': 0,
      'agents-column': 0,
    };
    groupSetLayoutCalls = [];

    docCtx = { ...FOLDER_AGENT_CTX, docPanelExpandSignal: 1 };
    view.rerender(<EditorArea {...baseProps} />);
    await act(async () => {});

    const opened = groupSetLayoutCalls.at(-1);
    expect(opened?.['doc-panel']).toBeCloseTo(pctOf(320), 3);
  });

  test('a view with no document pane pins the slot shut and ignores the toggle', async () => {
    setViewportWidth(1400);
    docCtx = ASSET_DOC_CTX;
    groupLayout = {
      'editor-main': 100 - pctOf(480),
      'doc-panel': 0,
      'terminal-column': 0,
      'agents-column': pctOf(480),
    };
    render(<EditorArea {...baseProps} agentsVisible />);
    groupSetLayoutCalls = [];
    groupLayout = {
      'editor-main': 45,
      'doc-panel': 25,
      'terminal-column': 0,
      'agents-column': 30,
    };

    act(() => emitLocalMenuAction('toggle-doc-panel'));
    await act(async () => {});

    expect(groupSetLayoutCalls).toHaveLength(0);
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
        'editor-main': 100 - pctOf(320 + 440 + 480),
        'doc-panel': pctOf(320),
        'terminal-column': pctOf(440),
        'agents-column': pctOf(480),
      };
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
          'editor-main': 100 - pctOf(320 + 440 + 250),
          'doc-panel': pctOf(320),
          'terminal-column': pctOf(440),
          'agents-column': pctOf(250),
        };
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
      'editor-main': 100 - pctOf(320 + 480),
      'doc-panel': pctOf(320),
      'agents-column': pctOf(480),
    };
    const frames = controlAnimationFrames();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      render(<EditorArea {...baseProps} agentsVisible />);
      groupLayout = {
        'editor-main': 100 - pctOf(320 + 250),
        'doc-panel': pctOf(320),
        'agents-column': pctOf(250),
      };
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
      'editor-main': 100 - pctOf(320 + 480),
      'doc-panel': pctOf(320),
      'agents-column': pctOf(480),
    };
    const frames = controlAnimationFrames();
    try {
      render(<EditorArea {...baseProps} agentsVisible />);
      getAgentsHandle().focus();
      groupLayout = {
        'editor-main': 100 - pctOf(320 + 250),
        'doc-panel': pctOf(320),
        'agents-column': pctOf(250),
      };
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
        'editor-main': 100 - pctOf(320 + 600),
        'doc-panel': pctOf(320),
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

  test.each([
    { label: 'doc', panelId: 'doc-panel', terminalVisible: false },
    { label: 'Terminal', panelId: 'terminal-column', terminalVisible: true },
  ])(
    'a $label handle drag pauses a refused keyboard settlement',
    ({ panelId, terminalVisible }) => {
      setViewportWidth(1400);
      if (!terminalVisible) docCtx = FOLDER_DOC_CTX;
      groupLayout = {
        'editor-main': 100 - pctOf(320 + 480),
        [panelId]: pctOf(320),
        'agents-column': pctOf(480),
      };
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
        groupLayout = {
          'editor-main': 100 - pctOf(320 + 250),
          [panelId]: pctOf(320),
          'agents-column': pctOf(250),
        };
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
          groupOnLayoutChanged?.(groupLayout, { isUserInteraction: true });
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
    const panelWidths = [880, 0, 0, 320];
    const panelElements = screen
      .getByTestId('resizable-group')
      .querySelectorAll('[data-slot="resizable-panel"]');
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
      'doc-panel': 0,
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
      <TooltipProvider>
        <EditorArea
          {...baseProps}
          agentsVisible
          onRevealAgents={() => {}}
          onAgentsVisibleChange={(visible: boolean) => {
            visibleChanges.push(visible);
          }}
        />
      </TooltipProvider>,
    );
    getAgentsHandle().focus();
    groupLayout = {
      'editor-main': 100,
      'doc-panel': 0,
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
    expect(screen.getByRole('button', { name: 'Open agents panel' })).toBeTruthy();
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

    groupLayout = { 'editor-main': 45, 'doc-panel': 25, 'agents-column': 30 };
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

describe('EditorArea session-panel edge reveal tabs', () => {
  const revealProps = {
    editorMode: 'wysiwyg',
    onModeChange: () => {},
    activeTab: 'timeline',
    onActiveTabChange: () => {},
    terminalBridge: { terminal: {} } as never,
    onAgentsVisibleChange: () => {},
    onTerminalVisibleChange: () => {},
    onRevealAgents: () => {},
  } as const;

  beforeEach(() => {
    cleanup();
    docCtx = EMPTY_DOC_CTX;
  });

  const renderArea = (props: Record<string, unknown>) =>
    render(
      <TooltipProvider>
        <EditorArea {...revealProps} {...props} />
      </TooltipProvider>,
    );

  test('the agents tab is up while the panel is hidden, even with no chats', () => {
    renderArea({ agentsVisible: false });
    const reveal = screen.getByRole('button', { name: 'Open agents panel' });
    const header = document.querySelector('[data-editor-area-header]');
    const panels = document.querySelector('[data-editor-area-panels]');

    expect(header).toBeTruthy();
    expect(panels).toBeTruthy();
    expect(header?.contains(screen.getByTestId('workspace-tabs'))).toBe(true);
    expect(panels?.contains(reveal)).toBe(true);
    expect(header?.contains(reveal)).toBe(false);
  });

  test('the agents tab goes away once the panel is open', () => {
    renderArea({ agentsVisible: true });
    expect(screen.queryByRole('button', { name: 'Open agents panel' })).toBeNull();
    const header = document.querySelector('[data-editor-area-header]');
    const panels = document.querySelector('[data-editor-area-panels]');
    const agentMount = document.querySelector('[data-agents-panel-mount]');

    expect(header).toBeTruthy();
    expect(panels?.contains(agentMount)).toBe(true);
    expect(header?.contains(agentMount)).toBe(false);
  });

  test('the measured-collapse reveal restores the preferred rail width without panel expand', () => {
    mockGroupPx = 1360;
    mockPanelPercentage = null;
    mockPanelPx = null;
    panelExpandCalls = 0;
    renderArea({ agentsVisible: true });
    groupLayout = {
      'editor-main': 100,
      'doc-panel': 0,
      'terminal-column': 0,
      'agents-column': 0,
    };
    act(() => {
      railPanelOnResizeById.get(AGENTS_COLUMN_ID)?.({ asPercentage: 0, inPixels: 0 });
    });
    groupSetLayoutCalls = [];

    fireEvent.click(screen.getByRole('button', { name: 'Open agents panel' }));

    expect(panelExpandCalls).toBe(0);
    expect(groupSetLayoutCalls.at(-1)?.['agents-column']).toBeCloseTo((480 / 1360) * 100, 3);
  });

  test('a note window never renders the agents reveal tab', () => {
    Object.defineProperty(window, 'okDesktop', {
      configurable: true,
      value: {
        config: { mode: 'note' },
        editor: { notifyViewMenuStateChanged: () => {} },
      },
    });
    try {
      renderArea({ agentsVisible: false });
      expect(screen.queryByRole('button', { name: 'Open agents panel' })).toBeNull();
    } finally {
      Reflect.deleteProperty(window, 'okDesktop');
    }
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

describe('EditorArea hash-load skeleton renders outside the panel group (cold start)', () => {
  beforeEach(() => {
    cleanup();
    docCtx = DOC_COLD_CTX;
  });
  afterEach(() => {
    window.location.hash = '';
  });

  test('renders the load skeleton directly, not inside the terminal dock or panel group', () => {
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

    expect(screen.getByTestId('editor-skeleton')).toBeTruthy();
    expect(screen.queryByTestId('resizable-group')).toBeNull();
    expect(screen.queryByTestId('terminal-dock')).toBeNull();
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

  test('web host keeps the bare early-return on mid-session cold nav (no dock to preserve)', () => {
    const webProps = {
      editorMode: 'wysiwyg' as const,
      onModeChange: () => {},
      activeTab: 'timeline' as const,
      onActiveTabChange: () => {},
    };
    const { rerender } = render(<EditorArea {...webProps} />);
    act(() => {
      docCtx = DOC_COLD_CTX;
      window.location.hash = '#/some-doc';
    });
    rerender(<EditorArea {...webProps} />);

    expect(screen.getByTestId('editor-skeleton')).toBeTruthy();
    expect(screen.queryByTestId('resizable-group')).toBeNull();
    expect(screen.queryByTestId('terminal-dock')).toBeNull();
  });
});

describe('EditorArea doc-panel tab requests', () => {
  const pctOf = (px: number) => (px / 1360) * 100;

  function TabHost({ initialTab }: { initialTab: PanelTab }) {
    const [tab, setTab] = useState<PanelTab>(initialTab);
    return (
      <TooltipProvider>
        <EditorArea
          editorMode="wysiwyg"
          onModeChange={() => {}}
          activeTab={tab}
          onActiveTabChange={setTab}
        />
      </TooltipProvider>
    );
  }

  beforeEach(() => {
    cleanup();
    localStorage.clear();
    docCtx = { ...DOC_LIVE_CTX, docPanelMode: 'doc' };
    groupLayout = {};
    groupSetLayoutCalls = [];
    mockGroupPx = 1360;
    closeActivityPanelCalls = 0;
  });

  test('a doc-scoped problems request opens the Problems tab and expands the collapsed rail', () => {
    render(<TabHost initialTab="timeline" />);
    groupLayout = { 'editor-main': 100, 'doc-panel': 0 };
    groupSetLayoutCalls = [];

    act(() => requestDocPanelTab('problems', { scope: 'doc' }));

    const panel = screen.getByRole('tabpanel');
    expect(panel.getAttribute('id')).toBe('panel-problems');
    expect(groupSetLayoutCalls.at(-1)?.['doc-panel']).toBeCloseTo(pctOf(320), 3);
  });

  test('a panel already parked on Problems in project scope comes back in doc scope', () => {
    render(<TabHost initialTab="problems" />);
    fireEvent.click(screen.getByTestId('panel-scope-project'));
    expect(screen.getByTestId('problems-project-scope')).toBeTruthy();
    groupLayout = { 'editor-main': 100, 'doc-panel': 0 };
    groupSetLayoutCalls = [];

    act(() => requestDocPanelTab('problems', { scope: 'doc' }));

    expect(screen.getByTestId('panel-scope-doc').getAttribute('data-state')).toBe('on');
    expect(screen.queryByTestId('problems-project-scope')).toBeNull();
    expect(groupSetLayoutCalls.at(-1)?.['doc-panel']).toBeCloseTo(pctOf(320), 3);
  });

  test('a tab request takes the rail back from the agent drill-in', () => {
    docCtx = { ...DOC_LIVE_CTX, docPanelMode: 'agent', docPanelAgentId: 'agent-1' };
    render(<TabHost initialTab="timeline" />);
    expect(screen.queryByRole('tabpanel')).toBeNull();

    act(() => requestDocPanelTab('problems', { scope: 'doc' }));

    expect(closeActivityPanelCalls).toBe(1);
  });

  test('re-rendering does not stack the subscription, and unmounting drops it', () => {
    const view = render(<TabHost initialTab="timeline" />);
    for (let i = 0; i < 3; i += 1) view.rerender(<TabHost initialTab="timeline" />);
    groupLayout = { 'editor-main': 100, 'doc-panel': 0 };
    groupSetLayoutCalls = [];

    act(() => requestDocPanelTab('problems', { scope: 'doc' }));
    expect(groupSetLayoutCalls).toHaveLength(1);

    view.unmount();
    act(() => requestDocPanelTab('problems', { scope: 'doc' }));
    expect(groupSetLayoutCalls).toHaveLength(1);
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
