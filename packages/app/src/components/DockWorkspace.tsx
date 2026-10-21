import { useLingui } from '@lingui/react/macro';
import {
  Fragment,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { createPortal, flushSync } from 'react-dom';
import {
  clampDockSeam,
  type DockExtent,
  type DockLayout,
  type DockRect,
  type DockSeam,
  dockSeamPercent,
  dockSeamShares,
  EMPTY_DOCK_LAYOUT,
  layoutDock,
} from '@/lib/dock-layout';
import {
  DOCK_PANES,
  type DockEdge,
  type DockNode,
  moveDockPane,
  resizeDockGroup,
  swapDockPanes,
  visibleDockTree,
} from '@/lib/dock-tree';
import { isPaneId, type PaneId } from '@/lib/pane-visibility-store';
import { cn } from '@/lib/utils';

const KEYBOARD_STEP_PX = 16;
const KEYBOARD_LARGE_STEP_PX = 64;
const REDOCK_START_DISTANCE_PX = 6;
const REDOCK_EDGE_FRACTION = 0.26;
const REDOCK_SHARE = 0.5;
const REDOCK_CHIP_OFFSET_PX = { x: 14, y: 12 };
const REDOCK_HANDLE = '[data-dock-handle]';
const REDOCK_IGNORED =
  'button, a[href], input, textarea, select, [role="tab"], [role="button"], [role="menuitem"], [role="combobox"], [contenteditable=""], [contenteditable="true"]';

function dockUnitId(pane: PaneId): string {
  return `dock-unit-${pane}`;
}

interface DockWorkspaceProps {
  readonly tree: DockNode;
  readonly visible: Readonly<Record<PaneId, boolean>>;
  readonly units: Readonly<Record<PaneId, ReactNode>>;
  readonly gap: number;
  readonly minExtent: (pane: PaneId) => DockExtent;
  readonly paneLabel: (pane: PaneId) => string;
  readonly onTreeChange: (update: (tree: DockNode) => DockNode) => void;
  readonly onLayoutChange?: (layout: DockLayout) => void;
  readonly redockable?: boolean;
}

type DockDropZone = DockEdge | 'center';

interface DockDropSpot {
  readonly pane: PaneId;
  readonly zone: DockDropZone;
}

interface DockDropTarget extends DockDropSpot {
  readonly hint: DockRect;
}

interface DockRedock {
  readonly pane: PaneId;
  readonly client: { readonly x: number; readonly y: number };
  readonly target: DockDropTarget | null;
}

function dropSpotAt(
  layout: DockLayout,
  dragged: PaneId,
  point: { readonly x: number; readonly y: number },
): DockDropSpot | null {
  for (const [pane, rect] of layout.panes) {
    if (pane === dragged) continue;
    const fromStart = (point.x - rect.x) / rect.width;
    const fromTop = (point.y - rect.y) / rect.height;
    if (fromStart < 0 || fromStart > 1 || fromTop < 0 || fromTop > 1) continue;
    const nearest = Math.min(fromStart, 1 - fromStart, fromTop, 1 - fromTop);
    if (nearest > REDOCK_EDGE_FRACTION) return { pane, zone: 'center' };
    if (nearest === fromStart) return { pane, zone: 'start' };
    if (nearest === 1 - fromStart) return { pane, zone: 'end' };
    if (nearest === fromTop) return { pane, zone: 'top' };
    return { pane, zone: 'bottom' };
  }
  return null;
}

function droppedTree(tree: DockNode, dragged: PaneId, spot: DockDropSpot): DockNode {
  return spot.zone === 'center'
    ? swapDockPanes(tree, dragged, spot.pane)
    : moveDockPane(tree, dragged, spot.pane, spot.zone, REDOCK_SHARE);
}

interface DockDrag {
  readonly tree: DockNode;
  readonly seam: DockSeam;
  readonly key: string;
  readonly origin: number;
  readonly rtl: boolean;
  readonly length: number;
}

function seamKey(seam: DockSeam): string {
  return `${seam.path.join('.')}:${seam.index}`;
}

function dragLength(drag: DockDrag, event: { clientX: number; clientY: number }): number {
  const row = drag.seam.direction === 'row';
  const moved = (row ? event.clientX : event.clientY) - drag.origin;
  const delta = row && drag.rtl ? -moved : moved;
  return (drag.seam.lengths[drag.seam.index] ?? 0) + delta;
}

function layoutSignature(layout: DockLayout): string {
  return DOCK_PANES.map((pane) => {
    const rect = layout.panes.get(pane);
    return rect === undefined
      ? `${pane}:-`
      : `${pane}:${rect.x},${rect.y},${rect.width},${rect.height}`;
  }).join('|');
}

function withinBounds(rect: DockRect, bounds: DockRect | null): DockRect {
  if (bounds === null) return rect;
  const width = Math.min(rect.width, bounds.width);
  const height = Math.min(rect.height, bounds.height);
  return {
    x: Math.max(0, Math.min(rect.x, bounds.width - width)),
    y: Math.max(0, Math.min(rect.y, bounds.height - height)),
    width,
    height,
  };
}

function placement(rect: DockRect) {
  return {
    insetInlineStart: rect.x,
    insetBlockStart: rect.y,
    width: rect.width,
    height: rect.height,
  };
}

export function DockWorkspace({
  tree,
  visible,
  units,
  gap,
  minExtent,
  paneLabel,
  onTreeChange,
  onLayoutChange,
  redockable = false,
}: DockWorkspaceProps) {
  const { t } = useLingui();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [bounds, setBounds] = useState<DockRect | null>(null);
  const [drag, setDrag] = useState<DockDrag | null>(null);
  const [retainedRects, setRetainedRects] = useState<ReadonlyMap<PaneId, DockRect>>(
    () => new Map(),
  );
  const releaseDragRef = useRef<(() => void) | null>(null);
  const [redock, setRedock] = useState<DockRedock | null>(null);
  const releaseRedockRef = useRef<(() => void) | null>(null);
  const onTreeChangeRef = useRef(onTreeChange);
  useLayoutEffect(() => {
    onTreeChangeRef.current = onTreeChange;
  });

  useLayoutEffect(() => {
    const element = containerRef.current;
    if (element === null) return;
    const measure = () => {
      const { width, height } = element.getBoundingClientRect();
      setBounds((current) =>
        current !== null && current.width === width && current.height === height
          ? current
          : { x: 0, y: 0, width, height },
      );
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => flushSync(measure));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  function layoutOf(shown: DockNode): DockLayout {
    if (bounds === null) return EMPTY_DOCK_LAYOUT;
    return layoutDock(
      visibleDockTree(shown, (pane) => visible[pane]),
      bounds,
      gap,
      minExtent,
    );
  }
  const baseLayout = layoutOf(tree);
  const liveDrag =
    drag !== null &&
    drag.tree === tree &&
    baseLayout.seams.some((seam) => seamKey(seam) === drag.key)
      ? drag
      : null;
  const layout =
    liveDrag === null
      ? baseLayout
      : layoutOf(
          resizeDockGroup(tree, liveDrag.seam.path, dockSeamShares(liveDrag.seam, liveDrag.length)),
        );
  const signature = layoutSignature(layout);
  const reportLayout = useEffectEvent(() => {
    setRetainedRects((current) => {
      const next = new Map(current);
      for (const [pane, rect] of layout.panes) next.set(pane, rect);
      return next;
    });
    onLayoutChange?.(layout);
  });
  // biome-ignore lint/correctness/useExhaustiveDependencies: the layout signature names every unit rect, so it is the change that owns a report
  useLayoutEffect(() => {
    reportLayout();
  }, [signature]);

  function stopDragging() {
    releaseDragRef.current?.();
    releaseDragRef.current = null;
    setDrag(null);
  }
  const dragOutlived = drag !== null && liveDrag === null;
  const endOutlivedDrag = useEffectEvent(() => {
    stopDragging();
  });
  useLayoutEffect(() => {
    if (dragOutlived) endOutlivedDrag();
  }, [dragOutlived]);
  useEffect(() => () => releaseDragRef.current?.(), []);
  useEffect(() => () => releaseRedockRef.current?.(), []);

  function isRtl(): boolean {
    const element = containerRef.current;
    return element !== null && getComputedStyle(element).direction === 'rtl';
  }

  function commitSeam(base: DockNode, seam: DockSeam, length: number) {
    if (clampDockSeam(seam, length) === (seam.lengths[seam.index] ?? 0)) return;
    const shares = dockSeamShares(seam, length);
    onTreeChangeRef.current((current) =>
      current === base ? resizeDockGroup(current, seam.path, shares) : current,
    );
  }

  function beginDrag(seam: DockSeam, event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    stopDragging();
    const pointerId = event.pointerId;
    const started: DockDrag = {
      tree,
      seam,
      key: seamKey(seam),
      origin: seam.direction === 'row' ? event.clientX : event.clientY,
      rtl: isRtl(),
      length: seam.lengths[seam.index] ?? 0,
    };
    const follow = (moveEvent: globalThis.PointerEvent) => {
      if (moveEvent.pointerId !== pointerId) return;
      setDrag({ ...started, length: dragLength(started, moveEvent) });
    };
    const finish = (upEvent: globalThis.PointerEvent) => {
      if (upEvent.pointerId !== pointerId) return;
      stopDragging();
      commitSeam(started.tree, started.seam, dragLength(started, upEvent));
    };
    const abandon = (cancelEvent: globalThis.PointerEvent) => {
      if (cancelEvent.pointerId === pointerId) stopDragging();
    };
    window.addEventListener('pointermove', follow);
    window.addEventListener('pointerup', finish);
    window.addEventListener('pointercancel', abandon);
    releaseDragRef.current = () => {
      window.removeEventListener('pointermove', follow);
      window.removeEventListener('pointerup', finish);
      window.removeEventListener('pointercancel', abandon);
    };
    setDrag(started);
  }

  function stopRedock() {
    releaseRedockRef.current?.();
    releaseRedockRef.current = null;
    setRedock(null);
  }

  const redockAt = useEffectEvent((pane: PaneId, event: globalThis.PointerEvent): DockRedock => {
    const box = containerRef.current?.getBoundingClientRect();
    const point =
      box === undefined
        ? null
        : {
            x: isRtl() ? box.right - event.clientX : event.clientX - box.left,
            y: event.clientY - box.top,
          };
    const spot = point === null ? null : dropSpotAt(layout, pane, point);
    const hint =
      spot === null ? undefined : layoutOf(droppedTree(tree, pane, spot)).panes.get(pane);
    return {
      pane,
      client: { x: event.clientX, y: event.clientY },
      target: spot === null || hint === undefined ? null : { ...spot, hint },
    };
  });

  const commitRedock = useEffectEvent((pane: PaneId, target: DockDropSpot) => {
    onTreeChangeRef.current((current) => droppedTree(current, pane, target));
  });

  const startRedock = useEffectEvent((event: globalThis.PointerEvent) => {
    const container = containerRef.current;
    const pressed = event.target;
    if (!redockable || event.button !== 0 || releaseRedockRef.current !== null) return;
    if (container === null || !(pressed instanceof Element)) return;
    const handle = pressed.closest(REDOCK_HANDLE);
    const unit = handle?.closest('[data-dock-unit]');
    if (handle == null || unit == null || !container.contains(unit)) return;
    const ignored = pressed.closest(REDOCK_IGNORED);
    if (ignored !== null && handle.contains(ignored)) return;
    const pane = unit.getAttribute('data-dock-unit');
    if (!isPaneId(pane) || !layout.panes.has(pane) || layout.panes.size < 2) return;
    const pointerId = event.pointerId;
    const start = { x: event.clientX, y: event.clientY };
    let live = false;
    const follow = (move: globalThis.PointerEvent) => {
      if (move.pointerId !== pointerId) return;
      if ((move.buttons & 1) === 0) {
        stopRedock();
        return;
      }
      if (!live) {
        const travel = Math.abs(move.clientX - start.x) + Math.abs(move.clientY - start.y);
        if (travel < REDOCK_START_DISTANCE_PX) return;
        live = true;
      }
      setRedock(redockAt(pane, move));
    };
    const finish = (up: globalThis.PointerEvent) => {
      if (up.pointerId !== pointerId) return;
      const target = live ? redockAt(pane, up).target : null;
      stopRedock();
      if (target !== null) commitRedock(pane, target);
    };
    const abandon = (cancel: globalThis.PointerEvent) => {
      if (cancel.pointerId === pointerId) stopRedock();
    };
    const abandonForMenu = () => stopRedock();
    const cancelOnEscape = (key: globalThis.KeyboardEvent) => {
      if (!live || key.key !== 'Escape') return;
      key.preventDefault();
      key.stopPropagation();
      stopRedock();
    };
    window.addEventListener('pointermove', follow);
    window.addEventListener('pointerup', finish);
    window.addEventListener('pointercancel', abandon);
    window.addEventListener('contextmenu', abandonForMenu);
    window.addEventListener('keydown', cancelOnEscape, true);
    releaseRedockRef.current = () => {
      window.removeEventListener('pointermove', follow);
      window.removeEventListener('pointerup', finish);
      window.removeEventListener('pointercancel', abandon);
      window.removeEventListener('contextmenu', abandonForMenu);
      window.removeEventListener('keydown', cancelOnEscape, true);
    };
  });

  useEffect(() => {
    const element = containerRef.current;
    if (element === null) return;
    const press = (event: globalThis.PointerEvent) => startRedock(event);
    element.addEventListener('pointerdown', press);
    return () => element.removeEventListener('pointerdown', press);
  }, []);

  function resizeFromKeyboard(seam: DockSeam, event: KeyboardEvent<HTMLDivElement>) {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const row = seam.direction === 'row';
    const step = event.shiftKey ? KEYBOARD_LARGE_STEP_PX : KEYBOARD_STEP_PX;
    const current = seam.lengths[seam.index] ?? 0;
    let next: number | null = null;
    if (row && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
      const towardStart = event.key === (isRtl() ? 'ArrowRight' : 'ArrowLeft');
      next = current + (towardStart ? -step : step);
    } else if (!row && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
      next = current + (event.key === 'ArrowUp' ? -step : step);
    } else if (event.key === 'Home') {
      next = Number.POSITIVE_INFINITY;
    } else if (event.key === 'End') {
      next = 0;
    }
    if (next === null) return;
    event.preventDefault();
    commitSeam(tree, seam, next);
  }

  const dragging = liveDrag !== null || redock !== null;
  const seamBefore = new Map<PaneId, DockSeam>();
  for (const seam of layout.seams) {
    const resized = seam.after[0];
    if (resized !== undefined) seamBefore.set(resized, seam);
  }

  function renderUnit(pane: PaneId) {
    const rect = layout.panes.get(pane);
    const retained = retainedRects.get(pane);
    const shownRect = rect ?? (retained === undefined ? undefined : withinBounds(retained, bounds));
    return (
      <div
        key="unit"
        id={dockUnitId(pane)}
        data-dock-unit={pane}
        data-dock-unit-off={rect === undefined ? '' : undefined}
        hidden={shownRect === undefined}
        inert={rect === undefined}
        className={cn(
          'absolute flex min-h-0 min-w-0 transition-opacity duration-150 ease-out motion-reduce:transition-none',
          rect === undefined && 'invisible',
          dragging && 'pointer-events-none',
          redock?.pane === pane && 'opacity-50',
        )}
        style={shownRect === undefined ? undefined : placement(shownRect)}
      >
        {units[pane]}
      </div>
    );
  }

  function renderSeam(resized: PaneId, seam: DockSeam) {
    const row = seam.direction === 'row';
    const value = dockSeamPercent(seam);
    const pane = paneLabel(resized);
    return (
      // biome-ignore lint/a11y/useSemanticElements: the suggested <hr> is a thematic break, a non-interactive element with no value. This seam is a focusable window splitter that reports and changes a size.
      <div
        key="seam"
        role="separator"
        tabIndex={0}
        aria-orientation={row ? 'vertical' : 'horizontal'}
        aria-valuenow={value.now}
        aria-valuemin={value.min}
        aria-valuemax={value.max}
        aria-controls={seam.after.map(dockUnitId).join(' ')}
        aria-label={t`Resize ${pane}`}
        data-dock-seam={seam.direction}
        data-dragging={liveDrag?.key === seamKey(seam) ? '' : undefined}
        className={cn(
          'group/seam absolute z-20 flex touch-none select-none items-center justify-center rounded-sm',
          'before:absolute before:content-[""] focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring',
          row
            ? 'cursor-col-resize before:-inset-x-1 before:inset-y-0'
            : 'cursor-row-resize before:-inset-y-1 before:inset-x-0',
        )}
        style={placement(seam.rect)}
        onPointerDown={(event) => beginDrag(seam, event)}
        onKeyDown={(event) => resizeFromKeyboard(seam, event)}
      >
        <span
          aria-hidden="true"
          className={cn(
            'pointer-events-none rounded-full bg-border opacity-0 transition-[opacity,background-color] duration-150 ease-out motion-reduce:transition-none',
            'group-hover/seam:opacity-100 group-focus-visible/seam:opacity-100 group-data-[dragging]/seam:bg-primary group-data-[dragging]/seam:opacity-100',
            row ? 'h-8 w-0.5' : 'h-0.5 w-8',
          )}
        />
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      data-dock-workspace=""
      data-dragging={dragging ? '' : undefined}
      data-redocking={redock === null ? undefined : redock.pane}
      className={cn(
        'relative min-h-0 min-w-0 flex-1',
        dragging && 'select-none',
        redock !== null && 'cursor-grabbing',
        redockable && [
          '[&_[data-dock-handle]]:select-none',
          '[&_[data-dock-handle][data-electron-drag]]:[-webkit-app-region:no-drag]',
          '[&_[data-dock-handle]_[data-electron-drag]]:[-webkit-app-region:no-drag]',
        ],
      )}
    >
      {DOCK_PANES.map((pane) => {
        const seam = seamBefore.get(pane);
        return (
          <Fragment key={pane}>
            {seam === undefined ? null : renderSeam(pane, seam)}
            {renderUnit(pane)}
          </Fragment>
        );
      })}
      {redock?.target == null ? null : (
        <div
          aria-hidden="true"
          data-dock-drop-pane={redock.target.pane}
          data-dock-drop-zone={redock.target.zone}
          className="pointer-events-none absolute z-30 rounded-xl bg-primary/10 ring-2 ring-primary ring-inset outline-current -outline-offset-2 forced-colors:outline-solid forced-colors:outline-2 contrast-more:outline-solid contrast-more:outline-2"
          style={placement(redock.target.hint)}
        />
      )}
      {redock === null
        ? null
        : createPortal(
            <div
              aria-hidden="true"
              data-dock-drag-chip=""
              className="pointer-events-none fixed z-50 rounded-lg bg-foreground px-2.5 py-1.5 font-semibold text-background text-xs shadow-lg outline-current forced-colors:outline-solid forced-colors:outline-1"
              style={{
                left: redock.client.x + REDOCK_CHIP_OFFSET_PX.x,
                top: redock.client.y + REDOCK_CHIP_OFFSET_PX.y,
              }}
            >
              {paneLabel(redock.pane)}
            </div>,
            document.body,
          )}
    </div>
  );
}
