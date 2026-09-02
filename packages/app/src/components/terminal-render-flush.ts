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
