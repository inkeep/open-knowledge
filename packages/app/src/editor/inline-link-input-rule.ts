/**
 * Typed `[text](url)` input rule for the WYSIWYG editor.
 *
 * When a local user closes a well-formed inline-link literal by typing the
 * final `)`, the `[text](url)` span collapses to its display `text` carrying a
 * `link` mark. The mark keeps the schema-default `linkStyle: 'inline'`, so it
 * serializes straight back to `[text](url)` (unlike the bare-literal
 * `gfm-autolink` style the typed-URL plugin uses). Scope is deliberately narrow
 * — the one universal Markdown link shorthand editors share (Outline, Plate).
 *
 * Safety and undo, both structural:
 *
 *  - Origin safety by construction. Input rules fire only from
 *    `handleTextInput` — a local, focused DOM keystroke — never from a y-sync
 *    transaction (remote peer, agent, disk load, observer echo) or a
 *    programmatic write into a pooled/background editor. So the "never convert
 *    another writer's content" invariant holds without an explicit origin
 *    guard, unlike the appendTransaction-based typed-URL plugin.
 *  - Href policy. The URL must pass `isAllowedLinkUri` (the shared scheme
 *    allowlist); a `javascript:`-style payload leaves the literal untouched.
 *    Relative targets resolve against the placeholder base and are allowed,
 *    matching the internal-link contract.
 *  - Undo isolation, mark kept in step with the trigger. The rule does NOT
 *    consume the `)`; it lets the paren land through normal typing (so the
 *    literal is complete in the doc) and collapses in a deferred separate
 *    dispatch a microtask later, split from the typing by `stopCapturing()`
 *    before and after. One Cmd+Z then reverts just the collapse, restoring the
 *    full `[text](url)` literal — the same trigger-char-kept, one-undo contract
 *    the gfm-autolink path has. Absent a y-undo binding there is no capture
 *    stack and nothing to split.
 */

import { isAllowedLinkUri } from '@inkeep/open-knowledge-core';
import { Extension, InputRule } from '@tiptap/core';
import type { EditorView } from '@tiptap/pm/view';
import { dispatchAsOwnUndoStep } from './undo-isolation';

/** `[text](url)` ending at the caret. `text` = one+ non-`]`; `url` = one+
 *  non-`)`/non-whitespace (inline links whose URL needs spaces use `<>`, out
 *  of scope). The trailing `)` anchors the rule to the closing keystroke.
 *  `[[Page]]` wikilinks never match — they carry no `](` after the first `]`. */
const INLINE_LINK_RE = /\[([^\]]+)\]\(([^)\s]+)\)$/;

const LINK_MARK = 'link';

/**
 * Collapse `[text](url)` (already complete in the doc, including the just-typed
 * `)`) at `[from, from+len]` down to `text` carrying a link mark. Runs a
 * microtask after the paren landed, so it re-validates the span first — the doc
 * may have shifted or been rewritten in the gap.
 */
function collapseToLink(
  view: EditorView,
  from: number,
  fullMatch: string,
  text: string,
  href: string,
): void {
  if (view.isDestroyed || view.composing) return;
  const { state } = view;
  const markType = state.schema.marks[LINK_MARK];
  if (!markType) return;

  const to = from + fullMatch.length;
  if (from < 0 || to > state.doc.content.size) return;
  if (state.doc.textBetween(from, to) !== fullMatch) return;
  // Don't nest inside an existing link.
  if (state.doc.rangeHasMark(from, to, markType)) return;

  // The collapse must be its own undo stack item so one undo restores the
  // literal (see undo-isolation.ts for the split-before/close-after contract).
  // Only the dispatch is guarded — it crosses into third-party plugin hooks;
  // the guards above are internal-trusted and should fail loud.
  const linked = state.schema.text(text, [markType.create({ href })]);
  try {
    dispatchAsOwnUndoStep(view, state.tr.replaceRangeWith(from, to, linked));
  } catch (err) {
    console.warn('[inline-link-rule] collapse dispatch failed', { from, text, href }, err);
  }
}

export const InlineLinkInputRule = Extension.create({
  name: 'inlineLinkInputRule',

  addInputRules() {
    const editor = this.editor;
    return [
      new InputRule({
        find: INLINE_LINK_RE,
        // Returning null (no steps) means TipTap does not consume the match:
        // the `)` inserts through the normal path and the deferred collapse
        // below does the linkification. Code blocks and inline-code contexts
        // are already refused upstream by TipTap's input-rule runner.
        handler: ({ state, range, match }) => {
          const text = match[1];
          const url = match[2];
          if (!text || !url) return null;
          if (!isAllowedLinkUri(url)) return null;

          const markType = state.schema.marks[LINK_MARK];
          if (!markType) return null;
          if (state.doc.rangeHasMark(range.from, range.to, markType)) return null;

          // range.from is the start of `[` in the pre-paren doc; positions
          // before the caret are stable across the paren insertion, so the
          // completed literal will span [range.from, range.from + match[0].length].
          const from = range.from;
          const fullMatch = match[0];
          // Capture the view eagerly: input rules fire from handleTextInput
          // (the view is mounted here), while `editor.view` re-read inside the
          // microtask is a throwing proxy if a recycle starts in the gap.
          // collapseToLink's isDestroyed guard covers teardown after capture.
          const view = editor.view;
          queueMicrotask(() => collapseToLink(view, from, fullMatch, text, url));
          return null;
        },
      }),
    ];
  },
});
