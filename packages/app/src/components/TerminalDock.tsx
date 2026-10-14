import type { TerminalPlacement } from '@inkeep/open-knowledge-core/terminal-layout';
import { useLingui } from '@lingui/react/macro';
import { useTheme } from 'next-themes';
import {
  type ReactNode,
  type Ref,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { usePanelRef } from 'react-resizable-panels';
import {
  PANE_CARD_GAP_LEAD_INSET_PX,
  PANE_CARD_GAP_TRAIL_INSET_PX,
  PaneCard,
  type PaneCardVariant,
  paneCardDividerClass,
} from '@/components/ui/pane-card';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable';
import {
  clampTerminalHeight,
  getInitialTerminalHeight,
  writeTerminalHeight,
} from '@/lib/terminal-height-store';
import { cn } from '@/lib/utils';
import { reportUnexpectedPanelGroupFailure } from './editor-area-panel-space';
import { useLiveXtermTheme } from './use-live-xterm-theme';

const TERMINAL_PANEL_ID = 'terminal-dock-panel';
const FULL_COLUMN = '100%';

export const MAX_STRANDED_REPORTS = 5;

export interface TerminalDockHandle {
  bringBackBottom(): void;
}

interface TerminalDockProps {
  readonly ref?: Ref<TerminalDockHandle>;
  readonly editorVisible?: boolean;
  readonly onBottomCollapsedChange?: (collapsed: boolean) => void;
  readonly children: ReactNode;
  readonly placement?: TerminalPlacement;
  readonly visible: boolean;
  readonly available: boolean;
  readonly variant: PaneCardVariant;
  readonly onVisibleChange: (visible: boolean) => void;
  readonly onBottomContainer: (el: HTMLDivElement | null) => void;
}

export function TerminalDock({
  ref,
  editorVisible = true,
  onBottomCollapsedChange,
  children,
  placement = 'bottom',
  visible,
  available,
  variant,
  onVisibleChange,
  onBottomContainer,
}: TerminalDockProps) {
  const { t } = useLingui();
  const { resolvedTheme } = useTheme();
  const panelRef = usePanelRef();
  const bottomPresent = placement === 'bottom' && available;
  const bottomVisible = bottomPresent && visible;
  const fillsColumn = bottomVisible && !editorVisible;
  const bottomHandleShown = bottomVisible && editorVisible;
  const cardLook = variant === 'card';
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

  function bottomTargetSize(): string {
    return fillsColumn ? FULL_COLUMN : `${heightPxRef.current}px`;
  }

  useLayoutEffect(() => {
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

  const previousFillsColumnRef = useRef(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the resize target is sampled when the column-filling state flips; the flip owns the resize
  useLayoutEffect(() => {
    const changed = previousFillsColumnRef.current !== fillsColumn;
    previousFillsColumnRef.current = fillsColumn;
    if (!changed) return;
    const target = bottomTargetSize();
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled || !bottomVisible) return;
      try {
        panelRef.current?.resize(target);
      } catch (error) {
        reportUnexpectedPanelGroupFailure('terminal-dock-fill-resize-failed', error);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [fillsColumn]);

  useImperativeHandle(ref, () => ({
    bringBackBottom: () => {
      if (!bottomVisible) return;
      try {
        panelRef.current?.resize(bottomTargetSize());
      } catch (error) {
        reportUnexpectedPanelGroupFailure('terminal-dock-bring-back-failed', error);
      }
    },
  }));

  useEffect(() => {
    const reclampToViewport = () => {
      const next = clampTerminalHeight(heightPxRef.current);
      if (next === heightPxRef.current) return;
      heightPxRef.current = next;
      if (!bottomVisible || fillsColumn) return;
      try {
        panelRef.current?.resize(`${next}px`);
      } catch {}
    };
    window.addEventListener('resize', reclampToViewport);
    return () => window.removeEventListener('resize', reclampToViewport);
  }, [bottomVisible, fillsColumn, panelRef]);

  return (
    <ResizablePanelGroup
      orientation="vertical"
      className="min-h-0 flex-1"
      data-editor-column-split=""
      style={{ overflow: 'visible' }}
      data-dragging={isDragging || undefined}
    >
      <ResizablePanel
        minSize={editorVisible ? '5%' : '0%'}
        className="flex min-h-0 flex-col"
        style={{
          paddingBlockEnd:
            cardLook && bottomVisible && editorVisible ? PANE_CARD_GAP_LEAD_INSET_PX : 0,
          overflow: editorVisible ? 'visible' : 'hidden',
        }}
      >
        {children}
      </ResizablePanel>
      {}
      {bottomPresent ? (
        <>
          <ResizableHandle
            aria-controls={TERMINAL_PANEL_ID}
            aria-label={t`Resize terminal`}
            withHandle={bottomHandleShown}
            disabled={!bottomHandleShown}
            className={paneCardDividerClass(variant, 'horizontal')}
            style={bottomHandleShown ? undefined : { display: 'none' }}
            onPointerDown={(event) => {
              if (!bottomHandleShown) return;
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
            style={{ overflow: 'visible' }}
            panelRef={panelRef}
            defaultSize={bottomVisible ? `${initialHeightPx}px` : 0}
            minSize="120px"
            maxSize={editorVisible ? '95%' : FULL_COLUMN}
            collapsible
            collapsedSize={0}
            onResize={(size) => {
              const collapsed = size.asPercentage === 0;
              setIsCollapsed(collapsed);
              onBottomCollapsedChange?.(collapsed);
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
            <PaneCard
              pane="terminal"
              variant={variant}
              data-placement="bottom"
              className={cn(isCollapsed && 'shadow-none')}
              style={{
                backgroundColor: xtermBackground,
                marginBlockStart: cardLook && editorVisible ? PANE_CARD_GAP_TRAIL_INSET_PX : 0,
              }}
            >
              {}
              <div
                ref={onBottomContainer}
                className="flex min-h-0 flex-1 flex-col overflow-hidden"
              />
            </PaneCard>
          </ResizablePanel>
        </>
      ) : null}
    </ResizablePanelGroup>
  );
}
