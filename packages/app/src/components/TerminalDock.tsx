import { useTheme } from 'next-themes';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { usePanelRef } from 'react-resizable-panels';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable';
import type { TerminalDockPosition } from '@/lib/terminal-dock-store';
import { getInitialTerminalHeight, writeTerminalHeight } from '@/lib/terminal-height-store';
import { cn } from '@/lib/utils';
import { TerminalRevealTab } from './TerminalRevealTab';
import { xtermThemeForMode } from './terminal-theme';

const TERMINAL_PANEL_ID = 'terminal-dock-panel';

interface TerminalDockProps {
  /** The editor chrome (header + area) the terminal docks beneath. */
  readonly children: ReactNode;
  /**
   * Controlled visibility. The bottom panel opens when the terminal is bottom-
   * docked AND visible; drag-collapsing it reports back through {@link onVisibleChange}.
   */
  readonly visible: boolean;
  readonly onVisibleChange: (visible: boolean) => void;
  /**
   * Where the terminal is docked. `'bottom'` opens this component's bottom panel;
   * `'right'` keeps it collapsed (the terminal lives in the right region — the
   * live session host portals into that container instead, mounted above this
   * component so a dock change never remounts it).
   */
  readonly dockPosition?: TerminalDockPosition;
  /**
   * Callback ref reporting the bottom-dock mount element up to EditorArea, which
   * passes it to the session host as a portal target. The host div lands here when
   * the terminal is bottom-docked; when right-docked the host attaches to the
   * right column's container instead and this bottom panel stays collapsed + empty.
   */
  readonly onBottomContainer: (el: HTMLDivElement | null) => void;
  /**
   * Callback ref reporting the editor-region focus target up to EditorArea, used by
   * the session host to return focus to the editor when the terminal hides.
   */
  readonly onEditorRegion: (el: HTMLDivElement | null) => void;
  /**
   * Reveal the terminal (spawning a default-CLI session if none is open). When
   * provided and the terminal is bottom-docked-and-hidden, this shell renders an
   * edge "Show terminal" tab at the bottom of the editor region — where the
   * bottom dock actually lives. Absent on the web host (no terminal). The
   * right-dock reveal tab is owned by EditorArea instead (different container).
   */
  readonly onReveal?: () => void;
}

/**
 * The bottom layout shell for the docked terminal: a vertical split with the
 * editor on top and a collapsible bottom panel beneath. It owns the bottom panel's
 * height (persist + drag) and collapse, and exposes the bottom mount + editor
 * region elements. It deliberately owns NO session state — the live terminal lives
 * in {@link TerminalSessionsHost}, mounted above the panel group, and portals into
 * the bottom mount this component renders. That separation is what lets the
 * terminal move docks (and the editor re-render) without re-spawning the PTY.
 */
export function TerminalDock({
  children,
  visible,
  onVisibleChange,
  dockPosition = 'bottom',
  onBottomContainer,
  onEditorRegion,
  onReveal,
}: TerminalDockProps) {
  const { resolvedTheme } = useTheme();
  const panelRef = usePanelRef();
  const [isCollapsed, setIsCollapsed] = useState(!visible);
  const xtermBackground = xtermThemeForMode(resolvedTheme).background;
  // A right-docked terminal keeps `visible` true while this panel sits collapsed
  // and empty — the handle must gate on this, not `visible`, or the grabber
  // lingers and drags up an empty panel.
  const bottomOpen = visible && dockPosition === 'bottom';
  // The edge "Show terminal" tab belongs to the bottom dock only — it hugs the
  // bottom of the editor column, where a bottom-docked terminal slides up from.
  // Right-docked reveal is owned by EditorArea (far-right column edge).
  const showBottomRevealTab = !visible && dockPosition === 'bottom' && onReveal != null;

  // Snapshot the persisted height once at mount; the ref carries the running value
  // during user drag.
  const [initialHeightPx] = useState(() => getInitialTerminalHeight());
  const heightPxRef = useRef(initialHeightPx);

  const [isDragging, setIsDragging] = useState(false);
  const isDraggingRef = useRef(false);

  const writeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  function debouncedWriteHeight(px: number) {
    if (writeTimerRef.current != null) clearTimeout(writeTimerRef.current);
    writeTimerRef.current = setTimeout(() => {
      writeTerminalHeight(px);
      writeTimerRef.current = null;
    }, 100);
  }
  // The drag-end listener is added to `window` on pointerdown and normally removes
  // itself on pointerup. If the shell unmounts mid-drag the closure would leak —
  // track it so unmount can detach it.
  const dragUpHandlerRef = useRef<(() => void) | null>(null);
  useEffect(
    () => () => {
      if (writeTimerRef.current != null) clearTimeout(writeTimerRef.current);
      if (dragUpHandlerRef.current != null) {
        window.removeEventListener('pointerup', dragUpHandlerRef.current);
        dragUpHandlerRef.current = null;
      }
    },
    [],
  );

  // Drive the panel from the controlled prop: restore the persisted height when
  // bottom-docked and visible, collapse otherwise (hidden, or right-docked where
  // the terminal lives in the right region).
  useEffect(() => {
    const panel = panelRef.current;
    if (panel == null) return;
    if (bottomOpen) {
      panel.resize(`${heightPxRef.current}px`);
    } else {
      panel.collapse();
    }
  }, [bottomOpen, panelRef]);

  return (
    <ResizablePanelGroup
      orientation="vertical"
      className="min-h-0 flex-1"
      data-dragging={isDragging || undefined}
    >
      <ResizablePanel minSize="5%" className="flex min-h-0 flex-col">
        {/* tabIndex -1 makes this a programmatic focus target for focus-return on
            collapse without adding it to the tab order. `relative` anchors the
            bottom-dock reveal tab to the bottom of the editor column. */}
        <div
          ref={onEditorRegion}
          tabIndex={-1}
          className="relative flex h-full min-h-0 flex-col outline-none"
        >
          {children}
          {showBottomRevealTab && onReveal ? (
            <TerminalRevealTab
              dockPosition="bottom"
              onReveal={onReveal}
              className="right-3 bottom-0"
            />
          ) : null}
        </div>
      </ResizablePanel>
      {/* The handle drags only while the bottom panel is open: you can resize it,
          and drag all the way down to collapse (hide). Otherwise it is disabled —
          when bottom-docked-and-hidden the reveal tab rendered above is the single
          way back in, and when right-docked the ways in live outside this file
          (EditorArea's reveal tab; the tab strip's dock-toggle) — so there is no
          drag-up-to-open (which would be a second, redundant way in). Gating on
          controlled props (not `isCollapsed`) means an in-progress drag-to-collapse
          completes before the handle disables on the next commit. */}
      <ResizableHandle
        withHandle={bottomOpen}
        disabled={!bottomOpen}
        onPointerDown={() => {
          if (!bottomOpen) return;
          setIsDragging(true);
          isDraggingRef.current = true;
          const handleUp = () => {
            setIsDragging(false);
            isDraggingRef.current = false;
            window.removeEventListener('pointerup', handleUp);
            dragUpHandlerRef.current = null;
          };
          dragUpHandlerRef.current = handleUp;
          window.addEventListener('pointerup', handleUp);
        }}
      />
      <ResizablePanel
        id={TERMINAL_PANEL_ID}
        // Paint the whole dock surface with the exact xterm canvas color so the tab
        // strip, its controls, and any chrome read as one continuous surface with
        // the terminal — no app-background seam between the strip and canvas.
        style={{ backgroundColor: xtermBackground }}
        panelRef={panelRef}
        defaultSize={bottomOpen ? `${initialHeightPx}px` : 0}
        minSize="120px"
        // The terminal can be dragged tall — up to 95% of the dock — leaving the
        // editor a 5% sliver (its panel `minSize`). Pair the two: the terminal's max
        // plus the editor's min must sum to 100% or the drag can't reach it.
        maxSize="95%"
        collapsible
        collapsedSize={0}
        onResize={(size) => {
          const collapsed = size.asPercentage === 0;
          setIsCollapsed(collapsed);
          // Persist + reflect to controlled visibility only on a user drag;
          // imperative replays from the `visible` effect also fire onResize and must
          // not overwrite the persisted value or loop onVisibleChange.
          if (isDraggingRef.current) {
            if (collapsed && visible) onVisibleChange(false);
            else if (!collapsed && !visible) onVisibleChange(true);
            if (size.inPixels > 0) {
              heightPxRef.current = size.inPixels;
              debouncedWriteHeight(size.inPixels);
            }
          }
        }}
        // react-resizable-panels does not apply inert on collapse — children stay in
        // the DOM, tab order, and a11y tree. The explicit `inert` removes the
        // collapsed terminal from focus order.
        inert={isCollapsed}
        className={cn(
          'flex flex-col',
          !isDragging &&
            'transition-[flex-grow] duration-150 ease-out motion-reduce:transition-none motion-reduce:duration-0',
        )}
      >
        {/* Mount point for the session host's stable host div when bottom-docked. */}
        <div ref={onBottomContainer} className="flex min-h-0 flex-1 flex-col overflow-hidden" />
      </ResizablePanel>
    </ResizablePanelGroup>
  );
}
