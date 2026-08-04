/**
 * The document span a selection actually covers.
 *
 * `Selection.from` / `.to` report the FIRST range only. For a `TextSelection`
 * there is exactly one range, so they are the whole story — but a table
 * `CellSelection` carries one range per selected cell, and its first range is
 * the ANCHOR cell. Reading `from`/`to` off a selected table row therefore
 * described a single cell: picking the row and commenting on it quoted `3`,
 * the anchor cell's text, instead of the row.
 *
 * The union of every range is a contiguous span because the ranges come from
 * one document: for a row it is exactly that row's cells, and for a column it
 * is the table region from the column's top cell through its bottom one. Both
 * are passages the anchor resolver can locate; a per-cell quote of a column
 * would not be, since the cells are not adjacent in the markdown source.
 */

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
  // A selection always has at least one range; the guard keeps a hypothetical
  // empty one from producing infinities that would poison every position math
  // downstream.
  if (!Number.isFinite(from) || !Number.isFinite(to)) {
    return { from: selection.from, to: selection.to };
  }
  return { from, to };
}
