/**
 * Table / TableCell / TableHeader extension overrides for source-text fidelity.
 *
 * `Table.sourceDashCounts: number[] | null`
 *   Per-column dash counts from the GFM alignment row in the source.
 *   Captured at parse time by position-slice; threaded through PM via
 *   this attr so the reverse PM→mdast walker can re-emit byte-equal
 *   alignment-row markers regardless of cell content width.
 *
 *   `null` means "no source recorded" (e.g., a WYSIWYG-authored table
 *   with no markdown roundtrip yet) — the to-markdown handler falls
 *   through to the canonical-min one-dash form.
 *
 *   The dashes are inherently per-column rather than per-cell, so the attr
 *   lives on the table node (not on each header cell).
 *
 * `TableCell.sourcePadding` / `TableHeader.sourcePadding: { left: number, right: number } | null`
 *   Per-cell padding (count of literal space chars between the surrounding
 *   `|` separators and the cell content) captured at parse time. Drives the
 *   to-markdown table handler to emit the user's chosen widths so hand-
 *   aligned tables (`| h1   | h2  |`) round-trip byte-equal instead of
 *   collapsing to canonical single-space padding.
 *
 *   `null` means "no source recorded" — the handler falls through to the
 *   canonical 1-space-each form (the gfm default). Object PM attrs round-trip
 *   as JSON through Y.js and through prosemirror-model node.attrs serialization.
 */

import { Table, TableCell, TableHeader } from '@tiptap/extension-table';

export const TableFidelity = Table.extend({
  priority: 60,

  addAttributes() {
    return {
      ...this.parent?.(),
      sourceDashCounts: { default: null },
      // Outer-pipe style ({ leading, trailing } booleans) recorded only
      // when uniform across every source line and at least one side omits
      // the pipe (`col|val` form). Table-level rather than per-row so the
      // style survives WYSIWYG row insertion/deletion. null = canonical
      // fully-piped emission.
      sourceOuterPipes: { default: null, rendered: false },
      // Per-column alignment-row cell padding — the delimiter-row sibling
      // of the per-cell sourcePadding (`|-|-|` → zero padding instead of
      // the canonical `| - |`). null = canonical 1-space-each.
      sourceAlignmentPadding: { default: null, rendered: false },
    };
  },
});

export const TableCellFidelity = TableCell.extend({
  priority: 60,

  addAttributes() {
    return {
      ...this.parent?.(),
      sourcePadding: { default: null },
    };
  },
});

export const TableHeaderFidelity = TableHeader.extend({
  priority: 60,

  addAttributes() {
    return {
      ...this.parent?.(),
      sourcePadding: { default: null },
    };
  },
});
