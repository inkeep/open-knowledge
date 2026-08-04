import {
  DndContext,
  type DragEndEvent,
  DragOverlay,
  type DragStartEvent,
  KeyboardSensor,
  PointerSensor,
  useDroppable,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import { arrayMove, sortableKeyboardCoordinates } from '@dnd-kit/sortable';
import { useLingui } from '@lingui/react/macro';
import {
  type CSSProperties,
  Fragment,
  type ReactNode,
  type UIEvent,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { docNameForNavigationTarget } from '@/components/navigation-targets';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable';
import { useDocumentContext } from '@/editor/DocumentContext';
import type { EditorPaneState, PaneSide } from '@/editor/editor-panes';
import { openSidebarDropPayload } from '@/editor/sidebar-drop';
import { hasSidebarDragType, parseSidebarDragPayload } from '@/lib/sidebar-drag';
import { useSingleFileMode } from '@/lib/single-file-mode';
import { cn } from '@/lib/utils';
import { EditorTabs } from './EditorTabs';
import {
  type EditorTabDragData,
  editorWorkspaceCollisionDetection,
  findEditorTabElement,
  isEditorTabDragData,
  isEditorTabDropData,
  TAB_KEYBOARD_DRAG_CODES,
} from './editor-tabs-chrome';

const MIN_EDITOR_PANE_WIDTH = 300;

export interface EditorWorkspaceActivityBindings {
  activityHosts: ReadonlyMap<string, HTMLElement>;
  parkingHost: HTMLElement | null;
  visibleDocNames: ReadonlySet<string>;
}

export interface EditorWorkspacePaneRenderContext {
  pane: EditorPaneState;
  isFocused: boolean;
  activityDocName: string | null;
  activityMount: ReactNode;
}

interface EditorWorkspaceProps {
  renderHeader: (tabs: ReactNode) => ReactNode;
  renderPane: (context: EditorWorkspacePaneRenderContext) => ReactNode;
  renderActivityPool?: (bindings: EditorWorkspaceActivityBindings) => ReactNode;
}

interface TabDropPlacement {
  indicatorIndex: number;
  pane: EditorPaneState;
  targetIndex: number;
  targetOrder: readonly string[];
}

type TabDropEvent = Pick<DragEndEvent, 'active' | 'over'> & Partial<Pick<DragEndEvent, 'delta'>>;

function activityDocNameForPane(pane: EditorPaneState): string | null {
  if (pane.activeTarget?.kind === 'large-file') return null;
  return pane.activeTarget ? docNameForNavigationTarget(pane.activeTarget) : null;
}

function PaneStripDropTarget({
  children,
  index,
  isFocused,
  paneId,
  size,
}: {
  children: ReactNode;
  index: number;
  isFocused: boolean;
  paneId: string;
  size: number;
}) {
  const { setNodeRef } = useDroppable({
    id: `editor-pane-strip:${paneId}`,
    data: { kind: 'pane-strip', paneId, index },
  });
  return (
    <div
      ref={setNodeRef}
      data-editor-pane-tab-group={paneId}
      data-editor-pane-focused={isFocused || undefined}
      className="relative h-full min-w-0 shrink basis-0"
      style={{ flexGrow: size }}
    >
      {children}
    </div>
  );
}

function PaneEdgeDropTarget({
  drag,
  paneId,
  side,
}: {
  drag: EditorTabDragData | null;
  paneId: string;
  side: PaneSide;
}) {
  const { isOver, setNodeRef } = useDroppable({
    id: `editor-pane-edge:${paneId}:${side}`,
    data: { kind: 'pane-edge', paneId, side },
    disabled: drag?.splittable !== true,
  });
  return (
    <div
      ref={setNodeRef}
      aria-hidden="true"
      data-pane-edge={side}
      data-editor-pane-id={paneId}
      data-pane-drop-side={isOver ? side : undefined}
      className={cn(
        'pointer-events-none absolute inset-y-0 z-30 w-12 opacity-0',
        side === 'left' ? 'left-0' : 'right-0',
        isOver && 'bg-primary/15 opacity-100 ring-2 ring-primary ring-inset',
      )}
    />
  );
}

function PaneBoundaryDropTarget({
  drag,
  leftPaneId,
  rightPaneId,
}: {
  drag: EditorTabDragData | null;
  leftPaneId: string;
  rightPaneId: string;
}) {
  const { isOver: isLeftHalfOver, setNodeRef: setLeftHalfNodeRef } = useDroppable({
    id: `editor-pane-edge:${leftPaneId}:right`,
    data: { kind: 'pane-edge', paneId: leftPaneId, side: 'right' },
    disabled: drag?.splittable !== true,
  });
  const { isOver: isRightHalfOver, setNodeRef: setRightHalfNodeRef } = useDroppable({
    id: `editor-pane-edge:${rightPaneId}:left`,
    data: { kind: 'pane-edge', paneId: rightPaneId, side: 'left' },
    disabled: drag?.splittable !== true,
  });
  const side = isLeftHalfOver ? 'right' : isRightHalfOver ? 'left' : null;

  return (
    <>
      <div
        ref={setLeftHalfNodeRef}
        aria-hidden="true"
        data-pane-edge="right"
        data-pane-edge-pane-id={leftPaneId}
        className="pointer-events-none absolute inset-y-0 right-1/2 w-12"
      />
      <div
        ref={setRightHalfNodeRef}
        aria-hidden="true"
        data-pane-edge="left"
        data-pane-edge-pane-id={rightPaneId}
        className="pointer-events-none absolute inset-y-0 left-1/2 w-12"
      />
      <div
        aria-hidden="true"
        data-pane-boundary-drop=""
        data-pane-boundary-left={leftPaneId}
        data-pane-boundary-right={rightPaneId}
        data-pane-drop-side={side ?? undefined}
        className={cn(
          'pointer-events-none absolute inset-y-0 left-1/2 z-30 w-24 -translate-x-1/2 opacity-0',
          side && 'bg-primary/15 opacity-100 ring-2 ring-primary ring-inset',
        )}
      />
    </>
  );
}

function PaneActivityMount({
  docName,
  onActivityMount,
  onPaneFocus,
  paneId,
}: {
  docName: string;
  onActivityMount: (paneId: string, element: HTMLElement | null) => void;
  onPaneFocus: (paneId: string) => void;
  paneId: string;
}) {
  const activityMountRef = useRef<HTMLDivElement>(null);
  const notifyActivityMount = useEffectEvent(onActivityMount);
  const notifyPaneFocus = useEffectEvent(onPaneFocus);

  useLayoutEffect(() => {
    const mount = activityMountRef.current;
    if (!mount) return;
    const focus = () => notifyPaneFocus(paneId);
    mount.addEventListener('pointerdown', focus, true);
    mount.addEventListener('focusin', focus, true);
    notifyActivityMount(paneId, mount);
    return () => {
      mount.removeEventListener('pointerdown', focus, true);
      mount.removeEventListener('focusin', focus, true);
      notifyActivityMount(paneId, null);
    };
  }, [paneId]);

  return (
    <div
      ref={activityMountRef}
      data-editor-activity-mount={paneId}
      data-doc-name={docName}
      className="absolute inset-0"
    />
  );
}

function WorkspacePane({
  drag,
  isFocused,
  label,
  onActivityMount,
  pane,
  renderPane,
  showOuterLeftDropTarget = false,
  showOuterRightDropTarget = false,
  showDropTargets = true,
}: {
  drag: EditorTabDragData | null;
  isFocused: boolean;
  label: string;
  onActivityMount: (paneId: string, element: HTMLElement | null) => void;
  pane: EditorPaneState;
  renderPane: EditorWorkspaceProps['renderPane'];
  showOuterLeftDropTarget?: boolean;
  showOuterRightDropTarget?: boolean;
  showDropTargets?: boolean;
}) {
  const { focusPane, openTargetInPane } = useDocumentContext();
  const [sidebarDropActive, setSidebarDropActive] = useState(false);
  const paneRef = useRef<HTMLElement | null>(null);
  const activityDocName = activityDocNameForPane(pane);

  useLayoutEffect(() => {
    const element = paneRef.current;
    if (!element) return;

    const handleSidebarDragOver = (event: DragEvent) => {
      if (!hasSidebarDragType(event.dataTransfer)) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
      setSidebarDropActive(true);
    };
    const handleSidebarDragLeave = (event: DragEvent) => {
      const relatedTarget = event.relatedTarget;
      if (relatedTarget instanceof Node && element.contains(relatedTarget)) return;
      setSidebarDropActive(false);
    };
    const clearSidebarDropActive = () => setSidebarDropActive(false);
    const handleSidebarDrop = (event: DragEvent) => {
      setSidebarDropActive(false);
      const payload = parseSidebarDragPayload(event.dataTransfer);
      if (!payload) return;
      event.preventDefault();
      event.stopPropagation();
      openSidebarDropPayload(
        payload,
        (target, options) => openTargetInPane(pane.id, target, options),
        pane.activeNewTabId !== null,
      );
    };

    element.addEventListener('dragover', handleSidebarDragOver, true);
    element.addEventListener('dragleave', handleSidebarDragLeave, true);
    element.addEventListener('drop', handleSidebarDrop, true);
    window.addEventListener('drop', clearSidebarDropActive, true);
    window.addEventListener('dragend', clearSidebarDropActive, true);
    return () => {
      element.removeEventListener('dragover', handleSidebarDragOver, true);
      element.removeEventListener('dragleave', handleSidebarDragLeave, true);
      element.removeEventListener('drop', handleSidebarDrop, true);
      window.removeEventListener('drop', clearSidebarDropActive, true);
      window.removeEventListener('dragend', clearSidebarDropActive, true);
    };
  }, [openTargetInPane, pane.activeNewTabId, pane.id]);

  return (
    <section
      ref={paneRef}
      aria-current={isFocused ? 'true' : undefined}
      aria-label={label}
      data-editor-pane-id={pane.id}
      data-editor-pane-focused={isFocused || undefined}
      data-sidebar-drop-active={sidebarDropActive || undefined}
      className={cn(
        'relative flex h-full min-h-0 min-w-0 flex-col bg-background',
        sidebarDropActive &&
          'after:pointer-events-none after:absolute after:inset-2 after:z-20 after:rounded-lg after:bg-primary/5 after:ring-2 after:ring-primary/70 after:ring-inset',
      )}
      onPointerDownCapture={() => focusPane(pane.id)}
      onFocusCapture={() => focusPane(pane.id)}
    >
      <div className="relative min-h-0 flex-1">
        {renderPane({
          pane,
          isFocused,
          activityDocName,
          activityMount: activityDocName ? (
            <PaneActivityMount
              docName={activityDocName}
              onActivityMount={onActivityMount}
              onPaneFocus={focusPane}
              paneId={pane.id}
            />
          ) : null,
        })}
      </div>
      {showDropTargets && showOuterLeftDropTarget ? (
        <PaneEdgeDropTarget drag={drag} paneId={pane.id} side="left" />
      ) : null}
      {showDropTargets && showOuterRightDropTarget ? (
        <PaneEdgeDropTarget drag={drag} paneId={pane.id} side="right" />
      ) : null}
    </section>
  );
}

export function EditorWorkspace({
  renderActivityPool,
  renderHeader,
  renderPane,
}: EditorWorkspaceProps) {
  const { t } = useLingui();
  const {
    focusPane,
    focusedPaneId,
    moveTabToPane,
    panes,
    reorderTabsInPane,
    resizePanes,
    splitTab,
    tabSessionLoaded,
    visibleTabIdsByPane,
  } = useDocumentContext();
  const singleFile = useSingleFileMode();
  const desktopSessionRestorePending =
    !singleFile &&
    !tabSessionLoaded &&
    typeof window !== 'undefined' &&
    window.okDesktop?.config.mode === 'editor';
  const [drag, setDrag] = useState<EditorTabDragData | null>(null);
  const [dropIndicator, setDropIndicator] = useState<{
    index: number;
    paneId: string;
  } | null>(null);
  const [activityMounts, setActivityMounts] = useState<ReadonlyMap<string, HTMLElement>>(
    () => new Map(),
  );
  const [parkingHost, setParkingHost] = useState<HTMLElement | null>(null);
  const focusFrameRef = useRef<number | null>(null);
  const headerCanvasRef = useRef<HTMLDivElement>(null);
  const paneKey = panes.map((pane) => pane.id).join('\u0000');
  const savedLayout = Object.fromEntries(
    panes.map((pane) => [`editor-pane:${pane.id}`, pane.size]),
  );
  const visibleDocNames = new Set<string>();
  const activityHosts = new Map<string, HTMLElement>();
  for (const pane of panes) {
    const docName = activityDocNameForPane(pane);
    if (!docName) continue;
    visibleDocNames.add(docName);
    const mount = activityMounts.get(pane.id);
    if (mount) activityHosts.set(docName, mount);
  }
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
      keyboardCodes: TAB_KEYBOARD_DRAG_CODES,
    }),
  );
  const canvasStyle = {
    '--editor-workspace-min-width': `max(100%, ${panes.length * MIN_EDITOR_PANE_WIDTH}px)`,
  } as CSSProperties;

  useEffect(() => {
    return () => {
      if (focusFrameRef.current !== null) cancelAnimationFrame(focusFrameRef.current);
    };
  }, []);

  useEffect(() => {
    if (!drag) return;
    document.body.setAttribute('data-editor-tab-dragging', '');
    return () => document.body.removeAttribute('data-editor-tab-dragging');
  }, [drag]);

  if (desktopSessionRestorePending) {
    return (
      <>
        {renderHeader(null)}
        <div data-editor-workspace-pending="" className="min-h-0 flex-1 bg-background" />
      </>
    );
  }

  function registerActivityMount(paneId: string, element: HTMLElement | null) {
    setActivityMounts((current) => {
      const prior = current.get(paneId);
      if (prior === element) return current;
      const next = new Map(current);
      if (element) next.set(paneId, element);
      else next.delete(paneId);
      return next;
    });
  }

  function requestTabFocus(paneId: string, tabId: string) {
    if (focusFrameRef.current !== null) cancelAnimationFrame(focusFrameRef.current);
    focusFrameRef.current = requestAnimationFrame(() => {
      focusFrameRef.current = null;
      findEditorTabElement(document, paneId, tabId)?.focus();
    });
  }

  function visibleOrderForPane(pane: EditorPaneState): readonly string[] {
    return visibleTabIdsByPane.get(pane.id) ?? [...pane.openTabs, ...pane.newTabIds];
  }

  function moveOrReorderTab(
    active: EditorTabDragData,
    targetPane: EditorPaneState,
    targetIndex: number,
    targetOrder?: readonly string[],
  ) {
    if (active.paneId !== targetPane.id) {
      moveTabToPane(active.tabId, targetPane.id, targetIndex);
      requestTabFocus(targetPane.id, active.tabId);
      return;
    }
    if (!targetOrder) return;
    const fromIndex = targetOrder.indexOf(active.tabId);
    if (fromIndex < 0 || fromIndex === targetIndex) return;
    reorderTabsInPane(
      targetPane.id,
      arrayMove([...targetOrder], fromIndex, targetIndex),
      active.tabId,
    );
  }

  function resolveTabDropPlacement(
    event: TabDropEvent,
    active: EditorTabDragData,
  ): TabDropPlacement | null {
    const overData = event.over?.data.current;
    let paneId: string;
    let indicatorIndex: number;

    if (isEditorTabDragData(overData)) {
      paneId = overData.paneId;
      const targetPane = panes.find((pane) => pane.id === paneId);
      if (!targetPane) return null;
      const targetOrder = visibleOrderForPane(targetPane);
      const overIndex = targetOrder.indexOf(overData.tabId);
      if (overIndex < 0) return null;

      const activeIndex = active.paneId === paneId ? targetOrder.indexOf(active.tabId) : -1;
      const horizontalDelta = event.delta?.x ?? 0;
      const activeRect = event.active.rect?.current.translated;
      const overRect = event.over?.rect;
      let afterHoveredTab: boolean;
      if (activeIndex >= 0 && activeIndex !== overIndex) {
        afterHoveredTab = activeIndex < overIndex;
      } else if (activeIndex === overIndex && horizontalDelta !== 0) {
        afterHoveredTab = horizontalDelta > 0;
      } else {
        afterHoveredTab =
          activeRect !== null &&
          activeRect !== undefined &&
          overRect !== undefined &&
          activeRect.left + activeRect.width / 2 > overRect.left + overRect.width / 2;
      }
      indicatorIndex = overIndex + (afterHoveredTab ? 1 : 0);
    } else if (isEditorTabDropData(overData) && overData.kind === 'pane-strip') {
      paneId = overData.paneId;
      indicatorIndex = overData.index;
    } else {
      return null;
    }

    const pane = panes.find((candidate) => candidate.id === paneId);
    if (!pane) return null;
    const targetOrder = visibleOrderForPane(pane);
    const boundedIndicatorIndex = Math.min(Math.max(indicatorIndex, 0), targetOrder.length);
    const fromIndex = active.paneId === pane.id ? targetOrder.indexOf(active.tabId) : -1;
    const targetIndex =
      fromIndex >= 0 && boundedIndicatorIndex > fromIndex
        ? boundedIndicatorIndex - 1
        : boundedIndicatorIndex;
    if (fromIndex >= 0 && targetIndex === fromIndex) return null;

    return {
      indicatorIndex: boundedIndicatorIndex,
      pane,
      targetIndex,
      targetOrder,
    };
  }

  function updateDropIndicator(event: TabDropEvent) {
    const active = event.active.data.current;
    const placement = isEditorTabDragData(active) ? resolveTabDropPlacement(event, active) : null;
    const next = placement ? { index: placement.indicatorIndex, paneId: placement.pane.id } : null;
    setDropIndicator((current) =>
      current?.paneId === next?.paneId && current?.index === next?.index ? current : next,
    );
  }

  function handleDragStart(event: DragStartEvent) {
    const nextDrag = event.active.data.current;
    if (!isEditorTabDragData(nextDrag)) return;
    setDropIndicator(null);
    setDrag(nextDrag);
    focusPane(nextDrag.paneId);
  }

  function handleDragEnd(event: DragEndEvent) {
    const active = event.active.data.current;
    const over = event.over?.data.current;
    const placement = isEditorTabDragData(active) ? resolveTabDropPlacement(event, active) : null;
    setDropIndicator(null);
    setDrag(null);
    if (!isEditorTabDragData(active)) return;

    if (placement) {
      moveOrReorderTab(active, placement.pane, placement.targetIndex, placement.targetOrder);
      return;
    }

    if (!isEditorTabDropData(over)) return;

    if (over.kind === 'pane-edge') {
      if (!active.splittable) return;
      const newPaneId = splitTab(active.tabId, over.paneId, over.side);
      if (newPaneId) requestTabFocus(newPaneId, active.tabId);
      return;
    }
  }

  function syncHeaderScroll(event: UIEvent<HTMLDivElement>) {
    headerCanvasRef.current?.style.setProperty(
      'transform',
      `translateX(-${event.currentTarget.scrollLeft}px)`,
    );
  }

  function syncHeaderLayout(layout: Record<string, number>) {
    const groups = headerCanvasRef.current?.querySelectorAll<HTMLElement>(
      '[data-editor-pane-tab-group]',
    );
    groups?.forEach((group) => {
      const paneId = group.dataset.editorPaneTabGroup;
      const size = paneId ? layout[`editor-pane:${paneId}`] : undefined;
      if (size !== undefined) group.style.setProperty('flex-grow', String(size));
    });
  }

  function paneLabel(paneId: string): string {
    const position = panes.findIndex((pane) => pane.id === paneId);
    return position < 0 ? t`editor pane` : t`pane ${position + 1}`;
  }

  function dragDestinationDescription(data: unknown): string | null {
    if (isEditorTabDragData(data)) return paneLabel(data.paneId);
    if (!isEditorTabDropData(data)) return null;
    if (data.kind === 'pane-edge') {
      if (data.side === 'left') {
        return t`a new pane to the left of ${paneLabel(data.paneId)}`;
      }
      return t`a new pane to the right of ${paneLabel(data.paneId)}`;
    }
    return paneLabel(data.paneId);
  }

  const paneGroup = (
    <ResizablePanelGroup
      key={paneKey}
      id="editor-workspace-panes"
      orientation="horizontal"
      defaultLayout={savedLayout}
      onLayoutChange={syncHeaderLayout}
      onLayoutChanged={(layout, meta) => {
        if (!meta.isUserInteraction) return;
        resizePanes(
          new Map(panes.map((pane) => [pane.id, layout[`editor-pane:${pane.id}`] ?? pane.size])),
        );
      }}
    >
      {panes.map((pane, index) => (
        <Fragment key={pane.id}>
          {index > 0 ? (
            <ResizableHandle
              withHandle
              data-editor-pane-resize-handle=""
              data-editor-pane-before={panes[index - 1]?.id}
              data-editor-pane-after={pane.id}
            >
              <PaneBoundaryDropTarget
                drag={drag}
                leftPaneId={panes[index - 1]?.id ?? pane.id}
                rightPaneId={pane.id}
              />
            </ResizableHandle>
          ) : null}
          <ResizablePanel
            id={`editor-pane:${pane.id}`}
            defaultSize={`${pane.size}%`}
            minSize={`${MIN_EDITOR_PANE_WIDTH}px`}
          >
            <WorkspacePane
              drag={drag}
              isFocused={pane.id === focusedPaneId}
              label={paneLabel(pane.id)}
              onActivityMount={registerActivityMount}
              pane={pane}
              renderPane={renderPane}
              showOuterLeftDropTarget={index === 0}
              showOuterRightDropTarget={index === panes.length - 1}
            />
          </ResizablePanel>
        </Fragment>
      ))}
    </ResizablePanelGroup>
  );
  const headerTabs = (
    <div data-editor-header-tab-groups="" className="h-full min-w-0 flex-1 overflow-hidden">
      <div
        ref={headerCanvasRef}
        data-editor-header-tab-canvas=""
        className="flex h-full min-w-(--editor-workspace-min-width)"
        style={canvasStyle}
      >
        {panes.map((pane, index) => (
          <Fragment key={pane.id}>
            {index > 0 ? (
              <div
                aria-hidden="true"
                data-editor-header-pane-separator=""
                className="w-px shrink-0 bg-border"
              />
            ) : null}
            <PaneStripDropTarget
              paneId={pane.id}
              index={visibleOrderForPane(pane).length}
              isFocused={pane.id === focusedPaneId}
              size={pane.size}
            >
              <EditorTabs
                dropIndicatorIndex={dropIndicator?.paneId === pane.id ? dropIndicator.index : null}
                paneId={pane.id}
                onSplitComplete={requestTabFocus}
                reserveLeadingChrome={index === 0}
                reserveTrailingChrome={index === panes.length - 1}
              />
            </PaneStripDropTarget>
          </Fragment>
        ))}
      </div>
    </div>
  );

  if (singleFile) {
    const pane = panes.find((candidate) => candidate.id === focusedPaneId) ?? panes[0];
    return (
      <>
        {renderHeader(null)}
        <div data-editor-workspace="" className="relative min-h-0 flex-1 overflow-hidden">
          {pane ? (
            <WorkspacePane
              drag={null}
              isFocused
              label={paneLabel(pane.id)}
              onActivityMount={registerActivityMount}
              pane={pane}
              renderPane={renderPane}
              showDropTargets={false}
            />
          ) : null}
          <div ref={setParkingHost} data-editor-activity-parking="" className="hidden" inert />
          {parkingHost !== null
            ? renderActivityPool?.({ activityHosts, parkingHost, visibleDocNames })
            : null}
        </div>
      </>
    );
  }

  return (
    <DndContext
      sensors={sensors}
      autoScroll={false}
      collisionDetection={editorWorkspaceCollisionDetection}
      onDragStart={handleDragStart}
      onDragMove={updateDropIndicator}
      onDragOver={updateDropIndicator}
      onDragEnd={handleDragEnd}
      onDragCancel={() => {
        setDropIndicator(null);
        setDrag(null);
      }}
      accessibility={{
        container: typeof document !== 'undefined' ? document.body : undefined,
        screenReaderInstructions: {
          draggable: t`Press Space to pick up a tab. Use the arrow keys to move it within a tab strip, then press Space or Enter to drop it. Press Shift+F10 or the Menu key to open the tab context menu for split, close, pin, and other tab actions.`,
        },
        announcements: {
          onDragStart: ({ active }) => {
            const data = active.data.current;
            return isEditorTabDragData(data)
              ? t`Picked up ${data.label} from ${paneLabel(data.paneId)}.`
              : undefined;
          },
          onDragOver: ({ active, over }) => {
            const activeData = active.data.current;
            if (!isEditorTabDragData(activeData) || !over) return undefined;
            const destination = dragDestinationDescription(over.data.current);
            return destination ? t`${activeData.label} is over ${destination}.` : undefined;
          },
          onDragEnd: ({ active, over }) => {
            const activeData = active.data.current;
            if (!isEditorTabDragData(activeData)) return undefined;
            const destination = over ? dragDestinationDescription(over.data.current) : null;
            return destination
              ? t`Moved ${activeData.label} to ${destination}.`
              : t`${activeData.label} was not moved.`;
          },
          onDragCancel: ({ active }) => {
            const activeData = active.data.current;
            return isEditorTabDragData(activeData)
              ? t`Cancelled moving ${activeData.label}.`
              : undefined;
          },
        },
      }}
    >
      {renderHeader(headerTabs)}
      <div
        data-editor-workspace=""
        className="relative min-h-0 flex-1 overflow-x-auto overflow-y-hidden"
        onScroll={syncHeaderScroll}
      >
        <div
          data-editor-workspace-canvas=""
          className="h-full min-w-[var(--editor-workspace-min-width)]"
          style={canvasStyle}
        >
          {paneGroup}
        </div>
        <div ref={setParkingHost} data-editor-activity-parking="" className="hidden" inert />
        {parkingHost !== null
          ? renderActivityPool?.({ activityHosts, parkingHost, visibleDocNames })
          : null}
      </div>
      <DragOverlay dropAnimation={null}>
        {drag ? (
          <div
            aria-hidden="true"
            data-testid="editor-tab-drag-overlay"
            className="pointer-events-none flex h-10 w-44 max-w-[calc(100vw-2rem)] cursor-grabbing items-center overflow-hidden rounded-md border border-border bg-background px-3 font-medium text-[13px] text-foreground shadow-lg"
          >
            <span className="min-w-0 truncate">{drag.label}</span>
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}
