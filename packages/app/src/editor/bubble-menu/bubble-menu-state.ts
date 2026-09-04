import { commentQuoteText } from '@inkeep/open-knowledge-core';
import type { Editor } from '@tiptap/react';
import { findMarkIdAt } from '../extensions/mark-identity';
import { getFindReplaceState } from '../find-replace/tiptap-find-replace-extension';
import { isFileNodeSelected } from './FileBubbleButtons';
import { isImageNodeSelected } from './ImageAlignButtons';

export function shouldShowBubbleMenu({ editor }: { editor: Editor }): boolean {
  if (getFindReplaceState(editor.state).query) return false;
  if (editor.isActive('codeBlock')) return false;
  if (isImageNodeSelected(editor)) return true;
  if (isFileNodeSelected(editor)) return true;
  if (editor.state.selection.empty) return false;
  const { from, to } = editor.state.selection;
  const text = commentQuoteText(editor.state.doc, from, to, ' ', { inlineOnly: true });
  if (!text.trim()) return false;
  return true;
}

export type AddLinkShortcutAction =
  | { kind: 'open-popover' }
  | { kind: 'edit-link'; markId: string };

export function assertNeverAddLinkAction(value: never): never {
  throw new Error(`Unhandled AddLinkShortcutAction variant: ${JSON.stringify(value as unknown)}`);
}

export function resolveAddLinkShortcutAction(editor: Editor): AddLinkShortcutAction | null {
  const { selection } = editor.state;
  if (selection.empty) {
    if (!editor.isActive('link')) return null;
    const markId = findMarkIdAt(editor.state, selection.from, 'link');
    return markId === null ? null : { kind: 'edit-link', markId };
  }
  if (!shouldShowBubbleMenu({ editor })) return null;
  if (isImageNodeSelected(editor) || isFileNodeSelected(editor)) return null;
  return { kind: 'open-popover' };
}
