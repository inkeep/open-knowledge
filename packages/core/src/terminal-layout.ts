export const TERMINAL_PLACEMENTS = ['bottom', 'right'] as const;

export type TerminalPlacement = (typeof TERMINAL_PLACEMENTS)[number];

export const DEFAULT_TERMINAL_PLACEMENT: TerminalPlacement = 'bottom';
export const RIGHT_TERMINAL_CELL_WIDTH_PX = 8;
export const RIGHT_TERMINAL_CHROME_WIDTH_PX = 4;

/**
 * Columns the column opens at. An agent CLI transcript wraps into unreadability
 * below this, so it is what the terminal is worth by default — not what the user
 * is held to.
 */
export const RIGHT_TERMINAL_PREFERRED_COLUMNS = 92;

/**
 * Columns the drag floor allows. Set for parity with the other rail columns
 * (agents 320px, document pane 300px) rather than for transcript readability:
 * a terminal narrower than the preferred width is a deliberate user choice, and
 * a floor that outweighs both peers combined makes the rail unbalanceable.
 */
export const RIGHT_TERMINAL_MIN_COLUMNS = 40;

const widthForColumns = (columns: number) =>
  columns * RIGHT_TERMINAL_CELL_WIDTH_PX + RIGHT_TERMINAL_CHROME_WIDTH_PX;

export const PREFERRED_TERMINAL_RIGHT_WIDTH = widthForColumns(RIGHT_TERMINAL_PREFERRED_COLUMNS);
export const MIN_TERMINAL_RIGHT_WIDTH = widthForColumns(RIGHT_TERMINAL_MIN_COLUMNS);

export function normalizeTerminalPlacement(value: unknown): TerminalPlacement {
  return value === 'right' || value === 'bottom' ? value : DEFAULT_TERMINAL_PLACEMENT;
}

export function normalizeTerminalRightWidth(value: unknown): number {
  // A missing width has never been sized by anyone, so it opens at the preferred
  // width; a real one is only clamped to the floor. Clamping to the preferred
  // width instead would silently undo every narrow width a user dragged.
  if (typeof value !== 'number' || !Number.isFinite(value)) return PREFERRED_TERMINAL_RIGHT_WIDTH;
  return Math.max(MIN_TERMINAL_RIGHT_WIDTH, Math.round(value));
}
