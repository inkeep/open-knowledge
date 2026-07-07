/**
 * ResizeHandles — 8-handle resize primitive for inline-flow rich blocks.
 *
 * Shared across Embed + codeblock-preview (and anything else that wants
 * pointer-driven resizing). Replaces the native CSS `resize: both` grip
 * with explicit handles on the four corners + four edges so the affordance
 * is visible without the user having to find the bottom-right corner.
 *
 * Geometry
 * --------
 * Eight handles total. Layout follows the visual convention from the
 * mock — small L-shaped brackets at the corners, thin lines at the edges.
 * Each handle is positioned absolutely against the wrapper's box; the
 * wrapper must carry `position: relative` (or `absolute` / `fixed`).
 *
 *   ┌─ ───── ─┐
 *   │         │
 *   │         │
 *   │         │
 *   └─ ───── ─┘
 *
 * Drag semantics
 * --------------
 * All handles change width and/or height — the element stays in document
 * flow, so dragging "outward" (away from the element's centre) grows that
 * dimension, dragging "inward" shrinks it. Top/left handles use the
 * mirrored sign so the gesture feels consistent with the grip you grab:
 * pulling the top edge UP makes the element TALLER, not pushes it down.
 *
 * The hook fires `onResize({ width, height })` on every pointermove with
 * px values clamped to the configured min/max. Callers persist by
 * debouncing the writes (the underlying NodeView's update path is
 * typically the same shape used for the codeblock preview `h=` token).
 */

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

// Sign per axis: drag direction (dx/dy = +1) of the grip relative to the
// element's centre. The hook flips the delta sign for "inward" drags so
// the dimension change matches the gesture (pull-outward = grow).
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
  /** Target whose width / height should track the drag. Required. */
  targetRef: React.RefObject<HTMLElement | null>;
  /**
   * Fires on every pointermove during a drag with the new pixel dimensions.
   * Caller decides whether to apply directly or debounce + persist.
   */
  onResize: (size: { width: number; height: number }) => void;
  /**
   * Fires once on pointerup so the caller can commit the final size
   * (persist to props / fence meta). Always preceded by at least one
   * `onResize` if the drag moved at all.
   */
  onResizeEnd?: (size: { width: number; height: number }) => void;
  bounds?: ResizeBounds;
}

export function ResizeHandles({ targetRef, onResize, onResizeEnd, bounds }: ResizeHandlesProps) {
  const { t } = useLingui();
  // Captured-pointer state for the active drag. Kept in a ref because the
  // updates fire faster than React state can reconcile and we don't render
  // anything driven by it.
  const dragRef = useRef<{
    handle: HandleSpec;
    startX: number;
    startY: number;
    startWidth: number;
    startHeight: number;
    latestWidth: number;
    latestHeight: number;
    /**
     * True once the pointer has moved during this gesture. Distinguishes a
     * resize drag from a stray click on the handle — without this, a
     * pointerdown → pointerup with zero movement still fires `onResizeEnd`
     * with `latestWidth/Height === startWidth/Height` (the measured pixel
     * dimensions at click time). Callers that persist into CSS-unit fields
     * (Embed's `width`/`height` props, codeblock-preview's `h=`/`w=` meta
     * tokens) would then stamp `26rem` defaults with pixel equivalents on
     * a mere tap. Set by `onPointerMove`; checked in `onPointerUp`.
     */
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
    // Capture the pointer on the handle button so subsequent pointermove
    // events for this pointerId fire on the button (and bubble to the
    // window listeners below) regardless of what element is under the
    // cursor. Without this, a fast inward drag whose path crosses the
    // sandboxed iframe inside the wrapper — code-block HTML preview, or
    // any future iframe-bearing target — drops pointermove to the
    // iframe's cross-origin contentWindow (sandbox + no
    // allow-same-origin → null origin → opaque hit-test), and the
    // wrapper appears to "freeze" mid-resize. Slow drags keep the
    // cursor near the handle, outside the iframe, so the bug only
    // surfaces under fast movement — exactly the symptom users hit.
    //
    // Capture is auto-released on pointerup / pointercancel, so the
    // existing cleanup path covers it.
    const captureTarget = e.currentTarget;
    try {
      captureTarget.setPointerCapture(e.pointerId);
    } catch {
      // setPointerCapture throws if the pointer is no longer active —
      // benign race (the gesture was cancelled before capture). The
      // drag would degrade to the pre-fix behavior; no need to abort.
    }
    // Mirror the grip's cursor onto <body> for the full drag so the cursor
    // stays correct when the pointer briefly leaves the handle (browsers
    // otherwise revert to the default cursor mid-drag).
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
      // Skip the commit if the pointer never moved — a stray click on a
      // handle would otherwise overwrite CSS-unit defaults (Embed's
      // `26rem` height, codeblock-preview's `h=40rem` meta) with the
      // measured pixel equivalent.
      if (moved) onResizeEnd?.(finalSize);
    }
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    // `pointercancel` fires when the browser interrupts the gesture
    // (touch scroll-takeover, system dialog, tab visibility flip,
    // gesture interruption). Without this, the body cursor + user-select
    // mutations and the captured `dragRef` would leak — the next drag
    // would start from stale `startWidth/Height` and the document
    // cursor would stay stuck on `nwse-resize` until the next clean
    // drag completes.
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
