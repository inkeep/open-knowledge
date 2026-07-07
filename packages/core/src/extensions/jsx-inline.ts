import { Node } from '@tiptap/core';

/**
 * jsxInline — thin inline PM node for MDX inline JSX.
 *
 * Inline JSX renders as visible source text in WYSIWYG — no live
 * React render, no PropPanel, no descriptor dispatch, no chrome. The node
 * exists only to preserve `<` and `>` characters through the markdown
 * serializer without escape (mdast-util-to-markdown would otherwise escape
 * `<word` patterns per CommonMark safety).
 *
 * Shape: atom:false, content:'text*', isolating:false, selectable:true.
 * Zero attrs — the text content IS the source. No NodeView, no
 * contentEditable:false, no sourceDirty, no sourceRaw attr.
 *
 * content:'text*' per
 * Precedent #10 preserves Y.Item identity on per-keystroke text mutation.
 *
 * See Precedent #10.
 */
export const JsxInline = Node.create({
  name: 'jsxInline',
  group: 'inline',
  inline: true,
  atom: false,
  content: 'text*',
  isolating: false,
  selectable: true,
  priority: 60,

  addAttributes() {
    return {};
  },

  parseHTML() {
    return [{ tag: 'span[data-jsx-inline]' }];
  },

  renderHTML() {
    return ['span', { 'data-jsx-inline': '' }, 0];
  },
});
