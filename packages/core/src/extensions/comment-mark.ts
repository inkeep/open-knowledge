/**
 * comment — literal authoring annotation. Hidden in WYSIWYG, hidden on
 * cross-app clipboard paste; survives in markdown source as `%%text%%`
 * (Obsidian-style) or `<!-- text -->` (HTML comment form).
 *
 * Both source forms parse into this mark on a text run via
 * `comment-promoter.ts`. The mark renders with `style="display: none"`
 * + `data-clipboard-omit="true"`, so authors who write a comment can't
 * see it in WYSIWYG and the clipboard walker drops it from outbound
 * payloads. Source mode (CodeMirror) shows the literal `%%…%%` /
 * `<!-- … -->` bytes — that's where authors create and edit comments.
 *
 * Round-trip via `to-markdown-handlers.ts`'s `comment` handler: each
 * source form preserves on save. The PM mark carries a `sourceForm`
 * attribute (`'percent' | 'html'`, default `'percent'`) threaded
 * through `index.ts`'s mdast↔PM bridge handlers. This avoids a
 * round-trip data-loss bug specific to HTML comments whose body
 * contains literal `%%`: canonicalising to `%%body%%` produces
 * invalid byte sequences because the inline `%%` walker re-claims
 * part of the span on re-parse, splitting one comment into two and
 * leaving leftover prose.
 *
 * Coexists with bold / italic / strike / code / highlight (`excludes: ''`).
 * Inclusive=false to mirror the convention used by `escapeMark` and
 * `sourceLiteral` — the mark doesn't extend into trailing typed input.
 *
 * Schema name `comment` is unique in the workspace (no prior PM mark with
 * this name; no upstream TipTap collision). Style hooks key off
 * `data-comment-mark` so app/docs CSS layers can swap the visual treatment
 * without touching the mark schema.
 */

import { Mark } from '@tiptap/core';

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    comment: {
      /** Set the comment mark on the selection (or as a stored mark). */
      setComment: () => ReturnType;
      /** Toggle the comment mark on the selection (or stored mark). */
      toggleComment: () => ReturnType;
      /** Remove the comment mark from the selection. */
      unsetComment: () => ReturnType;
    };
  }
}

export const CommentMark = Mark.create({
  name: 'comment',
  // Lower priority than structural marks (strong, emphasis) so the comment
  // composes inside them rather than the other way round on parse. Matches
  // the priority math/highlight didn't need to set (those are atom/visible
  // shapes); for the hidden-text mark, the inside-bias produces the more
  // intuitive nesting on rich-text edits.
  priority: 10,
  excludes: '',
  inclusive: false,

  addAttributes() {
    return {
      // `'percent'` (canonical Obsidian `%%text%%`) or `'html'`
      // (`<!-- text -->`). Threaded by `index.ts`'s forward / reverse
      // mdast↔PM bridge so the original source form survives a
      // round-trip through PM. Marks created via the editor (no slash
      // command exists today; in case one is ever added) default to
      // 'percent'. The attribute is rendered as `data-source-form`
      // only when it differs from the default — keeps the rendered
      // HTML quiet for the dominant `%%` case.
      sourceForm: {
        default: 'percent',
        parseHTML: (element: HTMLElement) =>
          element.getAttribute('data-source-form') === 'html' ? 'html' : 'percent',
        renderHTML: (attrs: { sourceForm?: string }) =>
          attrs.sourceForm === 'html' ? { 'data-source-form': 'html' } : {},
      },
    };
  },

  parseHTML() {
    return [{ tag: 'span[data-comment-mark]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      'span',
      {
        'data-comment-mark': '',
        // Hidden in WYSIWYG via inline `display: none` (no app-side CSS
        // dependency). Inline style is decisive — it wins regardless of
        // any cross-app destination CSS that might try to override the
        // class. `data-clipboard-omit` makes the live-DOM clipboard walker
        // drop the subtree from outbound payloads (no marker class
        // appears in cross-app paste).
        'data-clipboard-omit': 'true',
        class: 'comment-mark',
        style: 'display: none;',
        ...HTMLAttributes,
      },
      0,
    ];
  },

  addCommands() {
    return {
      setComment:
        () =>
        ({ commands }) =>
          commands.setMark(this.name),
      toggleComment:
        () =>
        ({ commands }) =>
          commands.toggleMark(this.name),
      unsetComment:
        () =>
        ({ commands }) =>
          commands.unsetMark(this.name),
    };
  },
});
