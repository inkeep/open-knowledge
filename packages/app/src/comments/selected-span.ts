import type { Selection } from '@tiptap/pm/state';

export interface SelectedSpan {
  from: number;
  to: number;
}

export function selectedSpan(selection: Selection): SelectedSpan {
  let from = Number.POSITIVE_INFINITY;
  let to = Number.NEGATIVE_INFINITY;
  for (const range of selection.ranges) {
    if (range.$from.pos < from) from = range.$from.pos;
    if (range.$to.pos > to) to = range.$to.pos;
  }
  if (!Number.isFinite(from) || !Number.isFinite(to)) {
    return { from: selection.from, to: selection.to };
  }
  return { from, to };
}
