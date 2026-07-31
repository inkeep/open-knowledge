/**
 * Shared headless-editor rigs for app editor-plugin tests.
 *
 * Real ProseMirror EditorViews over jsdom globals (callers own the
 * `installDomGlobals` lifecycle from the walk-currency harness), with the
 * schema base every link-behavior test agrees on: StarterKit minus its bundled
 * Link so the real fidelity mark (which carries `linkStyle`) is the only
 * `link` in the schema, and that mark's stock autolink disabled so the plugin
 * under test is the sole converter. Callers pass just the extension(s) under
 * test.
 */

import { LinkFidelity } from '@inkeep/open-knowledge-core';
import { Editor, type Extensions, isiOS, isMacOS } from '@tiptap/core';
import Collaboration from '@tiptap/extension-collaboration';
import StarterKit from '@tiptap/starter-kit';
import { yUndoPluginKey } from '@tiptap/y-tiptap';
import type * as Y from 'yjs';

export function mountLightEditor(options: { content?: string; extensions: Extensions }): Editor {
  const host = document.createElement('div');
  document.body.appendChild(host);
  return new Editor({
    element: host,
    content: options.content ?? '<p></p>',
    extensions: [
      StarterKit.configure({ link: false }),
      LinkFidelity.configure({ autolink: false }),
      ...options.extensions,
    ],
  });
}

/**
 * A `Collaboration`-bound editor over `ydoc` — real y-sync binding, real
 * y-undo manager. Collaboration owns history, so StarterKit's own undo/redo is
 * dropped to avoid two history stacks.
 */
export function mountCollabEditor(ydoc: Y.Doc, extensions: Extensions): Editor {
  const host = document.createElement('div');
  document.body.appendChild(host);
  return new Editor({
    element: host,
    extensions: [
      StarterKit.configure({ link: false, undoRedo: false }),
      LinkFidelity.configure({ autolink: false }),
      Collaboration.configure({ document: ydoc }),
      ...extensions,
    ],
  });
}

/** Dispatch a local (non-sync) text insertion at an explicit position. */
export function insertLocal(editor: Editor, text: string, at: number): void {
  editor.view.dispatch(editor.state.tr.insertText(text, at, at));
}

/** The bound y-undo manager, or null when the editor has no Collaboration. */
export function readUndoManager(editor: Editor): Y.UndoManager | null {
  const pluginState: { undoManager?: Y.UndoManager } | undefined = yUndoPluginKey.getState(
    editor.state,
  );
  return pluginState?.undoManager ?? null;
}

/** The href of the first link mark in document order, or null if none. */
export function firstLinkHref(editor: Editor): string | null {
  let href: string | null = null;
  editor.state.doc.descendants((node) => {
    if (href !== null) return false;
    const link = node.marks.find((m) => m.type.name === 'link');
    if (link && typeof link.attrs.href === 'string') href = link.attrs.href;
    return undefined;
  });
  return href;
}

/** Attrs of the first link mark, or null. */
export function firstLinkAttrs(editor: Editor): Record<string, unknown> | null {
  let attrs: Record<string, unknown> | null = null;
  editor.state.doc.descendants((node) => {
    if (attrs !== null) return false;
    const link = node.marks.find((m) => m.type.name === 'link');
    if (link) attrs = link.attrs;
    return undefined;
  });
  return attrs;
}

/**
 * Resolve a TipTap shortcut string to the physical chord its keymap bindings
 * were normalized against, then build the `keydown` event for that chord. Kept
 * in step with TipTap's own `keyboardShortcut` normalization, including its
 * `Mod` -> Meta/Ctrl platform split, so a binding registered as 'Mod-u'
 * receives the same event here as it does in the product.
 */
function shortcutToKeydownEvent(shortcut: string): KeyboardEvent {
  const parts = shortcut.split(/-(?!$)/);
  let result = parts[parts.length - 1];
  if (result === 'Space') result = ' ';

  let alt = false;
  let ctrl = false;
  let shift = false;
  let meta = false;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const mod = parts[i];
    if (/^(cmd|meta|m)$/i.test(mod)) meta = true;
    else if (/^a(lt)?$/i.test(mod)) alt = true;
    else if (/^(c|ctrl|control)$/i.test(mod)) ctrl = true;
    else if (/^s(hift)?$/i.test(mod)) shift = true;
    else if (/^mod$/i.test(mod)) {
      if (isiOS() || isMacOS()) meta = true;
      else ctrl = true;
    } else throw new Error(`Unrecognized modifier name: ${mod}`);
  }

  return new KeyboardEvent('keydown', {
    key: result,
    altKey: alt,
    ctrlKey: ctrl,
    metaKey: meta,
    shiftKey: shift,
    bubbles: true,
    cancelable: true,
  });
}

/**
 * Press a key on a mounted editor by dispatching a real `keydown` at the
 * ProseMirror DOM, so the whole keymap chain runs the way it does for a user.
 *
 * Two hazards this exists to close:
 *
 * 1. `editor.commands.keyboardShortcut(name)` does not press a key. It captures
 *    the transaction the keymap produced, then re-applies only that
 *    transaction's `steps`, remapped through a mapping that has already
 *    accumulated them. Selection, stored marks and every `setMeta` are dropped,
 *    a multi-step transaction lands at shifted positions, and the command
 *    returns `true` whether or not anything handled the key.
 * 2. "The document changed" is not "the key was handled". A key that only moves
 *    the selection is handled and leaves the document identical, so a single
 *    boolean collapses those two outcomes into one. Both are reported here so a
 *    caller has to say which one it means.
 *
 * Focus is a third hazard and stays the caller's job, because it belongs at
 * mount rather than at each key: `editor.commands.focus()` defers the real DOM
 * focus into a `requestAnimationFrame`, so a synchronous read after it sees an
 * unfocused view and any plugin gated on `view.hasFocus()` stays dormant. Call
 * `editor.view.focus()` instead. The Playwright-tier write-up of the same trap,
 * including why `view.focus()` beats `view.dom.focus()`, is in
 * `packages/app/tests/stress/_helpers/editor-state.ts`.
 */
export function pressEditorKey(
  editor: Editor,
  shortcut: string,
): { handled: boolean; docMoved: boolean } {
  const before = editor.state.doc;
  const event = shortcutToKeydownEvent(shortcut);
  editor.view.dom.dispatchEvent(event);
  return { handled: event.defaultPrevented, docMoved: editor.state.doc !== before };
}

/** Distinct hrefs carried by link marks anywhere in the doc. */
export function linkHrefs(editor: Editor): string[] {
  const hrefs = new Set<string>();
  editor.state.doc.descendants((node) => {
    for (const m of node.marks) {
      if (m.type.name === 'link' && typeof m.attrs.href === 'string') hrefs.add(m.attrs.href);
    }
  });
  return [...hrefs];
}
