/**
 * Underline mark override for source-text fidelity.
 *
 * Extends @tiptap/extension-underline (preserving setUnderline/toggleUnderline/
 * unsetUnderline commands and the Mod-U shortcut) with a source-form attribute:
 *
 *   - sourceForm: `'u'` or `'ins'` as authored. Markdown has no native
 *     underline construct, so the construct-canonical emission IS raw inline
 *     HTML. Two spellings are accepted on the way in — `<u>` (what Typora,
 *     MarkText and Obsidian write, and what this mark renders as) and `<ins>`
 *     (what Joplin and Logseq write, and the only one GitHub's sanitizer
 *     keeps) — and each re-emits the spelling it arrived as, so an imported
 *     file round-trips byte-identically instead of being rewritten under the
 *     author.
 *
 * `Mod-U` and the bubble menu produce the default `'u'`.
 *
 * Registered in place of StarterKit's bundled Underline (disabled there), the
 * same way Bold/Italic/Strike/Code are replaced by their fidelity variants.
 * Upstream's `renderMarkdown` (`++text++`) is inert here: markdown
 * serialization runs through the unified pipeline
 * (packages/core/src/markdown/), never TipTap's own markdown layer.
 *
 * No `excludes` field: underline must share a span with strong / emphasis /
 * code, and the schema default (self-exclusion only) already allows that.
 * Narrowing it would violate precedent #9 the same way the Code widening
 * documents.
 */

import Underline from '@tiptap/extension-underline';

export const UnderlineFidelity = Underline.extend({
  priority: 60,

  addAttributes() {
    return {
      ...this.parent?.(),
      sourceForm: { default: 'u', rendered: false },
    };
  },
});
