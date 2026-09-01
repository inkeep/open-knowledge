import type { Editor } from '@tiptap/core';
import { createInteractionLayer, type InteractionLayerHandle } from './interaction-layer';

const layers = new WeakMap<Editor, InteractionLayerHandle>();

export function getInteractionLayer(editor: Editor): InteractionLayerHandle {
  const existing = layers.get(editor);
  if (existing) return existing;

  const handle = createInteractionLayer({
    editor: editor as unknown as Parameters<typeof createInteractionLayer>[0]['editor'],
  });
  layers.set(editor, handle);

  editor.on('destroy', () => {
    handle.destroy();
    layers.delete(editor);
  });

  return handle;
}

export function __hasInteractionLayerForTests(editor: Editor): boolean {
  return layers.has(editor);
}
