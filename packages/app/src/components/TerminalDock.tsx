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

export const MAX_STRANDED_REPORTS = 5;

interface TerminalDockProps {
  readonly children: ReactNode;
  readonly placement?: TerminalPlacement;
  readonly visible: boolean;
  readonly onVisibleChange: (visible: boolean) => void;
  readonly onBottomContainer: (el: HTMLDivElement | null) => void;
  readonly onEditorRegion: (el: HTMLDivElement | null) => void;
}

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
        dockHeightPx: heightPxRef.current,
        innerWidth: window.innerWidth,
        innerHeight: window.innerHeight,
        devicePixelRatio: window.devicePixelRatio,
      }),
    );
  }

  const endDragRef = useRef<(() => void) | null>(null);
  useEffect(
    () => () => {
      if (writeTimerRef.current != null) clearTimeout(writeTimerRef.current);
      endDragRef.current?.();
    },
    [],
  );

  useEffect(() => {
    const panel = panelRef.current;
    if (panel == null) return;
    try {
      if (bottomVisible) {
        panel.resize(`${heightPxRef.current}px`);
      } else {
        panel.collapse();
      }
    } catch {}
  }, [bottomVisible, panelRef]);

  useEffect(() => {
    const reclampToViewport = () => {
      const next = clampTerminalHeight(heightPxRef.current);
      if (next === heightPxRef.current) return;
      heightPxRef.current = next;
      if (!bottomVisible) return;
      try {
        panelRef.current?.resize(`${next}px`);
      } catch {}
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
        {}
        <div
          ref={onEditorRegion}
          tabIndex={-1}
          className="relative flex h-full min-h-0 flex-col outline-none"
        >
          {children}
        </div>
      </ResizablePanel>
      {}
      {placement === 'bottom' ? (
        <>
          <ResizableHandle
            withHandle={bottomVisible}
            disabled={!bottomVisible}
            onPointerDown={(event) => {
              if (!bottomVisible) return;
              endDragRef.current?.();
              setIsDragging(true);
              isDraggingRef.current = true;
              const { pointerId } = event;
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
            style={{ backgroundColor: xtermBackground }}
            panelRef={panelRef}
            defaultSize={bottomVisible ? `${initialHeightPx}px` : 0}
            minSize="120px"
            maxSize="95%"
            collapsible
            collapsedSize={0}
            onResize={(size) => {
              const collapsed = size.asPercentage === 0;
              setIsCollapsed(collapsed);
              if (!bottomVisible && size.inPixels > 0 && !isDraggingRef.current) {
                reportStrandedDock(size.inPixels, size.asPercentage);
                try {
                  panelRef.current?.collapse();
                } catch {}
                return;
              }
              if (isDraggingRef.current) {
                if (collapsed && bottomVisible) onVisibleChange(false);
                else if (!collapsed && !bottomVisible) onVisibleChange(true);
                if (size.inPixels > 0) {
                  heightPxRef.current = size.inPixels;
                  debouncedWriteHeight(size.inPixels);
                }
              }
            }}
            inert={isCollapsed}
            className={cn(
              'flex flex-col',
              !isDragging &&
                'transition-[flex-grow] duration-150 ease-out motion-reduce:transition-none motion-reduce:duration-0',
            )}
          >
            {}
            <div ref={onBottomContainer} className="flex min-h-0 flex-1 flex-col overflow-hidden" />
          </ResizablePanel>
        </>
      ) : null}
    </ResizablePanelGroup>
  );
}
