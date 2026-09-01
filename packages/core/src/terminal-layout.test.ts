import { describe, expect, test } from 'vitest';
import {
  MIN_TERMINAL_RIGHT_WIDTH,
  normalizeTerminalRightWidth,
  PREFERRED_TERMINAL_RIGHT_WIDTH,
  RIGHT_TERMINAL_CELL_WIDTH_PX,
  RIGHT_TERMINAL_CHROME_WIDTH_PX,
} from './terminal-layout';

const columnsIn = (width: number) =>
  Math.floor((width - RIGHT_TERMINAL_CHROME_WIDTH_PX) / RIGHT_TERMINAL_CELL_WIDTH_PX);

describe('terminal right-panel width contract', () => {
  test('the preferred width preserves 92 columns plus xterm chrome', () => {
    expect(PREFERRED_TERMINAL_RIGHT_WIDTH).toBe(740);
    expect(columnsIn(PREFERRED_TERMINAL_RIGHT_WIDTH)).toBeGreaterThanOrEqual(92);
  });

  test('the drag floor sits at parity with the other rail columns', () => {
    expect(MIN_TERMINAL_RIGHT_WIDTH).toBe(324);
    expect(MIN_TERMINAL_RIGHT_WIDTH).toBeLessThan(PREFERRED_TERMINAL_RIGHT_WIDTH);
  });

  test('an absent width opens at the preferred width, not the floor', () => {
    expect(normalizeTerminalRightWidth(undefined)).toBe(PREFERRED_TERMINAL_RIGHT_WIDTH);
    expect(normalizeTerminalRightWidth(Number.NaN)).toBe(PREFERRED_TERMINAL_RIGHT_WIDTH);
  });

  test('a width the user dragged narrow survives normalization', () => {
    expect(normalizeTerminalRightWidth(420)).toBe(420);
    expect(normalizeTerminalRightWidth(MIN_TERMINAL_RIGHT_WIDTH)).toBe(MIN_TERMINAL_RIGHT_WIDTH);
  });

  test('a width below the floor clamps up to it', () => {
    expect(normalizeTerminalRightWidth(120)).toBe(MIN_TERMINAL_RIGHT_WIDTH);
  });
});
