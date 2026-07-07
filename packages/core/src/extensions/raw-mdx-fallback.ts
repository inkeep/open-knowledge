import { Node } from '@tiptap/core';

/**
 * rawMdxFallback — block-level PM node holding raw markdown source when
 * parsing fails for a specific block region.
 *
 * Shape: content-based (`atom: false, content: 'text*'`), not atom. This
 * preserves Y.XmlElement identity under char-level edits in source mode,
 * provides finer undo granularity, and matches the jsxInline pattern.
 *
 * NodeView renders with `contenteditable: 'false'` — WYSIWYG cannot edit the
 * inner text; edits route through source mode. Visual chrome (dashed border,
 * badge, tooltip) lives in `RawMdxFallbackChrome.tsx`; this is the minimal
 * functional NodeView satisfying the structural requirements.
 */
export const RawMdxFallback = Node.create({
  name: 'rawMdxFallback',
  group: 'block',
  atom: false,
  content: 'text*',
  isolating: true,
  selectable: true,
  defining: true,
  priority: 60,

  addAttributes() {
    return {
      reason: { default: '' },
      originalSpan: { default: { start: 0, end: 0 } },
    };
  },

  parseHTML() {
    // Two parseDOM matchers (additive per precedent #9):
    //   1. `div[data-raw-mdx-fallback]` — the in-app NodeView shape.
    //   2. `pre[data-raw-mdx-fallback]` — the outbound clipboard hast shape
    //      emitted by `rawMdxFallbackHandler`. Without this, OK→OK
    //      paste round-trip cannot reconstruct the rawMdxFallback node and
    //      the bytes degrade to a generic `<pre>` (codeBlock).
    const getAttrs = (node: HTMLElement | string) => {
      if (typeof node === 'string') return false;
      return {
        reason: node.getAttribute('data-reason') || '',
      };
    };
    return [
      { tag: 'div[data-raw-mdx-fallback]', getAttrs },
      { tag: 'pre[data-raw-mdx-fallback]', getAttrs },
    ];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      'div',
      {
        'data-raw-mdx-fallback': '',
        'data-raw-badge': 'raw',
        'data-reason': HTMLAttributes.reason,
        contenteditable: 'false',
        class: 'raw-mdx-fallback',
      },
      0,
    ];
  },

  addNodeView() {
    return ({ HTMLAttributes }) => {
      const dom = document.createElement('div');
      dom.setAttribute('data-raw-mdx-fallback', '');
      dom.setAttribute('data-raw-badge', 'raw');
      dom.setAttribute('contenteditable', 'false');
      dom.classList.add('raw-mdx-fallback');

      if (HTMLAttributes.reason) {
        dom.setAttribute('data-reason', HTMLAttributes.reason);
      }

      const contentDOM = document.createElement('pre');
      contentDOM.classList.add('raw-mdx-fallback-content');
      // Defensive depth: if the wrapper's contenteditable attr is ever removed
      // or changed (CSS override, devtools, future refactor), the inner pre
      // still blocks WYSIWYG edits. contenteditable only affects user input —
      // ProseMirror's programmatic text writes are unaffected.
      contentDOM.setAttribute('contenteditable', 'false');
      dom.appendChild(contentDOM);

      return {
        dom,
        contentDOM,
        ignoreMutation: () => true,
      };
    };
  },
});
