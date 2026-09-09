/**
 * Gates autonomous structural fragment dispatches on the editor being the visible surface:
 * Observer B is the sole fragment writer during source typing (precedent #14), so a
 * source-mode-hidden WYSIWYG rewrite double-materializes the span at the CRDT level.
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
