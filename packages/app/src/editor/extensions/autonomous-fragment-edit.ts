/**
 * Which ProseMirror transactions the user is responsible for, and when a
 * NodeView is allowed to issue one they are not.
 *
 * DISPATCH GATE. An autonomous (non-user-initiated) structural fragment rewrite
 * issued from a source-mode-hidden WYSIWYG editor races Observer B's
 * per-keystroke re-derive and double-materializes the span at the
 * Y.XmlFragment CRDT level (precedent #14: Observer B is the sole fragment
 * writer during source typing). Gate every autonomous structural dispatch on
 * the editor being the visible/authoritative surface — in source mode the
 * WYSIWYG is hidden, so its structural rewrites serve no user and only create
 * the double-write race.
 *
 * Checked at DISPATCH time (not effect entry): the mode can flip between
 * scheduling a rAF/timeout and its firing, and a stale-scheduled dispatch is
 * exactly the hazard.
 *
 * ORIGIN CLASSIFICATION. `isUserIntentOrigin` is where "did the user do this?"
 * is answered, so a consumer asking it does not carry its own copy of the
 * origin taxonomy. See that function for the canonical enumeration, and
 * `markAutonomousFragmentEdit` for what the second arm is and why it exists.
 */
import type { Editor } from '@tiptap/core';
import type { Node as PmNode } from '@tiptap/pm/model';
import type { Transaction } from '@tiptap/pm/state';
import { ySyncPluginKey } from '@tiptap/y-tiptap';
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

function isAutonomousFragmentEdit(tr: Transaction): boolean {
  return tr.getMeta(AUTONOMOUS_FRAGMENT_EDIT_META) === true;
}

export function isUserIntentOrigin(tr: Transaction): boolean {
  return !tr.getMeta(ySyncPluginKey) && !isAutonomousFragmentEdit(tr);
}
