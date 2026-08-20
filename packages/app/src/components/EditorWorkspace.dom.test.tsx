import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { EditorPaneState } from '@/editor/editor-panes';
import { OK_SIDEBAR_DRAG_MIME, serializeSidebarDragPayload } from '@/lib/sidebar-drag';
import { renderLinguiTemplate } from '@/test-utils/lingui-mock';
import {
  expectVisualClassTokens,
  expectVisualClassTokensAbsent,
} from '@/test-utils/visual-contract';

const multiPaneFixture: EditorPaneState[] = [
  {
    id: 'pane-a',
    openTabs: ['docs/a', 'docs/b'],
    pinnedTabIds: [],
    activeTabId: 'docs/a',
    newTabIds: [],
    activeNewTabId: null,
    activeTarget: { kind: 'doc', target: 'docs/a', docName: 'docs/a' },
    size: 60,
  },
  {
    id: 'pane-b',
    openTabs: ['docs/c'],
    pinnedTabIds: [],
    activeTabId: 'docs/c',
    newTabIds: [],
    activeNewTabId: null,
    activeTarget: { kind: 'doc', target: 'docs/c', docName: 'docs/c' },
    size: 40,
  },
];
let panes = multiPaneFixture.map((pane) => ({ ...pane }));
let tabSessionLoaded = true;

const focusPane = vi.fn();
const moveTabToPane = vi.fn();
const openTarget = vi.fn();
const openTargetInPane = vi.fn();
const reorderTabsInPane = vi.fn();
const resizePanes = vi.fn();
const splitTab = vi.fn(() => 'pane-new');

let dndProps: Record<string, unknown> = {};
let dragOverlayProps: Record<string, unknown> = {};
let layoutChange: ((layout: Record<string, number>) => void) | undefined;
let layoutChanged:
  | ((layout: Record<string, number>, meta: { isUserInteraction: boolean }) => void)
  | undefined;
let overDroppableId: string | null = null;
const droppableData = new Map<string, unknown>();
const setLayout = vi.fn();

vi.doMock('@lingui/react/macro', async () => {
  const actual = await vi.importActual<typeof import('@lingui/react/macro')>('@lingui/react/macro');
  return {
    ...actual,
    Trans: ({ children }: { children?: ReactNode }) => <>{children}</>,
    useLingui: () => ({ t: renderLinguiTemplate }),
  };
});

vi.doMock('@dnd-kit/core', () => ({
  closestCenter: () => [],
  DndContext: (props: Record<string, unknown> & { children?: ReactNode }) => {
    dndProps = props;
    return <div data-testid="workspace-dnd">{props.children}</div>;
  },
  DragOverlay: (props: Record<string, unknown> & { children?: ReactNode }) => {
    dragOverlayProps = props;
    return <div data-testid="editor-tab-drag-overlay-host">{props.children}</div>;
  },
  KeyboardCode: {
    Enter: 'Enter',
    Esc: 'Escape',
    Space: 'Space',
  },
  KeyboardSensor: { name: 'KeyboardSensor' },
  PointerSensor: { name: 'PointerSensor' },
  useDroppable: ({ data, disabled, id }: { data: unknown; disabled?: boolean; id: string }) => {
    droppableData.set(id, data);
    return {
      isOver: !disabled && overDroppableId === id,
      setNodeRef: () => {},
    };
  },
  useSensor: (sensor: unknown, options: unknown) => ({ sensor, options }),
  useSensors: (...sensors: unknown[]) => sensors,
}));

vi.doMock('@dnd-kit/sortable', () => ({
  arrayMove: <T,>(items: T[], from: number, to: number) => {
    const next = [...items];
    const [item] = next.splice(from, 1);
    next.splice(to, 0, item);
    return next;
  },
  sortableKeyboardCoordinates: { name: 'sortableKeyboardCoordinates' },
}));

vi.doMock('react-resizable-panels', () => ({
  useGroupRef: () => ({ current: { setLayout } }),
}));

vi.doMock('@/components/ui/resizable', () => ({
  ResizablePanelGroup: ({
    children,
    onLayoutChange,
    onLayoutChanged,
    ...props
  }: {
    children?: ReactNode;
    onLayoutChange?: typeof layoutChange;
    onLayoutChanged?: typeof layoutChanged;
    [key: string]: unknown;
  }) => {
    layoutChange = onLayoutChange;
    layoutChanged = onLayoutChanged;
    return (
      <div data-testid="workspace-panel-group" data-orientation={String(props.orientation)}>
        {children}
      </div>
    );
  },
  ResizablePanel: ({
    children,
    id,
    minSize,
  }: {
    children?: ReactNode;
    id?: string;
    minSize?: string;
  }) => (
    <section data-panel-id={id} data-min-size={minSize}>
      {children}
    </section>
  ),
  ResizableHandle: (props: Record<string, unknown>) => (
    <div
      data-testid="pane-resize-handle"
      data-editor-pane-resize-handle={String(props['data-editor-pane-resize-handle'])}
      data-editor-pane-before={String(props['data-editor-pane-before'])}
      data-editor-pane-after={String(props['data-editor-pane-after'])}
    >
      {props.children as ReactNode}
    </div>
  ),
}));

vi.doMock('@/editor/DocumentContext', () => ({
  useDocumentContext: () => ({
    focusPane,
    focusedPaneId: 'pane-a',
    moveTabToPane,
    openTarget,
    openTargetInPane,
    panes,
    reorderTabsInPane,
    resizePanes,
    splitTab,
    tabSessionLoaded,
    visibleTabIdsByPane: new Map(
      panes.map((pane) => [pane.id, [...pane.openTabs, ...pane.newTabIds]]),
    ),
  }),
}));

vi.doMock('@/lib/single-file-mode', () => ({
  useSingleFileMode: () => false,
}));

vi.doMock('./EditorTabs', () => ({
  EditorTabs: ({
    dropIndicatorIndex,
    paneId,
    reserveLeadingChrome,
    reserveTrailingChrome,
  }: {
    dropIndicatorIndex?: number | null;
    paneId: string;
    reserveLeadingChrome?: boolean;
    reserveTrailingChrome?: boolean;
  }) => (
    <div
      data-editor-pane-tabs={paneId}
      data-drop-indicator-index={dropIndicatorIndex ?? undefined}
      data-reserve-leading-chrome={reserveLeadingChrome || undefined}
      data-reserve-trailing-chrome={reserveTrailingChrome || undefined}
    >
      Tabs {paneId}
    </div>
  ),
}));

const { EditorWorkspace } = await import('./EditorWorkspace');

function renderWorkspace(portaledPaneBody?: ReactNode) {
  return render(
    <EditorWorkspace
      renderHeader={(tabs) => <header data-testid="main-editor-header">{tabs}</header>}
      renderPane={({ activityMount, pane }) => (
        <div data-testid={`pane-body-${pane.id}`}>{activityMount}</div>
      )}
      renderActivityPool={({ activityHosts, parkingHost, visibleDocNames }) => {
        const paneBActivityHost = activityHosts.get('docs/c');
        return (
          <>
            <div
              data-testid="activity-bindings"
              data-hosts={[...activityHosts.keys()].join(',')}
              data-visible={[...visibleDocNames].join(',')}
              data-parking={String(parkingHost !== null)}
            />
            {portaledPaneBody && paneBActivityHost
              ? createPortal(portaledPaneBody, paneBActivityHost)
              : null}
          </>
        );
      }}
    />,
  );
}

function latestDndProps() {
  type MockDragEvent = {
    active: {
      data: { current: unknown };
      rect?: { current: { translated: DOMRect | null } };
    };
    delta?: { x: number; y: number };
    over: { data: { current: unknown }; rect?: DOMRect } | null;
  };
  return dndProps as {
    accessibility?: {
      container?: HTMLElement;
      screenReaderInstructions?: { draggable?: string };
      announcements?: {
        onDragStart?: (event: { active: { data: { current: unknown } } }) => string | undefined;
        onDragOver?: (event: {
          active: { data: { current: unknown } };
          over: { data: { current: unknown } } | null;
        }) => string | undefined;
      };
    };
    modifiers?: unknown[];
    onDragStart?: (event: { active: { data: { current: unknown } } }) => void;
    onDragMove?: (event: MockDragEvent) => void;
    onDragOver?: (event: MockDragEvent) => void;
    onDragEnd?: (event: MockDragEvent) => void;
    onDragCancel?: () => void;
  };
}

function tabDrag(paneId: string, tabId: string) {
  return {
    kind: 'editor-tab' as const,
    paneId,
    tabId,
    splittable: true,
    label: tabId,
  };
}

describe('EditorWorkspace', () => {
  beforeEach(() => {
    panes = multiPaneFixture.map((pane) => ({ ...pane }));
    tabSessionLoaded = true;
    dndProps = {};
    dragOverlayProps = {};
    layoutChange = undefined;
    layoutChanged = undefined;
    overDroppableId = null;
    droppableData.clear();
    document.body.removeAttribute('data-editor-tab-dragging');
    for (const mock of [
      focusPane,
      moveTabToPane,
      openTarget,
      openTargetInPane,
      reorderTabsInPane,
      resizePanes,
      splitTab,
      setLayout,
    ]) {
      mock.mockClear();
    }
    splitTab.mockReturnValue('pane-new');
  });

  afterEach(() => {
    cleanup();
  });

  test('renders one flat horizontal panel per pane with stable resize selectors', () => {
    const { container } = renderWorkspace();

    expect(screen.getByTestId('workspace-panel-group').dataset.orientation).toBe('horizontal');
    expect(container.querySelector('[data-editor-workspace]')).toBeTruthy();
    expect(container.querySelector('[data-editor-workspace-canvas]')).toBeTruthy();
    expect(container.querySelectorAll('[data-editor-pane-id="pane-a"]')).not.toHaveLength(0);
    expect(container.querySelectorAll('[data-editor-pane-id="pane-b"]')).not.toHaveLength(0);
    expect(
      container
        .querySelector('[data-panel-id="editor-pane:pane-a"]')
        ?.getAttribute('data-min-size'),
    ).toBe('300px');
    expect(screen.getAllByTestId('pane-resize-handle')).toHaveLength(1);
    expect(screen.getByTestId('pane-resize-handle').dataset.editorPaneBefore).toBe('pane-a');
    expect(screen.getByTestId('pane-resize-handle').dataset.editorPaneAfter).toBe('pane-b');
    const header = screen.getByTestId('main-editor-header');
    expect(header.querySelector('[data-editor-pane-tabs="pane-a"]')).toBeTruthy();
    expect(header.querySelector('[data-editor-pane-tabs="pane-b"]')).toBeTruthy();
    expect(
      header
        .querySelector('[data-editor-pane-tabs="pane-a"]')
        ?.parentElement?.getAttribute('data-editor-pane-focused'),
    ).toBe('true');
    const focusedTabGroup = header.querySelector<HTMLElement>(
      '[data-editor-pane-tab-group="pane-a"]',
    );
    const unfocusedTabGroup = header.querySelector<HTMLElement>(
      '[data-editor-pane-tab-group="pane-b"]',
    );
    expectVisualClassTokensAbsent(focusedTabGroup?.className ?? '', ['after:bg-primary']);
    expectVisualClassTokensAbsent(unfocusedTabGroup?.className ?? '', ['after:bg-primary']);
    const firstPane = container.querySelector('[data-editor-pane-id="pane-a"]');
    const secondPane = container.querySelector('[data-editor-pane-id="pane-b"]');
    expect(firstPane?.querySelector('[data-editor-pane-tabs]')).toBeNull();
    expect(secondPane?.querySelector('[data-editor-pane-tabs]')).toBeNull();
    expect(screen.getByRole('region', { name: 'pane 1' })).toBe(firstPane);
    expect(firstPane?.getAttribute('aria-label')).toBe('pane 1');
    expect(firstPane?.getAttribute('aria-current')).toBe('true');
    expect(secondPane?.getAttribute('aria-label')).toBe('pane 2');
    expect(secondPane?.getAttribute('aria-current')).toBeNull();
  });

  test('does not paint a temporary desktop pane layout before session restore settles', () => {
    const previousDesktopBridge = window.okDesktop;
    Object.defineProperty(window, 'okDesktop', {
      configurable: true,
      writable: true,
      value: { config: { mode: 'editor' } },
    });
    tabSessionLoaded = false;

    const view = renderWorkspace();

    expect(screen.getByTestId('main-editor-header').children).toHaveLength(0);
    expect(view.container.querySelector('[data-editor-workspace-pending]')).toBeTruthy();
    expect(view.container.querySelector('[data-editor-pane-id]')).toBeNull();

    tabSessionLoaded = true;
    view.rerender(
      <EditorWorkspace
        renderHeader={(tabs) => <header data-testid="main-editor-header">{tabs}</header>}
        renderPane={({ pane }) => <div data-testid={`pane-body-${pane.id}`} />}
      />,
    );

    expect(view.container.querySelector('[data-editor-workspace-pending]')).toBeNull();
    expect(view.container.querySelector('[data-editor-pane-id="pane-a"]')).toBeTruthy();
    Object.defineProperty(window, 'okDesktop', {
      configurable: true,
      writable: true,
      value: previousDesktopBridge,
    });
  });

  test('keeps header tab groups on the pane canvas geometry and scroll position', () => {
    const { container } = renderWorkspace();
    const workspace = container.querySelector<HTMLElement>('[data-editor-workspace]');
    const headerCanvas = container.querySelector<HTMLElement>('[data-editor-header-tab-canvas]');
    const headerGroups = [
      ...container.querySelectorAll<HTMLElement>('[data-editor-pane-tab-group]'),
    ];

    expect(headerCanvas).toBeTruthy();
    expect(headerCanvas?.classList.contains('min-w-(--editor-workspace-min-width)')).toBe(true);
    expect(headerCanvas?.style.getPropertyValue('--editor-workspace-min-width')).toBe(
      'max(100%, 600px)',
    );
    expect(headerGroups).toHaveLength(2);
    expect(headerGroups[0]?.classList.contains('basis-0')).toBe(true);
    expect(headerGroups[0]?.style.flexGrow).toBe('60');
    expect(headerGroups[1]?.classList.contains('basis-0')).toBe(true);
    expect(headerGroups[1]?.style.flexGrow).toBe('40');
    expect(container.querySelectorAll('[data-editor-header-pane-separator]')).toHaveLength(1);
    expect(headerGroups[0]?.querySelector('[data-reserve-leading-chrome="true"]')).toBeTruthy();
    expect(headerGroups[1]?.querySelector('[data-reserve-trailing-chrome="true"]')).toBeTruthy();

    if (!workspace || !headerCanvas) throw new Error('Expected workspace and header canvas');
    workspace.scrollLeft = 96;
    fireEvent.scroll(workspace);
    expect(headerCanvas.style.transform).toBe('translateX(-96px)');
  });

  test('resizes header tab groups continuously before persisting the panel layout', () => {
    const { container } = renderWorkspace();
    const headerGroups = [
      ...container.querySelectorAll<HTMLElement>('[data-editor-pane-tab-group]'),
    ];

    act(() => layoutChange?.({ 'editor-pane:pane-a': 72, 'editor-pane:pane-b': 28 }));

    expect(headerGroups[0]?.style.flexGrow).toBe('72');
    expect(headerGroups[1]?.style.flexGrow).toBe('28');
    expect(resizePanes).not.toHaveBeenCalled();

    act(() =>
      layoutChanged?.(
        { 'editor-pane:pane-a': 72, 'editor-pane:pane-b': 28 },
        { isUserInteraction: true },
      ),
    );
    expect(resizePanes).toHaveBeenCalledWith(
      new Map([
        ['pane-a', 72],
        ['pane-b', 28],
      ]),
    );
  });

  test('adopts the resolved pane layout on a header canvas that mounts after it', () => {
    // The real header canvas is portaled into the app header, so it can mount a
    // commit after the panel group reports its layout. A restored session
    // reports once, on mount: if that report is lost the tab groups keep the
    // persisted percentages while the panes render the layout the pane minimum
    // forced, and nothing ever reconciles them.
    const view = render(
      <EditorWorkspace
        renderHeader={() => <header data-testid="main-editor-header" />}
        renderPane={({ pane }) => <div data-testid={`pane-body-${pane.id}`} />}
      />,
    );
    expect(view.container.querySelector('[data-editor-pane-tab-group]')).toBeNull();

    // What the panel group resolves once MIN_EDITOR_PANE_WIDTH raises pane-b:
    // not the 60/40 the panes carry as their persisted size.
    act(() => layoutChange?.({ 'editor-pane:pane-a': 45, 'editor-pane:pane-b': 55 }));

    view.rerender(
      <EditorWorkspace
        renderHeader={(tabs) => <header data-testid="main-editor-header">{tabs}</header>}
        renderPane={({ pane }) => <div data-testid={`pane-body-${pane.id}`} />}
      />,
    );

    const headerGroups = [
      ...view.container.querySelectorAll<HTMLElement>('[data-editor-pane-tab-group]'),
    ];
    expect(headerGroups).toHaveLength(2);
    expect(headerGroups[0]?.style.flexGrow).toBe('45');
    expect(headerGroups[1]?.style.flexGrow).toBe('55');
  });

  test('does not replay a resolved layout onto a different pane set', () => {
    // The replay is keyed on the pane set it was resolved for. A layout the
    // group resolved for {pane-a, pane-b} describes nothing about a workspace
    // that now holds {pane-a, pane-c}, and replaying it would hold the
    // surviving strip at a share the panes no longer render — the mirror image
    // of the misalignment this fix removes. The mocked group does not report
    // again on re-render, which is what isolates the guard here.
    const workspace = () => (
      <EditorWorkspace
        renderHeader={(tabs) => <header data-testid="main-editor-header">{tabs}</header>}
        renderPane={({ pane }) => <div data-testid={`pane-body-${pane.id}`} />}
      />
    );
    const view = render(workspace());
    act(() => layoutChange?.({ 'editor-pane:pane-a': 45, 'editor-pane:pane-b': 55 }));
    expect(
      view.container.querySelector<HTMLElement>('[data-editor-pane-tab-group]')?.style.flexGrow,
    ).toBe('45');

    // pane-b is gone and pane-a carries a new size, so the stale 45 and the
    // value this pane set actually renders are distinguishable.
    panes = [
      { ...multiPaneFixture[0], size: 70 },
      { ...multiPaneFixture[1], id: 'pane-c', size: 30 },
    ];
    view.rerender(workspace());

    const groups = [
      ...view.container.querySelectorAll<HTMLElement>('[data-editor-pane-tab-group]'),
    ];
    expect(groups.map((group) => group.dataset.editorPaneTabGroup)).toEqual(['pane-a', 'pane-c']);
    expect(groups[0]?.style.flexGrow).toBe('70');
    expect(groups[1]?.style.flexGrow).toBe('30');
  });

  test('omits the focused tab-strip accent in single-pane mode', () => {
    panes = [
      {
        id: 'pane-a',
        openTabs: ['docs/a'],
        pinnedTabIds: [],
        activeTabId: 'docs/a',
        newTabIds: [],
        activeNewTabId: null,
        activeTarget: { kind: 'doc', target: 'docs/a', docName: 'docs/a' },
        size: 100,
      },
    ];

    const { container } = renderWorkspace();
    const pane = container.querySelector('[data-editor-pane-id="pane-a"]');
    const tabGroup = container.querySelector<HTMLElement>('[data-editor-pane-tab-group="pane-a"]');

    expect(pane?.getAttribute('aria-current')).toBe('true');
    expect(pane?.getAttribute('data-editor-pane-focused')).toBe('true');
    expectVisualClassTokensAbsent(tabGroup?.className ?? '', ['after:bg-primary']);
  });

  test('keeps a dragged tab visible outside the clipped header until the drag ends', () => {
    renderWorkspace();
    const active = tabDrag('pane-a', 'docs/b');

    expect(screen.queryByTestId('editor-tab-drag-overlay')).toBeNull();
    act(() => latestDndProps().onDragStart?.({ active: { data: { current: active } } }));
    const overlay = screen.getByTestId('editor-tab-drag-overlay');
    expect(overlay.textContent).toBe('docs/b');
    expect(overlay.className).toContain('w-44');
    expect(overlay.className).toContain('cursor-grabbing');
    expect(dragOverlayProps.dropAnimation).toBeNull();
    expect(document.body.hasAttribute('data-editor-tab-dragging')).toBe(true);

    act(() =>
      latestDndProps().onDragEnd?.({
        active: { data: { current: active } },
        over: null,
      }),
    );
    expect(screen.queryByTestId('editor-tab-drag-overlay')).toBeNull();
    expect(document.body.hasAttribute('data-editor-tab-dragging')).toBe(false);
    expect(moveTabToPane).not.toHaveBeenCalled();
    expect(reorderTabsInPane).not.toHaveBeenCalled();
    expect(splitTab).not.toHaveBeenCalled();
  });

  test('moves a primary insertion boundary without moving the tab row', () => {
    const { container } = renderWorkspace();
    const active = tabDrag('pane-a', 'docs/b');

    act(() => latestDndProps().onDragStart?.({ active: { data: { current: active } } }));
    act(() =>
      latestDndProps().onDragMove?.({
        active: {
          data: { current: active },
          rect: { current: { translated: { left: 180, width: 40 } as DOMRect } },
        },
        over: {
          data: { current: tabDrag('pane-b', 'docs/c') },
          rect: { left: 100, width: 100 } as DOMRect,
        },
      }),
    );

    expect(
      container
        .querySelector('[data-editor-pane-tabs="pane-b"]')
        ?.getAttribute('data-drop-indicator-index'),
    ).toBe('1');
    expect(
      container
        .querySelector('[data-editor-pane-tabs="pane-a"]')
        ?.getAttribute('data-drop-indicator-index'),
    ).toBeNull();

    act(() => latestDndProps().onDragCancel?.());
    expect(container.querySelector('[data-drop-indicator-index]')).toBeNull();
  });

  test('shows the separator before an earlier tab as soon as a leftward drag enters it', () => {
    const { container } = renderWorkspace();
    const active = tabDrag('pane-a', 'docs/b');

    act(() => latestDndProps().onDragStart?.({ active: { data: { current: active } } }));
    act(() =>
      latestDndProps().onDragMove?.({
        active: {
          data: { current: active },
          rect: { current: { translated: { left: 80, width: 40 } as DOMRect } },
        },
        delta: { x: -2, y: 0 },
        over: {
          data: { current: tabDrag('pane-a', 'docs/a') },
          rect: { left: 0, width: 100 } as DOMRect,
        },
      }),
    );

    expect(
      container
        .querySelector('[data-editor-pane-tabs="pane-a"]')
        ?.getAttribute('data-drop-indicator-index'),
    ).toBe('0');
  });

  test('hides separators for no-op boundaries around the dragged tab', () => {
    const { container } = renderWorkspace();
    const active = tabDrag('pane-a', 'docs/b');

    act(() => latestDndProps().onDragStart?.({ active: { data: { current: active } } }));
    for (const x of [-2, 2]) {
      act(() =>
        latestDndProps().onDragMove?.({
          active: {
            data: { current: active },
            rect: { current: { translated: { left: 100 + x, width: 100 } as DOMRect } },
          },
          delta: { x, y: 0 },
          over: {
            data: { current: active },
            rect: { left: 100, width: 100 } as DOMRect,
          },
        }),
      );
      expect(container.querySelector('[data-drop-indicator-index]')).toBeNull();
    }

    act(() =>
      latestDndProps().onDragEnd?.({
        active: { data: { current: active } },
        delta: { x: 2, y: 0 },
        over: { data: { current: active } },
      }),
    );
    expect(reorderTabsInPane).not.toHaveBeenCalled();
  });

  test('exposes visible document hosts and one hidden parking mount', async () => {
    const { container } = renderWorkspace();
    await act(async () => {});

    expect(
      container
        .querySelector('[data-editor-activity-mount="pane-a"]')
        ?.getAttribute('data-doc-name'),
    ).toBe('docs/a');
    expect(
      container
        .querySelector('[data-editor-activity-mount="pane-b"]')
        ?.getAttribute('data-doc-name'),
    ).toBe('docs/c');
    expect(container.querySelectorAll('[data-editor-activity-parking]')).toHaveLength(1);
    expect(screen.getByTestId('activity-bindings').dataset.visible).toBe('docs/a,docs/c');
  });

  test('focuses a pane from pointer and keyboard focus capture', () => {
    const { container } = renderWorkspace();
    const pane = container.querySelector<HTMLElement>('[data-editor-pane-id="pane-b"]');
    const activityMount = container.querySelector<HTMLElement>(
      '[data-editor-activity-mount="pane-b"]',
    );
    expect(pane).toBeTruthy();
    expect(activityMount).toBeTruthy();

    fireEvent.pointerDown(pane as HTMLElement);
    fireEvent.focusIn(pane as HTMLElement);
    expect(focusPane).toHaveBeenCalledTimes(2);

    focusPane.mockClear();
    fireEvent.pointerDown(activityMount as HTMLElement);

    expect(focusPane).toHaveBeenCalled();
    expect(focusPane).toHaveBeenLastCalledWith('pane-b');
  });

  test('accepts a sidebar file before its drag payload is readable and opens it on drop', () => {
    panes = [
      multiPaneFixture[0],
      {
        ...multiPaneFixture[1],
        activeTabId: null,
        newTabIds: ['new-tab:1'],
        activeNewTabId: 'new-tab:1',
        activeTarget: null,
      },
    ];
    const { container } = renderWorkspace();
    const pane = container.querySelector<HTMLElement>('[data-editor-pane-id="pane-b"]');
    let payloadReadable = false;
    const dataTransfer = {
      types: [OK_SIDEBAR_DRAG_MIME],
      getData: (type: string) =>
        type === OK_SIDEBAR_DRAG_MIME && payloadReadable
          ? serializeSidebarDragPayload({
              v: 1,
              kind: 'doc',
              docName: 'notes/Dragged',
              size: null,
            })
          : '',
      dropEffect: 'none',
    };

    fireEvent.dragOver(pane as HTMLElement, { dataTransfer });
    expect(pane?.getAttribute('data-sidebar-drop-active')).toBe('true');
    expect(dataTransfer.dropEffect).toBe('copy');
    expectVisualClassTokens(pane?.className ?? '', [
      'after:bg-primary/5',
      'after:ring-2',
      'after:ring-primary/70',
      'after:ring-inset',
    ]);
    expectVisualClassTokensAbsent(pane?.className ?? '', [
      'after:border-muted-foreground/35',
      'after:bg-muted/15',
    ]);

    payloadReadable = true;
    fireEvent.drop(pane as HTMLElement, { dataTransfer });

    expect(openTargetInPane).toHaveBeenCalledWith(
      'pane-b',
      { kind: 'doc', target: 'notes/Dragged', docName: 'notes/Dragged' },
      { disposition: 'permanent', consumeActiveNewTab: true },
    );
    expect(pane?.getAttribute('data-sidebar-drop-active')).toBeNull();
  });

  test('captures a sidebar drop from portaled editor DOM before the editor consumes it', () => {
    const consumeDrop = vi.fn((event: Event) => {
      event.preventDefault();
      event.stopPropagation();
    });
    const { container } = renderWorkspace(<div data-testid="portaled-pane-body" />);
    const portaledPaneBody = screen.getByTestId('portaled-pane-body');
    portaledPaneBody.addEventListener('drop', consumeDrop);
    const dataTransfer = {
      types: [OK_SIDEBAR_DRAG_MIME],
      getData: (type: string) =>
        type === OK_SIDEBAR_DRAG_MIME
          ? serializeSidebarDragPayload({
              v: 1,
              kind: 'doc',
              docName: 'notes/Nested',
              size: null,
            })
          : '',
      dropEffect: 'none',
    };

    expect(portaledPaneBody.closest('[data-editor-activity-mount="pane-b"]')).not.toBeNull();
    fireEvent.drop(portaledPaneBody, { dataTransfer });

    expect(openTargetInPane).toHaveBeenCalledTimes(1);
    expect(openTargetInPane).toHaveBeenCalledWith(
      'pane-b',
      { kind: 'doc', target: 'notes/Nested', docName: 'notes/Nested' },
      { disposition: 'permanent', consumeActiveNewTab: false },
    );
    expect(consumeDrop).not.toHaveBeenCalled();
    expect(
      container
        .querySelector('[data-editor-pane-id="pane-b"]')
        ?.getAttribute('data-sidebar-drop-active'),
    ).toBeNull();
    portaledPaneBody.removeEventListener('drop', consumeDrop);
  });

  test('clears the sidebar preview without consuming a malformed custom drop', () => {
    const { container } = renderWorkspace();
    const pane = container.querySelector<HTMLElement>('[data-editor-pane-id="pane-b"]');
    const nestedPaneBody = screen.getByTestId('pane-body-pane-b');
    const nestedDrop = vi.fn();
    nestedPaneBody.addEventListener('drop', nestedDrop);
    const dataTransfer = {
      types: [OK_SIDEBAR_DRAG_MIME],
      getData: () => '{',
      dropEffect: 'none',
    };

    fireEvent.dragOver(nestedPaneBody, { dataTransfer });
    expect(pane?.getAttribute('data-sidebar-drop-active')).toBe('true');

    fireEvent.drop(nestedPaneBody, { dataTransfer });

    expect(nestedDrop).toHaveBeenCalledTimes(1);
    expect(openTarget).not.toHaveBeenCalled();
    expect(pane?.getAttribute('data-sidebar-drop-active')).toBeNull();

    nestedPaneBody.removeEventListener('drop', nestedDrop);
  });

  test('clears the sidebar preview when the source drag ends outside the pane', () => {
    const { container } = renderWorkspace();
    const pane = container.querySelector<HTMLElement>('[data-editor-pane-id="pane-b"]');
    const dataTransfer = {
      types: [OK_SIDEBAR_DRAG_MIME],
      getData: () => '',
      dropEffect: 'none',
    };

    fireEvent.dragOver(pane as HTMLElement, { dataTransfer });
    expect(pane?.getAttribute('data-sidebar-drop-active')).toBe('true');

    fireEvent.dragEnd(window);

    expect(pane?.getAttribute('data-sidebar-drop-active')).toBeNull();
    expectVisualClassTokensAbsent(pane?.className ?? '', [
      'after:bg-primary/5',
      'after:ring-2',
      'after:ring-primary/70',
      'after:ring-inset',
    ]);
  });

  test('prioritizes edge splits and clears the preview after drop', () => {
    const { container, rerender } = renderWorkspace();
    const active = tabDrag('pane-a', 'docs/b');

    act(() => latestDndProps().onDragStart?.({ active: { data: { current: active } } }));
    overDroppableId = 'editor-pane-edge:pane-b:right';
    rerender(
      <EditorWorkspace
        renderHeader={(tabs) => <header data-testid="main-editor-header">{tabs}</header>}
        renderPane={({ pane }) => <div data-testid={`pane-body-${pane.id}`} />}
      />,
    );

    expect(
      container
        .querySelector('[data-pane-edge="right"][data-editor-pane-id="pane-b"]')
        ?.getAttribute('data-pane-drop-side'),
    ).toBe('right');
    const highlightedEdge = container.querySelector(
      '[data-pane-edge="right"][data-editor-pane-id="pane-b"]',
    );
    expect(highlightedEdge?.textContent).toBe('');
    expect(highlightedEdge?.querySelector('svg')).toBeNull();

    act(() =>
      latestDndProps().onDragEnd?.({
        active: { data: { current: active } },
        over: {
          data: {
            current: { kind: 'pane-edge', paneId: 'pane-b', side: 'right' },
          },
        },
      }),
    );

    expect(splitTab).toHaveBeenCalledWith('docs/b', 'pane-b', 'right');
    expect(
      container
        .querySelector('[data-pane-edge="right"][data-editor-pane-id="pane-b"]')
        ?.getAttribute('data-pane-drop-side'),
    ).toBeNull();
  });

  test('shows one monolithic split highlight across an internal pane boundary', () => {
    const { container, rerender } = renderWorkspace();
    const active = tabDrag('pane-a', 'docs/b');
    const boundary = () => container.querySelector<HTMLElement>('[data-pane-boundary-drop]');

    act(() => latestDndProps().onDragStart?.({ active: { data: { current: active } } }));
    overDroppableId = 'editor-pane-edge:pane-a:right';
    rerender(
      <EditorWorkspace
        renderHeader={(tabs) => <header data-testid="main-editor-header">{tabs}</header>}
        renderPane={({ pane }) => <div data-testid={`pane-body-${pane.id}`} />}
      />,
    );

    expect(container.querySelectorAll('[data-pane-drop-side]')).toHaveLength(1);
    expect(boundary()?.getAttribute('data-pane-drop-side')).toBe('right');
    expectVisualClassTokens(boundary()?.className ?? '', [
      'w-24',
      '-translate-x-1/2',
      'bg-primary/15',
      'ring-primary',
    ]);
    expect(boundary()?.textContent).toBe('');
    expect(boundary()?.querySelector('svg')).toBeNull();

    overDroppableId = 'editor-pane-edge:pane-b:left';
    rerender(
      <EditorWorkspace
        renderHeader={(tabs) => <header data-testid="main-editor-header">{tabs}</header>}
        renderPane={({ pane }) => <div data-testid={`pane-body-${pane.id}`} />}
      />,
    );

    expect(container.querySelectorAll('[data-pane-drop-side]')).toHaveLength(1);
    expect(boundary()?.getAttribute('data-pane-drop-side')).toBe('left');
    expectVisualClassTokensAbsent(boundary()?.className ?? '', ['transition-opacity']);
  });

  test('lets a blank tab drag to a pane edge and participate in combined tab order', () => {
    panes = [
      {
        ...multiPaneFixture[0],
        newTabIds: ['new-tab:1'],
        activeNewTabId: 'new-tab:1',
        activeTabId: null,
        activeTarget: null,
      },
      multiPaneFixture[1],
    ];
    renderWorkspace();
    const active = tabDrag('pane-a', 'new-tab:1');

    act(() =>
      latestDndProps().onDragEnd?.({
        active: { data: { current: active } },
        over: {
          data: {
            current: { kind: 'pane-edge', paneId: 'pane-b', side: 'left' },
          },
        },
      }),
    );

    expect(splitTab).toHaveBeenCalledWith('new-tab:1', 'pane-b', 'left');

    act(() =>
      latestDndProps().onDragEnd?.({
        active: { data: { current: active } },
        over: { data: { current: tabDrag('pane-a', 'docs/a') } },
      }),
    );
    expect(reorderTabsInPane).toHaveBeenCalledWith(
      'pane-a',
      ['new-tab:1', 'docs/a', 'docs/b'],
      'new-tab:1',
    );
  });

  test('moves across panes, reorders in one strip, and ignores cancellation', () => {
    renderWorkspace();

    act(() =>
      latestDndProps().onDragEnd?.({
        active: { data: { current: tabDrag('pane-a', 'docs/b') } },
        over: { data: { current: tabDrag('pane-b', 'docs/c') } },
      }),
    );
    expect(moveTabToPane).toHaveBeenCalledWith('docs/b', 'pane-b', 0);

    act(() =>
      latestDndProps().onDragEnd?.({
        active: { data: { current: tabDrag('pane-a', 'docs/b') } },
        over: { data: { current: tabDrag('pane-a', 'docs/a') } },
      }),
    );
    expect(reorderTabsInPane).toHaveBeenCalledWith('pane-a', ['docs/b', 'docs/a'], 'docs/b');

    latestDndProps().onDragCancel?.();
    expect(splitTab).not.toHaveBeenCalled();
  });

  test('persists only user-authored pane resize layouts', () => {
    renderWorkspace();

    act(() => {
      layoutChanged?.(
        { 'editor-pane:pane-a': 45, 'editor-pane:pane-b': 55 },
        { isUserInteraction: false },
      );
    });
    expect(resizePanes).not.toHaveBeenCalled();

    act(() => {
      layoutChanged?.(
        { 'editor-pane:pane-a': 45, 'editor-pane:pane-b': 55 },
        { isUserInteraction: true },
      );
    });
    expect(resizePanes).toHaveBeenCalledWith(
      new Map([
        ['pane-a', 45],
        ['pane-b', 55],
      ]),
    );
  });

  test('portals dnd accessibility output to document.body', () => {
    renderWorkspace();
    const accessibility = latestDndProps().accessibility;
    expect(accessibility?.container).toBe(document.body);
    expect(accessibility?.screenReaderInstructions?.draggable).toContain('Shift+F10');
    expect(accessibility?.screenReaderInstructions?.draggable).toContain('Menu key');
    expect(accessibility?.screenReaderInstructions?.draggable).toContain('close');
    expect(accessibility?.screenReaderInstructions?.draggable).toContain('pin');
    expect(
      accessibility?.announcements?.onDragStart?.({
        active: { data: { current: tabDrag('pane-a', 'docs/a') } },
      }),
    ).toBe('Picked up docs/a from pane 1.');
    expect(
      accessibility?.announcements?.onDragOver?.({
        active: { data: { current: tabDrag('pane-a', 'docs/a') } },
        over: {
          data: { current: { kind: 'pane-edge', paneId: 'pane-b', side: 'right' } },
        },
      }),
    ).toBe('docs/a is over a new pane to the right of pane 2.');
  });
});
