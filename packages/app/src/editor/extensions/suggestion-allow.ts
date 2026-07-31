import type { Editor, Range } from '@tiptap/core';
import type { EditorState } from '@tiptap/pm/state';
import { isInLiteralTextContext } from '../literal-text-context';
import { getEditorSourceMode } from './editor-mode-context';

/**
 * The one `allow` predicate every `@tiptap/suggestion` picker in the document
 * editor uses (slash `/`, wiki-link `[[`, tag `#`).
 *
 * Two refusals, both evaluated inside `@tiptap/suggestion`'s `apply()` reducer
 * so `state.active` never flips and `onStart` never mounts a popup:
 *
 * - **Source mode.** The bridge still propagates the trigger keystroke into the
 *   CSS-hidden WYSIWYG editor; without this the picker would mount into
 *   `document.body`, outside the `.ok-mode-hidden` gate every other floating
 *   surface honors. Signal lives in `editor-mode-context.ts`.
 * - **Literal-text context.** A fence, an inline code span, or a raw-MDX-source
 *   node is text the editor must not convert. Committing an item there is
 *   byte-destroying, not merely re-shaping: the picker deletes the trigger
 *   range, so the typed query disappears out of the fence and the chip lands
 *   after it, and a slash command replaces the entire code block (fence, info
 *   string and all). Inside `jsxInline` it does not even need typing — the `/`
 *   already in `<Icon />` is itself a valid trigger, so parking the caret
 *   before the `>` arms a menu whose commit deletes that `/` out of the source.
 *
 * The predicate is shared rather than copied because a per-plugin copy is how
 * the literal-text clause came to be missing from all three at once. A new
 * picker gets both gates by construction; a new gate axis lands in one place.
 */
export function suggestionAllow({
  editor,
  state,
  range,
}: {
  editor: Editor;
  state: EditorState;
  range: Range;
}): boolean {
  if (getEditorSourceMode(editor)) return false;
  return !isInLiteralTextContext(state, range.from, range.to);
}
