/**
 * Same-frame repaint after anything clears the terminal's canvas bitmap.
 *
 * Setting a canvas's width — which xterm does on every grid resize, and which
 * the WebGL addon's device-pixel observer does a second time when a fractional
 * CSS width snaps differently to device pixels — clears the bitmap by spec,
 * while xterm's own repaint is rAF-scheduled. ResizeObserver callbacks run
 * after rAF in the frame lifecycle, so without intervention the browser paints
 * one frame with an empty canvas: the text blinks out per resize step during a
 * section drag (frame captures showed a full blank frame every few steps).
 *
 * The returned repaint queues a full refresh through the public API, then
 * flushes xterm's render debouncer so the glyphs are back before this frame's
 * paint — the resize-and-redraw-in-one-frame behavior GPU-native terminals
 * (Zed) get for free.
 *
 * The debouncer reach is a private xterm internal (like TerminalPanel's wheel
 * handler cell-height read) — it warns once if an xterm bump moves it, so the
 * regression shows up in QA rather than as a silent return of the flicker.
 */

/** Structural subset of xterm's Terminal the repaint drives. */
export interface RepaintableTerminal {
  readonly rows: number;
  refresh(start: number, end: number): void;
}

export function createSameFrameRepaint(
  term: RepaintableTerminal,
  warn: (message: string) => void = console.warn,
): () => void {
  let warnedMissingRenderFlush = false;
  return () => {
    term.refresh(0, term.rows - 1);
    const debouncer = (
      term as unknown as {
        _core?: { _renderService?: { _renderDebouncer?: { _innerRefresh?: () => void } } };
      }
    )._core?._renderService?._renderDebouncer;
    if (typeof debouncer?._innerRefresh === 'function') {
      debouncer._innerRefresh();
    } else if (!warnedMissingRenderFlush) {
      warnedMissingRenderFlush = true;
      warn(
        '[terminal] xterm render-debouncer internal not found; resize repaint deferring to the next frame. An xterm upgrade may have moved _core._renderService._renderDebouncer.',
      );
    }
  };
}
