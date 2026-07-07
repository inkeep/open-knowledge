/**
 * Per-editor docName registry — keyed on the TipTap Editor instance via
 * WeakMap so a dropped/closed editor automatically evicts its entry.
 *
 * Why not a module-level `currentDocName` singleton (the shape this
 * replaced): `EditorActivityPool` mounts up to `ACTIVITY_MOUNT_LIMIT`
 * = 3 editors concurrently, and Activity-hidden editors don't unmount.
 * A module-level singleton reflects whichever mount effect ran most
 * recently in React's reconciliation — not the user-active editor.
 * Dropping a file into the visible editor could resolve `parentDocName`
 * to a hidden doc and land the asset in the wrong directory, producing
 * refs-to-the-wrong-place storage corruption that survives reload.
 *
 * Why not TipTap extension storage (`this.storage.docName = docName`):
 * React Compiler (enabled in this repo) flags mutations on
 * values returned from hooks, and `editor.storage` is derived from the
 * `useEditor()` hook return value. The WeakMap sits outside the hook
 * contract — `setEditorDocName` writes to a module-level map, not to
 * the `editor` object itself, so the compiler sees no mutation through
 * the hook.
 */
import type { Editor } from '@tiptap/core';

const editorDocName = new WeakMap<Editor, string>();

export function setEditorDocName(editor: Editor, docName: string | null): void {
  if (docName === null) {
    editorDocName.delete(editor);
    return;
  }
  editorDocName.set(editor, docName);
}

export function getEditorDocName(editor: Editor): string | null {
  return editorDocName.get(editor) ?? null;
}
