/**
 * comment — literal authoring annotation. Dimmed in WYSIWYG, hidden on
 * cross-app clipboard paste; survives in markdown source as `%%text%%`
 * (Obsidian-style) or `<!-- text -->` (HTML comment form).
 *
 * Both source forms parse into this mark on a text run via
 * `comment-promoter.ts`. The mark renders with `data-clipboard-omit="true"`,
 * so the clipboard walker drops it from outbound payloads, and with a
 * `comment-mark` class the app styles as dimmed annotation. Source mode
 * (CodeMirror) shows the literal `%%…%%` / `<!-- … -->` bytes.
 *
 * The mark deliberately does NOT hide the run in the editing surface. The
 * promoter claims literal comment syntax wherever it appears, including
 * prose a user typed without meaning it as a comment, so hiding the run
 * makes typed text disappear from the surface it was typed into with no way
 * to recover it there.
 *
 * Published output still hides comments — the mdast→hast renderer emits them
 * as literal `<!-- … -->` HTML comments, which browsers do not display. The
 * split is editor-schema versus rendered-markdown, not editable versus
 * read-only: the app's read-only TipTap surfaces (the skill viewer, the
 * rendered diff) mount this same schema under the same stylesheet, so they
 * show comment bodies dimmed too. That is the intended reading for both —
 * a diff that silently dropped an annotation change would be lying about
 * the edit.
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
  // the priority math/highlight didn't need to set (those are atom shapes);
  // for an inline mark over ordinary text, the inside-bias produces the more
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
        // `data-clipboard-omit` makes the live-DOM clipboard walker drop the
        // subtree from outbound payloads, and `comment-scrub.ts` derives the
        // schema's omitted mark/node set by probing this very attribute — so
        // omission is carried by the attribute, not by any styling.
        'data-clipboard-omit': 'true',
        class: 'comment-mark',
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
