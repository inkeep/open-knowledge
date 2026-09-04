import { describe, expect, test } from 'vitest';
import {
  nextWheelReports,
  sgrWheelReport,
  type WheelReportOptions,
  wheelReportPosition,
} from './terminal-wheel';

const PIXEL = 0;
const LINE = 1;
const PAGE = 2;

const OPTS: WheelReportOptions = {
  cellHeight: 20,
  sensitivity: 1,
  maxRowsPerEvent: 4,
  viewportRows: 24,
};

function totalReports(deltas: readonly number[], opts: WheelReportOptions = OPTS): number {
  let acc = 0;
  let total = 0;
  for (const deltaY of deltas) {
    const r = nextWheelReports(deltaY, PIXEL, acc, opts);
    acc = r.accumulator;
    total += r.button === 65 ? r.count : -r.count;
  }
  return total;
}

describe('nextWheelReports', () => {
  test('emits one report per whole row of pixel travel (PIXEL mode)', () => {
    const r = nextWheelReports(60, PIXEL, 0, OPTS);
    expect(r.count).toBe(3);
    expect(r.button).toBe(65);
  });

  test('negative delta reports wheel-up (button 64)', () => {
    const r = nextWheelReports(-60, PIXEL, 0, OPTS);
    expect(r.count).toBe(3);
    expect(r.button).toBe(64);
  });

  test('is frequency-independent: same distance over many small events == one big event', () => {
    const many = totalReports(Array.from({ length: 20 }, () => 3));
    const one = totalReports([60]);
    expect(many).toBe(one);
    expect(one).toBe(3);
  });

  test('no dead zone: sub-row events accumulate instead of being dropped', () => {
    const first = nextWheelReports(5, PIXEL, 0, OPTS);
    expect(first.count).toBe(0);
    expect(first.accumulator).toBeCloseTo(0.25);
    expect(totalReports([5, 5, 5, 5])).toBe(1);
  });

  test('per-event count is clamped to maxRowsPerEvent (momentum-spike guard)', () => {
    const r = nextWheelReports(200, PIXEL, 0, OPTS);
    expect(r.count).toBe(4);
  });

  test('clamped excess is discarded (only the fractional remainder carries)', () => {
    const r = nextWheelReports(205, PIXEL, 0, OPTS);
    expect(r.count).toBe(4);
    expect(r.accumulator).toBeCloseTo(0.25);
  });

  test('reversing direction nets out at the sign boundary (frequency-independent)', () => {
    const down = nextWheelReports(30, PIXEL, 0, OPTS);
    expect(down.count).toBe(1);
    expect(down.button).toBe(65);
    expect(down.accumulator).toBeCloseTo(0.5);
    const up = nextWheelReports(-30, PIXEL, down.accumulator, OPTS);
    expect(up.count).toBe(1);
    expect(up.button).toBe(64);
    expect(up.accumulator).toBeCloseTo(0);
  });

  test('LINE mode counts deltaY directly as rows', () => {
    const r = nextWheelReports(3, LINE, 0, OPTS);
    expect(r.count).toBe(3);
    expect(r.button).toBe(65);
  });

  test('PAGE mode scales by the viewport row count', () => {
    const r = nextWheelReports(1, PAGE, 0, OPTS);
    expect(r.count).toBe(4);
  });

  test('sensitivity scales total travel linearly', () => {
    const base = totalReports([100]);
    const half = totalReports([100], { ...OPTS, sensitivity: 0.5 });
    expect(half).toBe(Math.trunc(base / 2));
  });
});

describe('sgrWheelReport', () => {
  test('encodes SGR wheel up/down press at the given position', () => {
    expect(sgrWheelReport(64, { x: 12, y: 7 })).toBe('\x1b[<64;12;7M');
    expect(sgrWheelReport(65, { x: 1, y: 1 })).toBe('\x1b[<65;1;1M');
  });
});

describe('wheelReportPosition', () => {
  const CELLS = { cellWidth: 10, cellHeight: 20, cols: 80, rows: 24, pixels: false };

  test('maps pointer offset to the 1-based cell under it', () => {
    expect(wheelReportPosition(0, 0, CELLS)).toEqual({ x: 1, y: 1 });
    expect(wheelReportPosition(9.9, 19.9, CELLS)).toEqual({ x: 1, y: 1 });
    expect(wheelReportPosition(10, 20, CELLS)).toEqual({ x: 2, y: 2 });
    expect(wheelReportPosition(505, 110, CELLS)).toEqual({ x: 51, y: 6 });
  });

  test('clamps to the viewport bounds (pointer over padding/scrollbar)', () => {
    expect(wheelReportPosition(-5, -5, CELLS)).toEqual({ x: 1, y: 1 });
    expect(wheelReportPosition(9999, 9999, CELLS)).toEqual({ x: 80, y: 24 });
  });

  test('falls back to viewport center when the offset is unmeasurable', () => {
    expect(wheelReportPosition(undefined, undefined, CELLS)).toEqual({ x: 40, y: 12 });
    expect(wheelReportPosition(Number.NaN, Number.NaN, CELLS)).toEqual({ x: 40, y: 12 });
  });

  test('falls back to horizontal center when cell width is unmeasured (cells mode)', () => {
    const noWidth = { ...CELLS, cellWidth: undefined };
    expect(wheelReportPosition(505, 110, noWidth)).toEqual({ x: 40, y: 6 });
  });

  test('SGR_PIXELS mode reports 1-based CSS-px coordinates', () => {
    const px = { ...CELLS, pixels: true };
    expect(wheelReportPosition(0, 0, px)).toEqual({ x: 1, y: 1 });
    expect(wheelReportPosition(505.7, 110.2, px)).toEqual({ x: 506, y: 111 });
    expect(wheelReportPosition(9999, 9999, px)).toEqual({ x: 800, y: 480 });
    expect(wheelReportPosition(undefined, undefined, px)).toEqual({ x: 400, y: 240 });
  });
});
