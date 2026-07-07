/**
 * Heading extension override for source-text fidelity.
 *
 * Extends @tiptap/extension-heading (preserving setHeading/toggleHeading
 * commands, input rules, and keyboard shortcuts) with four source-form
 * attrs:
 *   - headingStyle:           ATX (# ...) vs setext (underline) form.
 *   - sourceTrailingHashes:   the trailing `#` run length on closed-form ATX
 *                             headings (`## H ##` → 2; CommonMark §4.2 lets
 *                             this count differ from the opening run).
 *                             `null` means no trailing hashes.
 *   - sourceUnderlineLength:  the underline run length on setext-form
 *                             headings (`H\n=====\n` → 5). Independent of
 *                             content length per CommonMark §4.3 (1+ chars).
 *                             `null` means no captured length (synthesized
 *                             PM tree, ATX form, or legacy input).
 *   - sourceContiguousNext:   setext-only — the next sibling at parse time
 *                             was a paragraph with NO blank line between
 *                             this heading's underline and the paragraph's
 *                             first line. Drives positionAwareBlankLineJoin
 *                             so the no-blank-line shape survives PM
 *                             round-trip (where source `position` info is
 *                             destroyed). Default `false`.
 *
 * Markdown parsing/serialization is handled by the unified pipeline (packages/core/src/markdown/).
 */

import Heading from '@tiptap/extension-heading';

export const HeadingFidelity = Heading.extend({
  priority: 60,

  addAttributes() {
    return {
      ...this.parent?.(),
      headingStyle: { default: 'atx' },
      sourceTrailingHashes: { default: null },
      sourceUnderlineLength: { default: null },
      sourceContiguousNext: { default: false },
      // ATX leading indent (1-3 spaces, CommonMark §4.2) + interior space
      // run between the opening `#` run and the content (`#   H` → 3).
      // Captured at parse time; null = canonical form.
      sourceLeadingIndent: { default: null, rendered: false },
      sourceInteriorSpacing: { default: null, rendered: false },
    };
  },
});
