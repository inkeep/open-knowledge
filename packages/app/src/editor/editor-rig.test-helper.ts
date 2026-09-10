import { LinkFidelity, MarkdownManager } from '@inkeep/open-knowledge-core';
import { Editor, type Extensions, isiOS, isMacOS } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import * as Y from 'yjs';
import { sharedExtensions } from './extensions/shared';
import { createProjectionBinding } from './projection-binding';

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

export function mountAppEditor(): Editor {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const editor = new Editor({ element: host, extensions: sharedExtensions, editable: true });
  editor.view.focus();
  return editor;
}

const projectionMd = new MarkdownManager({
  extensions: sharedExtensions,
  deriveStructuralFreshness: true,
});

export interface ProjectionEditorRig {
  editor: Editor;
  ydoc: Y.Doc;
  ytext: Y.Text;
  undoManager: Y.UndoManager;
  destroy(): void;
}

export function mountProjectionEditor(source: string, extensions: Extensions): ProjectionEditorRig {
  const ydoc = new Y.Doc();
  const ytext = ydoc.getText('source');
  ydoc.transact(() => ytext.insert(0, source), 'seed');
  return mountProjectionEditorOn(ytext, extensions, () => {
    ydoc.destroy();
  });
}

export function mountProjectionEditorOn(
  ytext: Y.Text,
  extensions: Extensions,
  onDestroy?: () => void,
): ProjectionEditorRig {
  const ydoc = ytext.doc;
  if (ydoc === null) throw new Error('mountProjectionEditorOn: the Y.Text has no document');

  const host = document.createElement('div');
  document.body.appendChild(host);
  const binding = createProjectionBinding({ ytext, md: projectionMd });
  const overridden = new Set(extensions.map((ext) => ext.name));
  const editor = new Editor({
    element: host,
    content: binding.content,
    extensions: [
      ...sharedExtensions.filter((ext) => !overridden.has(ext.name)),
      binding.extension,
      ...extensions,
    ],
  });
  return {
    editor,
    ydoc,
    ytext,
    undoManager: binding.undoManager,
    destroy() {
      editor.destroy();
      host.remove();
      onDestroy?.();
    },
  };
}

export function insertLocal(editor: Editor, text: string, at: number): void {
  editor.view.dispatch(editor.state.tr.insertText(text, at, at));
}

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

export function pressEditorKey(
  editor: Editor,
  shortcut: string,
): { handled: boolean; docMoved: boolean } {
  const before = editor.state.doc;
  const event = shortcutToKeydownEvent(shortcut);
  editor.view.dom.dispatchEvent(event);
  return { handled: event.defaultPrevented, docMoved: editor.state.doc !== before };
}

export function linkHrefs(editor: Editor): string[] {
  const hrefs = new Set<string>();
  editor.state.doc.descendants((node) => {
    for (const m of node.marks) {
      if (m.type.name === 'link' && typeof m.attrs.href === 'string') hrefs.add(m.attrs.href);
    }
  });
  return [...hrefs];
}
