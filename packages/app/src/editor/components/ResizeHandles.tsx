
import { useLingui } from '@lingui/react/macro';
import { useRef } from 'react';
import { cn } from '@/lib/utils';

interface ResizeBounds {
  minWidth?: number;
  maxWidth?: number;
  minHeight?: number;
  maxHeight?: number;
}

type HandleKey = 'tl' | 't' | 'tr' | 'r' | 'br' | 'b' | 'bl' | 'l';

interface HandleSpec {
  key: HandleKey;
  dx: -1 | 0 | 1;
  dy: -1 | 0 | 1;
  cursor: string;
  className: string;
}

const HANDLES: ReadonlyArray<HandleSpec> = [
  {
    key: 'tl',
    dx: -1,
    dy: -1,
    cursor: 'nwse-resize',
    className: 'ok-resize-handle ok-resize-handle--tl',
  },
  {
    key: 't',
    dx: 0,
    dy: -1,
    cursor: 'ns-resize',
    className: 'ok-resize-handle ok-resize-handle--t',
  },
  {
    key: 'tr',
    dx: 1,
    dy: -1,
    cursor: 'nesw-resize',
    className: 'ok-resize-handle ok-resize-handle--tr',
  },
  {
    key: 'r',
    dx: 1,
    dy: 0,
    cursor: 'ew-resize',
    className: 'ok-resize-handle ok-resize-handle--r',
  },
  {
    key: 'br',
    dx: 1,
    dy: 1,
    cursor: 'nwse-resize',
    className: 'ok-resize-handle ok-resize-handle--br',
  },
  {
    key: 'b',
    dx: 0,
    dy: 1,
    cursor: 'ns-resize',
    className: 'ok-resize-handle ok-resize-handle--b',
  },
  {
    key: 'bl',
    dx: -1,
    dy: 1,
    cursor: 'nesw-resize',
    className: 'ok-resize-handle ok-resize-handle--bl',
  },
  {
    key: 'l',
    dx: -1,
    dy: 0,
    cursor: 'ew-resize',
    className: 'ok-resize-handle ok-resize-handle--l',
  },
];

interface ResizeHandlesProps {
  targetRef: React.RefObject<HTMLElement | null>;
  onResize: (size: { width: number; height: number }) => void;
  onResizeEnd?: (size: { width: number; height: number }) => void;
  bounds?: ResizeBounds;
}

export function ResizeHandles({ targetRef, onResize, onResizeEnd, bounds }: ResizeHandlesProps) {
  const { t } = useLingui();
  const dragRef = useRef<{
    handle: HandleSpec;
    startX: number;
    startY: number;
    startWidth: number;
    startHeight: number;
    latestWidth: number;
    latestHeight: number;
    hasMoved: boolean;
  } | null>(null);

  function clamp(px: number, axis: 'w' | 'h') {
    const min = axis === 'w' ? (bounds?.minWidth ?? 64) : (bounds?.minHeight ?? 64);
    const max = axis === 'w' ? (bounds?.maxWidth ?? Infinity) : (bounds?.maxHeight ?? Infinity);
    return Math.max(min, Math.min(max, px));
  }

  function handlePointerDown(e: React.PointerEvent, handle: HandleSpec) {
    const target = targetRef.current;
    if (!target) return;
    e.preventDefault();
    e.stopPropagation();
    const rect = target.getBoundingClientRect();
    dragRef.current = {
      handle,
      startX: e.clientX,
      startY: e.clientY,
      startWidth: rect.width,
      startHeight: rect.height,
      latestWidth: rect.width,
      latestHeight: rect.height,
      hasMoved: false,
    };
    const captureTarget = e.currentTarget;
    try {
      captureTarget.setPointerCapture(e.pointerId);
    } catch {
    }
    document.body.style.setProperty('cursor', handle.cursor);
    document.body.style.setProperty('user-select', 'none');
    function onPointerMove(ev: PointerEvent) {
      const drag = dragRef.current;
      if (!drag) return;
      const dx = (ev.clientX - drag.startX) * drag.handle.dx;
      const dy = (ev.clientY - drag.startY) * drag.handle.dy;
      const nextWidth = drag.handle.dx === 0 ? drag.startWidth : clamp(drag.startWidth + dx, 'w');
      const nextHeight =
        drag.handle.dy === 0 ? drag.startHeight : clamp(drag.startHeight + dy, 'h');
      drag.latestWidth = nextWidth;
      drag.latestHeight = nextHeight;
      drag.hasMoved = true;
      onResize({ width: nextWidth, height: nextHeight });
    }
    function onPointerUp() {
      const drag = dragRef.current;
      if (!drag) return;
      const finalSize = { width: drag.latestWidth, height: drag.latestHeight };
      const moved = drag.hasMoved;
      dragRef.current = null;
      document.body.style.removeProperty('cursor');
      document.body.style.removeProperty('user-select');
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerUp);
      if (moved) onResizeEnd?.(finalSize);
    }
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerUp);
  }

  return (
    <div className="ok-resize-overlay" contentEditable={false} aria-hidden="true">
      {HANDLES.map((handle) => {
        const handleKey = handle.key;
        return (
          <button
            key={handleKey}
            type="button"
            className={cn(handle.className)}
            aria-label={t`Resize ${handleKey}`}
            tabIndex={-1}
            style={{ cursor: handle.cursor }}
            onPointerDown={(e) => handlePointerDown(e, handle)}
          />
        );
      })}
    </div>
  );
}
