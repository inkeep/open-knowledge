/**
 * Blockquote extension override for source-text fidelity.
 *
 * Extends @tiptap/extension-blockquote (preserving setBlockquote /
 * toggleBlockquote / unsetBlockquote commands and the `> ` input rule) with
 * one source-form attr:
 *
 *   - sourceMarkerSpacings:  per-line marker spacing array captured at parse
 *                            time. Each entry is `'single'` (`> foo`) or
 *                            `'none'` (`>foo`); the array is one entry per
 *                            non-blank source line. The to-markdown handler
 *                            walks output lines and emits the matching marker
 *                            per line, falling back to `'single'` (CommonMark
 *                            canonical) for indices beyond the captured array
 *                            length (e.g., WYSIWYG-authored edits that grew
 *                            the blockquote past the original line count).
 *
 *                            Blank-line `>` continuations are excluded from
 *                            capture — their spacing isn't user-meaningful
 *                            (no content to space against) and including them
 *                            would drift the index when serialize inserts
 *                            blank lines between block-level children.
 *
 * Markdown parsing/serialization is handled by the unified pipeline
 * (packages/core/src/markdown/).
 */

import Blockquote from '@tiptap/extension-blockquote';

export const BlockquoteFidelity = Blockquote.extend({
  priority: 60,

  addAttributes() {
    return {
      ...this.parent?.(),
      sourceMarkerSpacings: { default: null },
    };
  },
});
