/**
 * Gates autonomous structural fragment dispatches on the editor being the visible surface:
 * Observer B is the sole fragment writer during source typing (precedent #14), so a
 * source-mode-hidden WYSIWYG rewrite double-materializes the span at the CRDT level.
 */
import type { Editor } from '@tiptap/core';
import type { Node as PmNode } from '@tiptap/pm/model';
import type { Transaction } from '@tiptap/pm/state';
import { getEditorSourceMode } from './editor-mode-context.ts';

export function autonomousFragmentEditAllowed(editor: Editor): boolean {
  return !getEditorSourceMode(editor);
}

const AUTONOMOUS_FRAGMENT_EDIT_META = 'autonomousFragmentEdit/swap';

export function markAutonomousFragmentEdit(tr: Transaction): Transaction {
  return tr.setMeta(AUTONOMOUS_FRAGMENT_EDIT_META, true);
}

export function markSwapIfByteNeutral(
  tr: Transaction,
  replaced: PmNode,
  nextSource: string,
): Transaction {
  return nextSource === replaced.textContent ? markAutonomousFragmentEdit(tr) : tr;
}

export const PROJECTION_REMOTE_APPLY_META = 'okProjectionRemoteApply';

function isAutonomousFragmentEdit(tr: Transaction): boolean {
  return tr.getMeta(AUTONOMOUS_FRAGMENT_EDIT_META) === true;
}

/* STOP: the projection re-derives the whole document on a remote change, so a peer's edit
   arrives as an ordinary local-looking transaction. Without the remote-apply clause every
   consumer of this predicate reads a remote edit as something the user did. The clause is set by
   cause, not by mechanism: a re-derive that follows the user's own keystroke
   (a declined splice) is still the user's intent and must stay true, which is what the fragment
   binding did on main. */
export function isUserIntentOrigin(tr: Transaction): boolean {
  if (tr.getMeta(PROJECTION_REMOTE_APPLY_META) === true) return false;
  return !isAutonomousFragmentEdit(tr);
}
