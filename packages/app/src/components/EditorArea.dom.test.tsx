import type { HocuspocusProvider } from '@hocuspocus/provider';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { type ReactNode, useEffect, useState } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { PanelTab } from './DocPanel';

type SettingsDialogShellProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

let settingsRouteOpen = false;
let closeSettingsRouteMock = vi.fn(() => {});
let shellProps: SettingsDialogShellProps[] = [];
let toastInfoMessages: string[] = [];

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
    agentsOpen,
  }: {
    terminalOpen?: boolean;
    agentsOpen?: boolean;
  }) => (
    <div
      data-testid="empty-editor-state"
      data-terminal-open={String(terminalOpen === true)}
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
let panelIsCollapsed = false;
let mockGroupPx = 1360;
vi.doMock('react-resizable-panels', () => ({
  usePanelRef: () => ({
    current: {
      collapse: () => {},
      expand: () => {},
      getSize: () => ({ asPercentage: 25, inPixels: mockGroupPx / 4 }),
      isCollapsed: () => panelIsCollapsed,
    },
  }),
  useGroupRef: () => ({
    current: {
      getLayout: () => groupLayout,
      setLayout: (layout: Record<string, number>) => {
        groupSetLayoutCalls.push(layout);
      },
    },
  }),
}));

vi.doMock('@/components/ui/resizable', () => ({
  ResizablePanelGroup: ({ children }: { children: ReactNode }) => (
    <div data-testid="resizable-group">{children}</div>
  ),
  ResizablePanel: ({
    children,
    id,
    minSize,
    maxSize,
  }: {
    children: ReactNode;
    id?: string;
    minSize?: string | number;
    maxSize?: string | number;
  }) => (
    <div id={id} data-min-size={minSize} data-max-size={maxSize}>
      {children}
    </div>
  ),
  ResizableHandle: ({ onPointerDown }: { onPointerDown?: (e: unknown) => void }) => (
    <div data-testid="resizable-handle" onPointerDown={onPointerDown} />
  ),
}));

vi.doMock('@/hooks/use-doc-panel-layout', () => ({
  useDocPanelLayout: () => ({ layout: 'panel', autoCollapse: false }),
}));

vi.doMock('@/hooks/use-document-stats', () => ({
  useDocumentStats: () => null,
}));

vi.doMock('@/hooks/use-lifecycle-status', () => ({
  useLifecycleStatus: () => 'ready',
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

  beforeEach(() => {
    cleanup();
    localStorage.clear();
    docCtx = EMPTY_DOC_CTX;
    groupLayout = {};
    groupSetLayoutCalls = [];
    panelIsCollapsed = false;
    mockGroupPx = 1360;
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
    expect(agentsPanel?.getAttribute('data-min-size')).toBe('320px');
    expect(agentsPanel?.getAttribute('data-max-size')).toBe('95%');
    expect(agentsChanges).toHaveLength(0);
    expect(terminalChanges).toHaveLength(0);
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

  test('releasing an agents-handle drag with the column snapped shut hides the panel', async () => {
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
    panelIsCollapsed = true;
    act(() => {
      fireEvent.pointerUp(window);
    });
    expect(visibleChanges.at(-1)).toBe(false);
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

  test('the agents tab is up while the panel is hidden, even with no conversations', () => {
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
