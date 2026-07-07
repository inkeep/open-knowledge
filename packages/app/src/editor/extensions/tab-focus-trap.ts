/**
 * TabFocusTrap — keep `Tab` / `Shift-Tab` inside the editor when no higher-
 * priority extension has consumed them.
 *
 * Without this extension, the chain of `addKeyboardShortcuts` handlers all
 * return `false` for a `Tab` press inside a plain paragraph (the `ListItem`
 * handler in `packages/core/src/extensions/list.ts` only fires when the
 * cursor is inside a `listItem`; the table extension only fires when inside
 * a cell). ProseMirror then lets the browser run its default action — moving
 * keyboard focus to the next tabbable element outside the editor (chrome
 * bar's Share / settings buttons, the page sidebar, etc.). When the editor
 * is focused, nothing outside it should hijack `Tab`.
 *
 * Keyboard exit (WCAG 2.1.2 "No Keyboard Trap", Level A): paired with the
 * `KeyboardNav` extension's Escape handler — Esc selects the parent node;
 * Esc again on a top-level NodeSelection blurs the editor and releases
 * focus to the next tabbable element outside it. Mirrors Notion /
 * Confluence and the sibling CodeMirror SourceEditor's escape contract.
 *
 * Priority is set to `1` (well below stock TipTap defaults of 100 and the
 * fidelity overrides at 60) so this extension runs LAST in the keymap
 * chain. The intentional handlers — `ListItem` (sink/lift), `Table` (next
 * cell), suggestion plugins (`slash-command` / `wiki-link-suggestion` /
 * `tag-suggestion`, which intercept via `handleKeyDown` ProseMirror plugin
 * paths at higher precedence than `addKeyboardShortcuts`) — all get first
 * crack. We catch only the fall-through.
 *
 * What "trap" does: `return true` from the handler so Tiptap calls
 * `preventDefault` on the underlying event. No edit, no selection change —
 * cursor stays put, focus stays in the editor. Intentionally NOT inserting
 * a literal tab character (markdown semantics would treat `\t` ambiguously
 * and most rich-text editors don't insert literal tabs in body prose) and
 * NOT auto-converting paragraphs to list items (would silently rewrite the
 * user's block type; the user picked paragraph for a reason).
 *
 * Shift-Tab is trapped symmetrically — without it, Shift-Tab in plain text
 * falls through to browser-default reverse focus traversal, the same
 * disruption in the other direction.
 */

import { Extension } from '@tiptap/core';

export const TabFocusTrap = Extension.create({
  name: 'tabFocusTrap',
  priority: 1,

  addKeyboardShortcuts() {
    return {
      Tab: () => true,
      'Shift-Tab': () => true,
    };
  },
});
