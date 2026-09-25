export interface OpenTabTooltip {
  readonly id: string | null;
  readonly openedAt: number;
}

export const CLOSED_TAB_TOOLTIP: OpenTabTooltip = { id: null, openedAt: 0 };

export function nextOpenTabTooltip(
  current: OpenTabTooltip,
  id: string,
  open: boolean,
  at: number,
): OpenTabTooltip {
  if (open) return { id, openedAt: at };
  return current.id === id ? { id: null, openedAt: current.openedAt } : current;
}
