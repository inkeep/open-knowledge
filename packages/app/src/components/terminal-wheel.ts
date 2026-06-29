export type WheelButton = 64 | 65;

export interface WheelReportOptions {
  readonly cellHeight: number;
  readonly sensitivity: number;
  readonly maxRowsPerEvent: number;
  readonly viewportRows: number;
}

export interface WheelReportResult {
  readonly count: number;
  readonly button: WheelButton;
  readonly accumulator: number;
}

const DOM_DELTA_LINE = 1;
const DOM_DELTA_PAGE = 2;

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
    return { count: 0, button: 65, accumulator: next };
  }
  return {
    count: Math.min(Math.abs(whole), opts.maxRowsPerEvent),
    button: whole < 0 ? 64 : 65,
    accumulator: next - whole,
  };
}

/** SGR-encoded wheel report at position 1;1 (always inside the window; mouse-
 *  mode apps scroll their active region regardless of the pointer cell). */
export function sgrWheelReport(button: WheelButton): string {
  return `\x1b[<${button};1;1M`;
}
