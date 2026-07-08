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
import { Editor, type Extensions } from '@tiptap/core';
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
