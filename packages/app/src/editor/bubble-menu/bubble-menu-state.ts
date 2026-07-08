/**
 * Pure editor-state predicates for the WYSIWYG bubble menu: when the bar is
 * visible, and how a ⌘K press routes while a link affordance could apply.
 *
 * Kept out of `BubbleMenuBar` so `LinkEditPopover`'s shortcut listener can
 * share the bar's exact visibility predicate without an import cycle
 * (BubbleMenuBar → LinkEditPopover → this module).
 */

import type { Editor } from '@tiptap/react';
import { findMarkIdAt } from '../extensions/mark-identity';
import { getFindReplaceState } from '../find-replace/tiptap-find-replace-extension';
import { isFileNodeSelected } from './FileBubbleButtons';
import { isImageNodeSelected } from './ImageAlignButtons';

export function shouldShowBubbleMenu({ editor }: { editor: Editor }): boolean {
  if (getFindReplaceState(editor.state).query) return false;
  if (editor.isActive('codeBlock')) return false;
  // Image / File NodeSelection — show the menu so the per-type buttons
  // (`ImageAlignButtons` / `FileBubbleButtons`) are reachable even though
  // `textBetween` is empty across a leaf atom. Bypasses the text-bearing-
  // selection guards below.
  if (isImageNodeSelected(editor)) return true;
  if (isFileNodeSelected(editor)) return true;
  if (editor.state.selection.empty) return false;
  const { from, to } = editor.state.selection;
  const text = editor.state.doc.textBetween(from, to, ' ');
  if (!text.trim()) return false;
  return true;
}

export type AddLinkShortcutAction =
  | { kind: 'open-popover' }
  | { kind: 'edit-link'; markId: string };

/** Compile-time exhaustiveness backstop for `AddLinkShortcutAction` consumers
 *  (same convention as `assertNeverLinkTarget`): a new variant fails the
 *  switch's `default` typecheck instead of silently mis-routing. */
export function assertNeverAddLinkAction(value: never): never {
  throw new Error(`Unhandled AddLinkShortcutAction variant: ${JSON.stringify(value as unknown)}`);
}

/**
 * How a ⌘K press should act on the current editor state, or null when no
 * link affordance applies and the press should fall through to the command
 * palette.
 *
 * - Collapsed caret inside an existing link → open that link's chip edit
 *   surface (id resolved from mark-identity state; null when untracked).
 * - Non-empty text selection with the bar's text branch reachable → open the
 *   link popover. Mirrors `shouldShowBubbleMenu` minus its image/file bypass
 *   so a claim never eats the keystroke while the popover is unreachable
 *   (code block, whitespace-only selection, find-replace active, media
 *   NodeSelection).
 */
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
