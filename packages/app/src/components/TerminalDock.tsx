import type { TerminalPlacement } from '@inkeep/open-knowledge-core';
import { useTheme } from 'next-themes';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { usePanelRef } from 'react-resizable-panels';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable';
import {
  clampTerminalHeight,
  getInitialTerminalHeight,
  writeTerminalHeight,
} from '@/lib/terminal-height-store';
import { cn } from '@/lib/utils';
import { useLiveXtermTheme } from './use-live-xterm-theme';

const TERMINAL_PANEL_ID = 'terminal-dock-panel';

/**
 * Per-mount cap on the stranded-dock diagnostic. A healthy fire is one line — the
 * guard shuts the panel immediately — so a cap only bites when something fights
 * the collapse, exactly the case where an unbounded log would bury the signal it
 * exists to carry.
 */
export const MAX_STRANDED_REPORTS = 5;

interface TerminalDockProps {
  /** The editor chrome (header + area) the terminal docks beneath. */
  readonly children: ReactNode;
  readonly placement?: TerminalPlacement;
  /**
   * Controlled visibility. Drag-collapsing the bottom panel reports back through
   * {@link onVisibleChange}.
   */
  readonly visible: boolean;
  readonly onVisibleChange: (visible: boolean) => void;
  /**
   * Callback ref reporting the bottom-dock mount element up to EditorArea, which
   * passes it to the terminal session host as a portal target.
   */
  readonly onBottomContainer: (el: HTMLDivElement | null) => void;
  /**
   * Callback ref reporting the editor-region focus target up to EditorArea, used by
   * the session host to return focus to the editor when the terminal hides.
   */
  readonly onEditorRegion: (el: HTMLDivElement | null) => void;
}

/**
 * The vertical editor shell for the docked terminal. It renders and owns the
 * persisted bottom split only while the bottom edge is active; the editor region
 * remains mounted when the terminal moves right. It deliberately owns NO session
 * state — the live terminal lives in {@link SessionsHost}, mounted above this
 * shell. That separation lets the presentation edge change without re-spawning
 * the PTY.
 */
export function TerminalDock({
  children,
  placement = 'bottom',
  visible,
  onVisibleChange,
  onBottomContainer,
  onEditorRegion,
}: TerminalDockProps) {
  const { resolvedTheme } = useTheme();
  const panelRef = usePanelRef();
  const bottomVisible = placement === 'bottom' && visible;
  const [isCollapsed, setIsCollapsed] = useState(!bottomVisible);
  const xtermBackground = useLiveXtermTheme(resolvedTheme).background;
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
  // Diagnostic for the illegal state the guard below repairs. The repair is
  // silent by construction — the panel snaps shut and the user sees nothing — so
  // without this line a recurrence leaves no trace and the next report is as
  // undiagnosable as the first. The renderer console is captured to a persisted
  // log on both hosts (the Electron main capture; `/api/client-logs` on web),
  // though only the web path reaches a submitted diagnostics bundle today. Every
  // field is a number or a fixed enum — no paths, no document content.
  const strandedReportsRef = useRef(0);
  function reportStrandedDock(panelPx: number, panelPct: number) {
    if (strandedReportsRef.current >= MAX_STRANDED_REPORTS) return;
    strandedReportsRef.current += 1;
    console.warn(
      JSON.stringify({
        event: 'ok-terminal-dock-stranded-while-hidden',
        panelPx: Math.round(panelPx),
        panelPct: Number.isFinite(panelPct) ? Math.round(panelPct * 10) / 10 : null,
        visible,
        // The height this shell would reopen at. Reading it against `innerHeight`
        // is what distinguishes a value clamped for the current viewport from one
        // carried over from a differently-sized display.
        dockHeightPx: heightPxRef.current,
        innerWidth: window.innerWidth,
        innerHeight: window.innerHeight,
        devicePixelRatio: window.devicePixelRatio,
      }),
    );
  }

  // The drag-end listeners are added to `window` on pointerdown and normally
  // detach themselves on `pointerup` or `pointercancel`. If the shell unmounts
  // mid-drag the closures would leak — track the detach so unmount can run it.
  const endDragRef = useRef<(() => void) | null>(null);
  useEffect(
    () => () => {
      if (writeTimerRef.current != null) clearTimeout(writeTimerRef.current);
      endDragRef.current?.();
    },
    [],
  );

  // Drive the panel from the controlled prop: restore the persisted height when
  // visible, collapse when hidden.
  useEffect(() => {
    const panel = panelRef.current;
    if (panel == null) return;
    try {
      if (bottomVisible) {
        panel.resize(`${heightPxRef.current}px`);
      } else {
        panel.collapse();
      }
    } catch {
      // The imperative panel handles throw once their group has unregistered
      // (same reason EditorArea's assertRightRailLayout wraps its calls). A throw
      // means the panel never resized, so no onResize fires and the invariant
      // guard cannot see it: recovery is the next `visible` transition
      // re-running this effect, or any later change to the panel's own box.
    }
  }, [bottomVisible, panelRef]);

  // The persisted height is viewport-relative: `readTerminalHeight` caps it at
  // 50vh, but only at read time, and this shell snapshots it once at mount. A
  // window that changes size afterwards — moving to another display being the
  // common case — otherwise keeps a ceiling computed for a viewport that no
  // longer exists, letting the dock occupy more than half the editor. Re-clamp
  // against the live viewport, and re-apply while open so an open dock shrinks
  // with the window rather than waiting for the next remount.
  useEffect(() => {
    const reclampToViewport = () => {
      const next = clampTerminalHeight(heightPxRef.current);
      if (next === heightPxRef.current) return;
      heightPxRef.current = next;
      if (!bottomVisible) return;
      try {
        panelRef.current?.resize(`${next}px`);
      } catch {
        // Panel unregistered mid-flight — nothing to re-clamp against.
      }
    };
    window.addEventListener('resize', reclampToViewport);
    return () => window.removeEventListener('resize', reclampToViewport);
  }, [bottomVisible, panelRef]);

  return (
    <ResizablePanelGroup
      orientation="vertical"
      className="min-h-0 flex-1"
      data-dragging={isDragging || undefined}
    >
      <ResizablePanel minSize="5%" className="flex min-h-0 flex-col">
        {/* tabIndex -1 makes this a programmatic focus target for focus-return on
            collapse without adding it to the tab order. */}
        <div
          ref={onEditorRegion}
          tabIndex={-1}
          className="relative flex h-full min-h-0 flex-col outline-none"
        >
          {children}
        </div>
      </ResizablePanel>
      {/* The handle drags only while the panel is open: you can resize it, and
          drag all the way down to collapse (hide). While hidden it is disabled —
          the terminal has no edge tab, so ⌘J (or the View menu) is the way back
          in and drag-up-to-open would be a hidden second entry point. Gating on
          controlled props (not `isCollapsed`) means an in-progress drag-to-collapse
          completes before the handle disables on the next commit. */}
      {placement === 'bottom' ? (
        <>
          <ResizableHandle
            withHandle={bottomVisible}
            disabled={!bottomVisible}
            onPointerDown={(event) => {
              if (!bottomVisible) return;
              // A prior gesture that never saw a release would otherwise leave the
              // flag set forever.
              endDragRef.current?.();
              setIsDragging(true);
              isDraggingRef.current = true;
              const { pointerId } = event;
              // A drag ends on `pointerup` OR `pointercancel`: a cancelled pointer
              // fires NO pointerup — once the browser suppresses a pointer stream
              // (touch pan/zoom/scroll takeover, or the OS invalidating the
              // pointer) no further events arrive for that pointerId. Without the
              // cancel arm the flag stays set, and every later imperative or
              // observer-driven resize reads as a user drag: `onVisibleChange`
              // fires spuriously, the persisted height gets overwritten, and the
              // stranded-dock guard stops firing.
              //
              // `window` is the right target because a release outside the dock
              // still lands there; both listeners are scoped to the originating
              // `pointerId` so a second touch's cancel cannot end this drag.
              const end = () => {
                setIsDragging(false);
                isDraggingRef.current = false;
                window.removeEventListener('pointerup', onEnd);
                window.removeEventListener('pointercancel', onEnd);
                endDragRef.current = null;
              };
              const onEnd = (ev: PointerEvent) => {
                if (ev.pointerId !== pointerId) return;
                end();
              };
              endDragRef.current = end;
              window.addEventListener('pointerup', onEnd);
              window.addEventListener('pointercancel', onEnd);
            }}
          />
          <ResizablePanel
            id={TERMINAL_PANEL_ID}
            // Paint the whole dock surface with the exact xterm canvas color so the tab
            // strip, its controls, and any chrome read as one continuous surface with
            // the terminal — no app-background seam between the strip and canvas.
            style={{ backgroundColor: xtermBackground }}
            panelRef={panelRef}
            defaultSize={bottomVisible ? `${initialHeightPx}px` : 0}
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
              // Invariant: the bottom panel occupies ZERO height whenever the dock is
              // hidden. The `visible` effect asserts that only on a TRANSITION, so
              // any path leaving the panel expanded without flipping `visible` — a
              // library re-layout, or a collapse
              // issued while the group was unmeasurable and therefore discarded —
              // strands the editor behind an empty band with no dock chrome and
              // nothing left to re-assert it. This is the panel's own resize signal,
              // so it catches that state whatever produced it. The handle is disabled
              // while hidden, so an expanded-hidden panel is never a user width worth
              // preserving.
              //
              // Gate on pixels rather than `collapsed`: an unmeasurable group makes
              // `asPercentage` NaN, which compares false against 0 and would read as
              // "expanded", firing this guard spuriously on a panel that has no size
              // at all.
              if (!bottomVisible && size.inPixels > 0 && !isDraggingRef.current) {
                reportStrandedDock(size.inPixels, size.asPercentage);
                try {
                  panelRef.current?.collapse();
                } catch {
                  // Panel unregistered mid-flight — the next resize re-asserts.
                }
                return;
              }
              // Persist + reflect to controlled visibility only on a user drag;
              // imperative replays from the `visible` effect also fire onResize and must
              // not overwrite the persisted value or loop onVisibleChange.
              if (isDraggingRef.current) {
                if (collapsed && bottomVisible) onVisibleChange(false);
                else if (!collapsed && !bottomVisible) onVisibleChange(true);
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
            {/* Mount point for the terminal host's stable host div. */}
            <div ref={onBottomContainer} className="flex min-h-0 flex-1 flex-col overflow-hidden" />
          </ResizablePanel>
        </>
      ) : null}
    </ResizablePanelGroup>
  );
}
