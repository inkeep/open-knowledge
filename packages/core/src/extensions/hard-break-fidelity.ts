/**
 * HardBreak extension override for source-text fidelity.
 *
 * Extends @tiptap/extension-hard-break (preserving setHardBreak command
 * and Shift+Enter shortcut) and adds the hardBreakStyle attribute to
 * distinguish backslash from two-space hard breaks.
 *
 * Markdown parsing/serialization is handled by the unified pipeline (packages/core/src/markdown/).
 */

import HardBreak from '@tiptap/extension-hard-break';

export const HardBreakFidelity = HardBreak.extend({
  priority: 60,

  addAttributes() {
    return {
      ...this.parent?.(),
      hardBreakStyle: { default: 'backslash' },
      // Void-HTML-authored breaks (`<br>` / `<br/>` / `<br />`) carry their
      // exact source spelling so serialization re-emits it byte-identically.
      sourceRaw: { default: null },
    };
  },
});
