import { useLayoutEffect, useState } from 'react';
import type { ThreadHistoryMode } from '@/components/acp/ThreadHistoryPanel';

export const HISTORY_PANEL_WIDTH_PX = 248;
const HISTORY_MIN_TRANSCRIPT_WIDTH_PX = 300;
const HISTORY_DIVIDER_WIDTH_PX = 1;

function historyModeForPaneWidth(width: number): ThreadHistoryMode {
  return width >=
    HISTORY_PANEL_WIDTH_PX + HISTORY_MIN_TRANSCRIPT_WIDTH_PX + HISTORY_DIVIDER_WIDTH_PX
    ? 'docked'
    : 'cover';
}

export function useHistoryPresentationMode(
  container: HTMLElement | null,
  enabled: boolean,
): { mode: ThreadHistoryMode; remeasure: () => void } {
  const [mode, setMode] = useState<ThreadHistoryMode>('cover');

  useLayoutEffect(() => {
    if (!enabled || container == null) return;
    let frame = 0;
    const updateMode = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        setMode(historyModeForPaneWidth(container.getBoundingClientRect().width));
      });
    };
    updateMode();
    const observer = new ResizeObserver(updateMode);
    observer.observe(container);
    return () => {
      window.cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [container, enabled]);

  return {
    mode,
    remeasure: () => {
      if (container == null) return;
      setMode(historyModeForPaneWidth(container.getBoundingClientRect().width));
    },
  };
}
