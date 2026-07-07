/**
 * commentBlock — multi-line literal authoring annotation. Hidden in
 * WYSIWYG, hidden on cross-app clipboard paste; survives in markdown
 * source as `%%\n…\n%%` (Obsidian-style block) or `<!-- … -->` (HTML
 * comment, possibly multi-line). Rendered with `display: none` +
 * `data-clipboard-omit="true"` so authors edit it in source mode.
 *
 * Sister to the inline `comment` PM mark (`comment-mark.ts`); the two
 * cover the full hidden-content surface:
 *   - `%%text%%` mid-paragraph             → `comment` mark on text
 *   - `<!-- text -->` mid-paragraph        → `comment` mark on text
 *   - `%%\n...\n%%` standalone block       → `commentBlock` node
 *   - `<!-- ... -->` standalone block      → `commentBlock` node
 *
 * Schema: `group: 'block'`, `content: 'block+'` so the body can hold any
 * nested block-level markdown — paragraphs, lists, headings, etc.
 * Authors who put a heading inside a comment block see the heading
 * preserved on round-trip.
 *
 * Round-trip via `to-markdown-handlers.ts`'s `commentBlock` handler:
 * each source form preserves on save. The PM node carries a
 * `sourceForm` attribute (`'percent' | 'html'`, default `'percent'`)
 * threaded through `index.ts`'s mdast↔PM bridge handlers.
 *
 * `'percent'` form emits `%%\n\n${inner}\n\n%%` (blank-line padded;
 * padding is load-bearing — without it, mdast-util-to-markdown's
 * list-continuation logic adopts the trailing `%%` as a list-item
 * continuation when the body holds a list, indenting the closer and
 * breaking re-parse).
 *
 * `'html'` form emits `<!-- inner -->` for single-paragraph bodies and
 * falls back to the `%%` form when the body holds multiple block-level
 * children — CommonMark HTML comments are single opaque-text bodies
 * and can't represent block structure.
 */

import { Node } from '@tiptap/core';

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    commentBlock: {
      /** Wrap the current selection in a comment block. */
      setCommentBlock: () => ReturnType;
      /** Toggle comment-block wrapping for the current selection. */
      toggleCommentBlock: () => ReturnType;
      /** Lift the current selection out of its surrounding comment block. */
      unsetCommentBlock: () => ReturnType;
    };
  }
}

export const CommentBlock = Node.create({
  name: 'commentBlock',
  group: 'block',
  content: 'block+',
  // Defining: PM treats this as a structural container, not a leaf.
  defining: true,
  // Priority above paragraph so paste-into-empty-doc lands as the
  // expected node when an OK→OK round-trip carries the marker.
  priority: 60,

  addAttributes() {
    return {
      // `'percent'` (canonical `%%\n\n…\n\n%%`) or `'html'`
      // (`<!-- … -->`). Threaded by `index.ts`'s forward / reverse
      // mdast↔PM bridge so the original source form survives a
      // round-trip through PM. Multi-block bodies always serialize as
      // `'percent'` regardless of attribute (the to-markdown handler
      // falls back automatically — CommonMark HTML comments are
      // single-text bodies and can't represent block structure).
      sourceForm: {
        default: 'percent',
        parseHTML: (element: HTMLElement) =>
          element.getAttribute('data-source-form') === 'html' ? 'html' : 'percent',
        renderHTML: (attrs: { sourceForm?: string }) =>
          attrs.sourceForm === 'html' ? { 'data-source-form': 'html' } : {},
      },
      // `'inline'` (single-line `%% body %%` / `<!-- body -->`) or
      // `'block'` (`%%\n\n…\n\n%%`). Pairs with `sourceForm` to
      // discriminate the three authoring shapes that produce a
      // commentBlock — `%%`-inline, `%%`-block,
      // and HTML inline (HTML has no block-fence form in
      // CommonMark). Default `'block'` matches the canonical
      // multi-line form authors create via `%%\n\n…\n\n%%`. The inline
      // forms all set `'inline'` so the single-line shape round-
      // trips byte-stable (precedent #38).
      sourceLayout: {
        default: 'block',
        parseHTML: (element: HTMLElement) =>
          element.getAttribute('data-source-layout') === 'inline' ? 'inline' : 'block',
        renderHTML: (attrs: { sourceLayout?: string }) =>
          attrs.sourceLayout === 'inline' ? { 'data-source-layout': 'inline' } : {},
      },
    };
  },

  parseHTML() {
    return [{ tag: 'aside[data-comment-block]' }, { tag: 'aside.comment-block' }];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      'aside',
      {
        'data-comment-block': '',
        // Hidden in WYSIWYG via inline `display: none` (no app-side CSS
        // dependency). Inline style is decisive across cross-app
        // destination CSS. `data-clipboard-omit` makes the live-DOM
        // walker drop the subtree from outbound payloads.
        'data-clipboard-omit': 'true',
        class: 'comment-block',
        style: 'display: none;',
        ...HTMLAttributes,
      },
      0,
    ];
  },

  addCommands() {
    return {
      setCommentBlock:
        () =>
        ({ commands }) =>
          commands.wrapIn(this.name),
      toggleCommentBlock:
        () =>
        ({ commands }) =>
          commands.toggleWrap(this.name),
      unsetCommentBlock:
        () =>
        ({ commands }) =>
          commands.lift(this.name),
    };
  },
});
