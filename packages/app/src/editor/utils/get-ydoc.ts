import type { Editor } from '@tiptap/core';
import type { Doc } from 'yjs';
import {
  PROJECTION_BINDING_EXTENSION,
  type ProjectionBindingExtensionOptions,
} from '../projection-binding';

/* STOP: resolve the document through the binding extension that is actually mounted. This read
   used to name the deleted `collaboration` extension, and `find` answering `undefined` is
   indistinguishable from "no document" at every call site -- one silently made a toolbar button a
   no-op, the other dropped the agent flash out of a conditional spread. Neither threw, neither
   failed typecheck, and no importer sweep could see it. If this extension is ever renamed,
   `PROJECTION_BINDING_EXTENSION` is the single place that must move with it. */
export function getYDoc(editor: Editor): Doc | undefined {
  if (editor.isDestroyed) return undefined;
  const binding = editor.extensionManager.extensions.find(
    (e) => e.name === PROJECTION_BINDING_EXTENSION,
  );
  const options = binding?.options as ProjectionBindingExtensionOptions | undefined;
  return options?.ytext?.doc ?? undefined;
}
