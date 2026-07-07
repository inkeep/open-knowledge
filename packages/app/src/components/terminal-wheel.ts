/**
 * Wheel→mouse-report mapping for the terminal when a full-screen TUI (claude,
 * vim, less) has enabled mouse tracking. In that mode xterm forwards the wheel
 * to the app as one mouse-wheel report PER OS wheel event, with no accumulation
 * (xtermjs/xterm.js #3848). macOS trackpad momentum and free-spin/fast-scroll
 * wheels emit a high-frequency stream of decaying events, so the app is flooded
 * with reports — the "rocket scroll" jumpiness AI CLIs hit in xterm.js
 * (github/copilot-cli #1805).
 *
 * The fix both upstream issues converge on (and what native terminals do):
 * accumulate fractional rows of travel and emit one wheel report per whole row
 * of pixel distance crossed. Travel then tracks actual distance regardless of
 * how many events deliver it — frequency-independent, so a slow drag and a fast
 * flick over the same distance scroll the same amount, and there is no dead zone
 * (sub-row movement is carried in the remainder rather than dropped).
 *
 * Reports carry the pointer's cell (see wheelReportPosition), not a fixed
 * corner: coordinate hit-testing TUIs (opencode/opentui, bubbletea) route the
 * wheel to the component under the reported cell, so a constant 1;1 made them
 * scroll-dead in the terminal panel while claude/vim/less (which ignore the
 * coordinates) kept working.
 */

/** SGR mouse button code for a wheel report: 64 = wheel up, 65 = wheel down. */
export type WheelButton = 64 | 65;

export interface WheelReportOptions {
  /** Rendered cell height in CSS px — converts pixel deltas to rows. */
  readonly cellHeight: number;
  /** Rows of report emitted per row of pixels travelled. 1 ≈ native. */
  readonly sensitivity: number;
  /** Per-event clamp; bounds a single coalesced momentum spike. */
  readonly maxRowsPerEvent: number;
  /** Viewport row count — only used to size a DOM_DELTA_PAGE wheel event. */
  readonly viewportRows: number;
}

export interface WheelReportResult {
  /** Number of SGR wheel reports to emit (0 when the event was sub-row). */
  readonly count: number;
  /** Direction; only meaningful when {@link count} > 0. */
  readonly button: WheelButton;
  /** Carry-forward fractional-row accumulator to thread into the next event. */
  readonly accumulator: number;
}

// WheelEvent.deltaMode values; named to avoid relying on the DOM enum at the
// pure-function boundary (this module has no DOM dependency, so it unit-tests
// without a DOM environment).
const DOM_DELTA_LINE = 1;
const DOM_DELTA_PAGE = 2;

/**
 * Map one wheel event to a count of SGR mouse-wheel reports, threading the
 * fractional-row accumulator across calls. Pure: callers persist `accumulator`
 * between events and reset it to 0 between gestures.
 *
 * When the whole-row count exceeds `maxRowsPerEvent` the excess is discarded
 * (not carried) — a momentum spike should be clamped, not queued into future
 * scrolling.
 */
export function nextWheelReports(
  deltaY: number,
  deltaMode: number,
  accumulator: number,
  opts: WheelReportOptions,
): WheelReportResult {
  const rows =
    deltaMode === DOM_DELTA_LINE
      ? deltaY
      : deltaMode === DOM_DELTA_PAGE
        ? deltaY * opts.viewportRows
        : deltaY / opts.cellHeight; // DOM_DELTA_PIXEL (and any unknown mode)

  const next = accumulator + rows * opts.sensitivity;
  const whole = Math.trunc(next);
  if (whole === 0) {
    // Sub-row movement: keep the remainder, emit nothing this event.
    return { count: 0, button: 65, accumulator: next };
  }
  return {
    count: Math.min(Math.abs(whole), opts.maxRowsPerEvent),
    button: whole < 0 ? 64 : 65,
    accumulator: next - whole,
  };
}

/** 1-based coordinates carried by an SGR wheel report — cells for SGR (1006),
 *  CSS px for SGR_PIXELS (1016). */
export interface WheelReportPosition {
  readonly x: number;
  readonly y: number;
}

/** Cell-width stand-in when the renderer hasn't measured yet; used to compute
 *  the pixel-encoding viewport extent (clamp bound and center fallback). */
const FALLBACK_CELL_WIDTH = 9;

/**
 * Map the pointer's offset within the terminal screen to the coordinates a
 * wheel report should carry. Hit-testing TUIs (opencode/opentui, bubbletea)
 * dispatch the wheel to the component under the reported cell — a report
 * pinned to a corner lands on a border/header and the scroll silently drops.
 *
 * `offsetX`/`offsetY` are CSS px relative to the screen element's top-left;
 * pass undefined (or non-finite) when the rect couldn't be measured — the
 * position degrades to the viewport center, which the scrollable content
 * region nearly always covers (unlike 1;1).
 */
export function wheelReportPosition(
  offsetX: number | undefined,
  offsetY: number | undefined,
  opts: {
    readonly cellWidth: number | undefined;
    readonly cellHeight: number;
    readonly cols: number;
    readonly rows: number;
    /** SGR_PIXELS negotiated: report CSS-px device coordinates, not cells. */
    readonly pixels: boolean;
  },
): WheelReportPosition {
  const cellWidth = opts.cellWidth !== undefined && opts.cellWidth > 0 ? opts.cellWidth : undefined;
  const clamp = (v: number, max: number) => Math.min(Math.max(v, 1), max);
  if (opts.pixels) {
    const maxX = Math.round((cellWidth ?? FALLBACK_CELL_WIDTH) * opts.cols);
    const maxY = Math.round(opts.cellHeight * opts.rows);
    return {
      x: isFiniteNumber(offsetX) ? clamp(Math.floor(offsetX) + 1, maxX) : Math.ceil(maxX / 2),
      y: isFiniteNumber(offsetY) ? clamp(Math.floor(offsetY) + 1, maxY) : Math.ceil(maxY / 2),
    };
  }
  return {
    x:
      isFiniteNumber(offsetX) && cellWidth !== undefined
        ? clamp(Math.floor(offsetX / cellWidth) + 1, opts.cols)
        : Math.ceil(opts.cols / 2),
    y: isFiniteNumber(offsetY)
      ? clamp(Math.floor(offsetY / opts.cellHeight) + 1, opts.rows)
      : Math.ceil(opts.rows / 2),
  };
}

// Number.isFinite doesn't narrow `number | undefined` under strict mode.
function isFiniteNumber(v: number | undefined): v is number {
  return v !== undefined && Number.isFinite(v);
}

/** SGR-encoded wheel report at the given 1-based position. The position must
 *  track the pointer (or fall back to viewport center): hit-testing TUIs
 *  scroll the component under the reported cell, and a constant corner
 *  position lands outside every scrollable region. */
export function sgrWheelReport(button: WheelButton, position: WheelReportPosition): string {
  return `\x1b[<${button};${position.x};${position.y}M`;
}
