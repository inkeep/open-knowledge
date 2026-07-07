/**
 * Strike mark override for source-text fidelity.
 *
 * Extends @tiptap/extension-strike (preserving setStrike/toggleStrike/
 * unsetStrike commands, the Cmd+Shift+S shortcut, and input rules) with a
 * delimiter-choice attribute:
 *
 *   - sourceDelimiter: `'~'` or `'~~'` as typed in source. GFM allows both
 *     (OK parses with `singleTilde` on); mdast-util-gfm-strikethrough's
 *     default serializer always emits `~~`, erasing the single-tilde form.
 *     Captured at parse time by position-slice (case 'delete'), threaded
 *     through this attr, and replayed by the custom `delete` to-markdown
 *     handler.
 *
 * Markdown parsing/serialization is handled by the unified pipeline
 * (packages/core/src/markdown/).
 */

import Strike from '@tiptap/extension-strike';

export const StrikeFidelity = Strike.extend({
  priority: 60,

  addAttributes() {
    return {
      ...this.parent?.(),
      sourceDelimiter: { default: '~~', rendered: false },
    };
  },
});
