import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { type ReactNode, useEffect } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

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

// EditorArea reads the project config binding (for the desktop "toggle content
// rules" menu action). These tests mount EditorArea outside a ConfigProvider,
// so stub the hook with a null binding — the toggle handler is a no-op here.
vi.doMock('@/lib/config-provider', () => ({
  useConfigContext: () => ({ projectBinding: null }),
}));

const FOLDER_DOC_CTX = {
  activeDocName: 'folder/index',
  activeProvider: null,
  activeTarget: { kind: 'folder', target: 'folder', folderPath: 'folder' },
  recycleDocument: () => {},
  docPanelMode: 'timeline',
  docPanelAgentId: null,
  docPanelExpandSignal: 0,
};
const EMPTY_DOC_CTX = {
  activeDocName: null,
  activeProvider: null,
  activeTarget: null,
  recycleDocument: () => {},
  docPanelMode: 'timeline',
  docPanelAgentId: null,
  docPanelExpandSignal: 0,
};
const LARGE_FILE_DOC_CTX = {
  activeDocName: 'big',
  activeProvider: null,
  activeTarget: { kind: 'large-file', docName: 'big', size: 9_999_999, limit: 1_000_000 },
  recycleDocument: () => {},
  docPanelMode: 'timeline',
  docPanelAgentId: null,
  docPanelExpandSignal: 0,
};
const ASSET_DOC_CTX = {
  activeDocName: null,
  activeProvider: null,
  activeTarget: { kind: 'asset', assetPath: 'images/diagram.png', mediaKind: 'image' },
  recycleDocument: () => {},
  docPanelMode: 'timeline',
  docPanelAgentId: null,
  docPanelExpandSignal: 0,
};
// A live-provider folder view: drives the EditorArea `everHadProvider` latch
// true (the effect only needs a non-null provider) through an already-mocked
// branch, so a later provider-null render counts as a mid-session navigation
// rather than a cold start.
const FOLDER_LIVE_CTX = { ...FOLDER_DOC_CTX, activeProvider: {} as never };
// A folder view drilled into an agent's activity — the case that used to render
// its own `agent-panel` and now fills the shared document slot.
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
// A doc target whose provider has gone transiently null — the close→neighbor
// gap (the neighbor activates async via hashchange) or a switch to a cold tab.
// Reaches the hash-load skeleton branch (not large-file/folder/asset, and
// `!activeProvider || !activeDocName`).
const DOC_COLD_CTX = {
  activeDocName: null,
  activeProvider: null,
  activeTarget: { kind: 'doc', target: 'some-doc', docName: 'some-doc' },
  recycleDocument: () => {},
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
  // EditorArea imports isSkillsNewTabId; keep it in the partial mock so the
  // module link can't detonate on load-order (see mock-module-completeness).
  isSkillsNewTabId: () => false,
  isBlobRunnerNewTabId: () => false,
}));

vi.doMock('@/components/EmptyEditorState', () => ({
  // Forward both panel flags so the EditorArea -> EmptyEditorState prop wiring is
  // observable (the empty state collapses to the header-only view whenever
  // either panel is up).
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

// Counts TerminalDock mounts so a remount-on-view-switch regression (which
// would dispose xterm + kill the PTY) is observable in tests.
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

// Spy substrate for the group-level layout assert (assertRightRailLayout).
// `groupLayout` is what the group "currently" holds (the assert derives the
// panel-ID set from it); `groupSetLayoutCalls` records every corrective write.
// A panel getSize of 340px at 25% fixes the px→% basis at 1360px.
// `panelIsCollapsed` drives the drag-to-close pointerup branch (the terminal
// handle hides the column when released with the panel snapped shut).
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

// Every view now renders inside the shared horizontal skeleton (group + left
// panel + optional right panel), so the resizable primitives must resolve in
// the DOM harness. Passthrough mocks render children without the real
// react-resizable-panels engine (which is stubbed).
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
  // Forward onPointerDown so drag-lifecycle behavior (the terminal handle's
  // drag-to-close pointerup check) is exercisable; drop non-DOM props.
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

// The "Ask AI" composer now renders in both doc and folder views (it is no
// longer desktop-gated). Stub it here so these layout/skeleton tests don't drag
// in its config / workspace / TipTap dependency tree — the gate is unit-tested
// in bottom-composer-gate.test.ts and the composer itself in
// BottomComposer.dom.test.tsx.
vi.doMock('./BottomComposer', () => ({
  BottomComposer: ({ docName, folderPath }: { docName?: string | null; folderPath?: string }) => (
    <div data-testid="bottom-composer" data-doc={docName ?? ''} data-folder={folderPath ?? ''} />
  ),
}));

// The agent-activity view reaches for PageList/workspace context this layout
// harness does not stand up. It is lazy, so before an `await act()` anywhere in
// the file it stayed suspended and never rendered; once resolved it renders
// synchronously in every later test. Stub it for the same reason the other heavy
// children here are stubbed — these tests are about the rail, not its contents.
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

  // Regression: an empty-state launch (e.g. the create composer's "Create with
  // Claude CLI") needs the docked terminal mounted on the empty state too — it
  // used to render only in the open-doc branch, so the launch silently no-opped.
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
    // EditorArea forwards the open panel so the empty state collapses to the
    // header-only view (composer bubble dropped) while the terminal is up.
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
        // Either panel collapses the empty state — an open panel is its own AI
        // entry point, so the composer bubble must not compete with it.
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

    // The dock shell is host-agnostic now, but with nothing docked it stays inactive.
    expect(screen.getByTestId('terminal-dock').getAttribute('data-visible')).toBe('false');
    // Pins the forwarding: with neither panel open the empty state must receive
    // both flags false, or it would collapse to header-only on every new tab.
    const emptyState = screen.getByTestId('empty-editor-state');
    expect(emptyState.getAttribute('data-terminal-open')).toBe('false');
    expect(emptyState.getAttribute('data-agents-open')).toBe('false');
  });
});

describe('EditorArea right-rail layout assert on column mount/unmount', () => {
  // react-resizable-panels caches layouts per panel-ID set and restores the
  // cached layout whenever the set changes — so before the corrective assert,
  // hiding the right column resurrected a doc panel the user had closed while it
  // was up (and revealing it restored equally stale state). These pin the
  // assert: on every agents-column presence flip, EditorArea writes one full
  // corrected layout through the group handle, preserving the doc panel's
  // pre-flip state and routing the difference to the editor.
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

  // px→% conversion basis fixed by the panel mock: 340px at 25% → 1360px.
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

  /** Rail panel ids currently in the group, in render order. */
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

  test('hiding the agents panel re-asserts the collapsed doc panel over the stale panel-set restore', async () => {
    // Below 1280px the doc panel starts collapsed (no pin), so the intended
    // post-hide state is "collapsed" even though the cached two-panel layout
    // (mimicked) says expanded. Needs a live document: the slot is a permanent
    // member on every view, so only a view that HAS a document pane exercises
    // the collapsed-vs-open intent rather than the empty-slot pin.
    setViewportWidth(1024);
    docCtx = DOC_LIVE_CTX;
    const view = render(<EditorArea {...baseProps} agentsVisible />);
    expect(groupSetLayoutCalls).toHaveLength(0);
    // The stale two-panel layout the library restores on unmount: doc panel
    // expanded to 30% — the resurrection this assert corrects.
    groupLayout = { 'editor-main': 70, 'doc-panel': 30 };
    view.rerender(<EditorArea {...baseProps} agentsVisible={false} />);
    // Flush the microtask-deferred assert.
    await act(async () => {});
    const corrected = groupSetLayoutCalls.at(-1);
    expect(corrected).toBeDefined();
    expect(corrected?.['doc-panel']).toBe(0);
    expect(corrected?.['editor-main']).toBe(100);
  });

  test('revealing the agents panel keeps the open doc panel open despite a stale cached layout', async () => {
    // At 1400px the doc panel starts open. A stale three-panel cached layout
    // could say anything; the assert must restore the pre-reveal state (open)
    // at the persisted width, with the agents column at its own persisted width.
    setViewportWidth(1400);
    docCtx = DOC_LIVE_CTX;
    const view = render(<EditorArea {...baseProps} agentsVisible={false} />);
    groupLayout = { 'editor-main': 45, 'doc-panel': 25, 'agents-column': 30 };
    view.rerender(<EditorArea {...baseProps} agentsVisible />);
    await act(async () => {});
    const corrected = groupSetLayoutCalls.at(-1);
    expect(corrected).toBeDefined();
    // Exact pins against the mock's deterministic basis: doc panel at its
    // persisted default (320px), agents column at its persisted default (480px),
    // editor absorbing the remainder.
    expect(corrected?.['doc-panel']).toBeCloseTo(pctOf(320), 3);
    expect(corrected?.['agents-column']).toBeCloseTo(pctOf(480), 3);
    expect(corrected?.['editor-main']).toBeCloseTo(100 - pctOf(320) - pctOf(480), 3);
  });

  // react-resizable-panels caches one layout per panel-ID set and
  // restores it whenever the set changes, so any rail member that mounted and
  // unmounted would drag the whole rail back to the widths its absence was last
  // paired with — which stranded the agents column at zero width while the app
  // still believed it was open. These pin the fix at its root: the set never
  // changes, whatever the view.
  test('the rail keeps one panel-ID set from a document to a new tab', () => {
    setViewportWidth(1400);
    docCtx = DOC_LIVE_CTX;
    const view = render(<EditorArea {...baseProps} agentsVisible />);
    const withDocument = renderedPanelIds();
    expect(withDocument).toEqual(['doc-panel', 'terminal-column', 'agents-column']);

    docCtx = EMPTY_DOC_CTX;
    view.rerender(<EditorArea {...baseProps} agentsVisible />);

    expect(renderedPanelIds()).toEqual(withDocument);
    // Present, but holding nothing — a zero-width member, not an absent one.
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
    // A permanent member that holds nothing must not be able to take a flex
    // share, or it paints a gap the editor should own. RRP applies
    // `Math.min(maxSize, size)` last, so `maxSize: 0px` is what enforces it —
    // the handle's `display: none` covers the separator's own width.
    setViewportWidth(1400);
    docCtx = ASSET_DOC_CTX;
    const view = render(<EditorArea {...baseProps} agentsVisible />);
    expect(document.getElementById('doc-panel')?.dataset.maxSize).toBe('0px');

    // Filled again, the ceiling goes back to the pane's real drag limit.
    docCtx = DOC_LIVE_CTX;
    view.rerender(<EditorArea {...baseProps} agentsVisible />);
    expect(document.getElementById('doc-panel')?.dataset.maxSize).toBe('600px');
  });

  test('the mid-session load gap keeps the panel-ID set and fills the slot', () => {
    // The load-gap branch is the one that replaced the deleted placeholder
    // panel, so it is the single most important view to pin — and it is not
    // reachable by fixture alone. It needs a hash naming the incoming doc AND a
    // latched `everHadProvider`, so render a live provider first and re-render
    // (no cleanup) to keep the same component instance and its latch.
    setViewportWidth(1400);
    docCtx = FOLDER_LIVE_CTX;
    const view = render(<EditorArea {...baseProps} agentsVisible />);
    window.location.hash = '#/incoming-doc';
    docCtx = DOC_COLD_CTX;
    view.rerender(<EditorArea {...baseProps} agentsVisible />);

    // Guard the fixture itself: without the skeleton this test would silently
    // re-cover the empty state, which is what it did before.
    expect(screen.getByTestId('editor-skeleton')).toBeTruthy();
    expect(renderedPanelIds()).toEqual(['doc-panel', 'terminal-column', 'agents-column']);
    // Filled with the visual-only filler, so the slot holds its width across the
    // gap rather than collapsing and reopening when the doc lands.
    expect(document.getElementById('doc-panel')?.childElementCount).toBe(1);
    window.location.hash = '';
  });

  test('emptying the slot hands its width to the editor; refilling takes it back', async () => {
    // No visibility flag moves on a view switch, so the flag-keyed sync sits it
    // out. Without its own re-pin the emptied pane keeps the width the document
    // view left behind.
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
    // The merged slot answers to `isCollapsed`, which the separate agent panel
    // never did. `openActivityPanel` bumps the expand signal on every path into
    // agent mode, so the drill-in still opens against a collapsed pane — if it
    // did not, clicking an avatar would silently do nothing.
    setViewportWidth(1024); // below the threshold: the pane starts collapsed
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
    // The slot is a permanent member everywhere, so the chord must key off
    // whether this view HAS a document pane — not off the panel existing.
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
    // Drag-to-close: the pointerup handler checks the agents panel's
    // isCollapsed() and turns a snapped-shut column into a real hide.
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

  // A drag ends on `pointerup` OR `pointercancel`, and a cancelled pointer
  // fires NO pointerup — once the browser suppresses a pointer stream (touch
  // pan/zoom/scroll takeover, or the OS invalidating the pointer) no further
  // events arrive for that pointerId. The handles used to bind only
  // `pointerup`, so a cancelled gesture left the drag flag set forever, and
  // `assertRightRailLayout` bails while either flag is set — silently
  // disabling the doc-panel toggle, ⌥⌘B, the avatar-click expand and the
  // sticky-width re-pin.
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
    // Drop the assert the cancel itself issues (it restores the rail pins) so
    // what follows can only come from the panel-set change.
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
    // What the group holds mid-drag: the editor plus the column the drag has
    // been shrinking. The assert needs a live panel-ID set to correct against.
    groupLayout = { 'editor-main': 70, 'agents-column': 30 };
    const handle = getAgentsHandle();
    act(() => {
      fireEvent.pointerDown(handle);
    });
    // The drag had snapped the column shut, but the gesture was aborted rather
    // than released — the user never committed to closing it.
    panelIsCollapsed = true;
    act(() => {
      fireEvent.pointerCancel(window);
    });
    expect(visibleChanges).toHaveLength(0);
    // The column would otherwise sit at zero width while still counting as
    // visible: no reveal tab, no handle, no way back. The abort re-pins it.
    expect(groupSetLayoutCalls.at(-1)?.['agents-column']).toBeCloseTo(pctOf(480), 3);
  });

  // Unmounting mid-drag is the third drag-termination path (alongside release
  // and cancel) and the one with no natural trigger in the other tests: a
  // view-kind switch tears the subtree down while the pointer is still held.
  // Without the unmount detach, the still-registered `pointerup` would run
  // `onCommit` against a torn-down subtree and hide the agents panel the user
  // never asked to close.
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
    // The drag had snapped the column shut — so a surviving listener WOULD
    // commit the hide, which is what makes this assertion meaningful.
    panelIsCollapsed = true;
    act(() => {
      view.unmount();
    });
    act(() => {
      fireEvent.pointerUp(window, { pointerId: 1 });
    });
    expect(visibleChanges).toHaveLength(0);
  });

  // The drag-end listeners live on `window`, so every pointer on the page
  // reaches them. A second touch taken over by the browser for scrolling fires
  // `pointercancel` for ITS pointerId while this drag is still live; unscoped,
  // that would end the drag and re-pin the rail mid-gesture.
  test('a different pointer cancelling does not end an in-flight drag', async () => {
    setViewportWidth(1400);
    const view = render(<EditorArea {...baseProps} agentsVisible />);
    const handle = getAgentsHandle();
    act(() => {
      fireEvent.pointerDown(handle, { pointerId: 1 });
    });
    groupSetLayoutCalls = [];
    groupLayout = { 'editor-main': 70, 'agents-column': 30 };

    // A second, unrelated pointer is cancelled by the browser.
    act(() => {
      fireEvent.pointerCancel(window, { pointerId: 2 });
    });
    expect(groupSetLayoutCalls).toHaveLength(0);

    // The drag is still live, so the panel-set change must still be suppressed
    // (the assert bails while a drag flag is set) — proving the flag survived.
    view.rerender(<EditorArea {...baseProps} agentsVisible={false} />);
    await act(async () => {});
    expect(groupSetLayoutCalls).toHaveLength(0);

    // The originating pointer still ends it.
    act(() => {
      fireEvent.pointerCancel(window, { pointerId: 1 });
    });
    expect(groupSetLayoutCalls.length).toBeGreaterThan(0);
  });
});

// Exactly ONE panel advertises itself with a persistent edge tab, and EditorArea
// owns that one: the agents panel (an agent conversation is worth a one-click
// return, and a chord is not discoverable). The terminal deliberately has none —
// ⌘J and the View menu are its entry points. Its absence is asserted in
// TerminalDock.dom.test.tsx, which renders the real dock; TerminalDock is mocked
// here, so a terminal-tab assertion in this file could never fail.
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

  // Ungated on having conversations: a never-opened panel still advertises
  // itself, since its cold entry (the New button) is a fine place to land.
  // The reveal tab carries a Radix tooltip, so it needs the provider in scope.
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

  // Regression: the docked terminal must be mountable while a folder is the
  // active view too. The folder branch used to return <FolderOverview> bare, so
  // an "Open in terminal" launch (or ⌘J) set terminalVisible but had no dock to
  // open — the terminal never appeared.
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
    // The folder overview is wrapped by the dock so the terminal can open
    // beneath it.
    expect(dock.querySelector('[data-testid="folder-overview"]')).not.toBeNull();
  });

  test('renders the folder view; the dock shell is present but inactive on the web host', () => {
    renderEditorArea();

    // The dock shell is host-agnostic now (it can host thread tabs on web), so it
    // wraps the view, but with nothing docked it stays inactive.
    expect(screen.getByTestId('terminal-dock').getAttribute('data-visible')).toBe('false');
    expect(screen.getByTestId('folder-overview').textContent).toBe('folder');
  });
});

// The single hoisted dock (left column of the shared skeleton) must host every
// view. The asset and large-file views had no terminal coverage; these pin that
// the dock wraps each one, so a future regression that drops a view out of the
// skeleton (e.g. a bare early-return during a merge) turns the suite red.
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

// The dock is hoisted to one stable position in the EditorArea wrapper, so it
// must NOT remount as the active view kind changes underneath it. A remount
// would dispose xterm and kill the running PTY — the session reset users hit
// when switching/closing tabs.
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

    // folder -> asset -> large-file: the view inside the dock changes, but the
    // dock stays at the same wrapper position, so it must not remount.
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

    // No additional mounts across the two view-kind switches.
    expect(terminalDockMounts).toBe(mountsAfterInitial);
  });
});

// Locks the fix for the COLD-START path: on first load (no provider has
// ever been active), a hash-driven doc load renders the skeleton as a standalone
// early-return, NOT inside the shared panel group. There is no group state to
// preserve and nothing docked to keep alive on this path, so mounting a group to
// hold a skeleton buys nothing. (The e2e qa-sidebar also covers this; this is the
// fast guard.) The MID-SESSION counterpart — where the dock must persist — is
// the next describe block.
describe('EditorArea hash-load skeleton renders outside the panel group (cold start)', () => {
  beforeEach(() => {
    cleanup();
    // A doc target whose provider has not loaded — the actual hash-load scenario
    // (not the empty state). `everHadProvider` stays false on this single render
    // (DOC_COLD_CTX has a null provider), so the branch still takes the
    // cold-start bare early-return.
    docCtx = DOC_COLD_CTX;
  });
  afterEach(() => {
    window.location.hash = '';
  });

  test('renders the load skeleton directly, not inside the terminal dock or panel group', () => {
    // A hash naming a doc + a not-yet-ready provider, with no provider ever
    // active, is the cold-start load path.
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
    // Early return: no shared horizontal group and no terminal dock around it.
    expect(screen.queryByTestId('resizable-group')).toBeNull();
    expect(screen.queryByTestId('terminal-dock')).toBeNull();
  });
});

// The mid-session counterpart to the cold-start guard. Once a provider has
// been active, a transient provider-null render (closing a tab, or switching to
// a not-yet-ready doc) must keep the persistent left column — and the docked
// TerminalDock + its live PTY — mounted, instead of early-returning a bare
// skeleton that unmounts the dock and resets the terminal. The skeleton renders
// INSIDE the dock; the dock does not remount.
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
    // First render with a live provider latches `everHadProvider` true (its
    // effect flushes inside RTL's act wrapper).
    const { rerender } = render(<EditorArea {...props} />);
    const mountsAfterInitial = terminalDockMounts;
    expect(mountsAfterInitial).toBeGreaterThan(0);
    expect(
      screen.getByTestId('terminal-dock').querySelector('[data-testid="folder-overview"]'),
    ).not.toBeNull();

    // Now the provider goes null while the hash already names the next doc — the
    // close→neighbor gap. The bare-early-return regression would drop the dock
    // here (terminal-dock absent). The fix routes the skeleton through the dock.
    act(() => {
      docCtx = DOC_COLD_CTX;
      window.location.hash = '#/some-doc';
    });
    rerender(<EditorArea {...props} />);

    const dock = screen.getByTestId('terminal-dock');
    expect(dock.querySelector('[data-testid="editor-skeleton"]')).not.toBeNull();
    // No remount across the cold navigation — the PTY survives.
    expect(terminalDockMounts).toBe(mountsAfterInitial);
    // Mid-session skeleton routes THROUGH the shared group (not a bare
    // early-return) — the symmetric guard to the cold-start group-absent
    // assertion. Pins that the docked terminal's PTY survives the load gap: a
    // refactor that lifted the dock outside the group would unmount it here.
    expect(screen.getByTestId('resizable-group')).toBeTruthy();
  });

  test('web host keeps the bare early-return on mid-session cold nav (no dock to preserve)', () => {
    // No terminalBridge → the mid-session route-through gate
    // (`terminalBridge != null && everHadProvider`) is false regardless of
    // `everHadProvider`, so the skeleton stays a bare early-return outside the
    // group. Pins that the desktop-only fix does not change web-host behavior.
    const webProps = {
      editorMode: 'wysiwyg' as const,
      onModeChange: () => {},
      activeTab: 'timeline' as const,
      onActiveTabChange: () => {},
      // terminalBridge intentionally omitted (web host has no shell).
    };
    // FOLDER_LIVE_CTX (from beforeEach) has a live provider → `everHadProvider`
    // latches true after the first render.
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
