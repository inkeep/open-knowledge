/**
 * Per-editor InteractionLayer singleton host.
 *
 * Shared by all chip extensions (internal-link, wiki-link, raw-mdx-fallback,
 * jsx-component). The first extension to `addProseMirrorPlugins()` for a given
 * Editor creates the layer; subsequent extensions reuse the same handle from
 * the module-level WeakMap.
 *
 * The layer's lifetime is bound to the Editor: `editor.on('destroy', ...)`
 * fires `handle.destroy()` and removes the WeakMap entry. The WeakMap itself
 * is GC-safe — if an Editor becomes unreachable without firing destroy (test
 * environments, abnormal teardown), the entry is collected automatically.
 *
 */

import type { Editor } from '@tiptap/core';
import { createInteractionLayer, type InteractionLayerHandle } from './interaction-layer';

const layers = new WeakMap<Editor, InteractionLayerHandle>();

/**
 * Return the singleton InteractionLayerHandle for this editor, creating it
 * on first access. Subsequent calls return the same handle.
 *
 * The handle is destroyed (listeners detached, React subtree unmounted) when
 * the editor fires its `'destroy'` event.
 */
export function getInteractionLayer(editor: Editor): InteractionLayerHandle {
  const existing = layers.get(editor);
  if (existing) return existing;

  // TipTap's `editorView` is a private field of `Editor` but the
  // InteractionLayerEditor interface accepts duck-typed access. Reading it
  // (for the non-throwing proxy check) is safe provided the access is typed
  // as unknown-cast, which it is here.
  const handle = createInteractionLayer({
    editor: editor as unknown as Parameters<typeof createInteractionLayer>[0]['editor'],
  });
  layers.set(editor, handle);

  // Editor destroy → drop the handle. `editor.off('destroy', ...)` isn't
  // needed: the editor is being destroyed, so the handler is cleaned up
  // along with the editor itself.
  editor.on('destroy', () => {
    handle.destroy();
    layers.delete(editor);
  });

  return handle;
}

/**
 * Test-only accessor. Returns the current WeakMap size is not possible
 * (WeakMap is not enumerable), but we can probe whether a specific Editor
 * has a registered layer. Used by unit tests to verify idempotence.
 */
export function __hasInteractionLayerForTests(editor: Editor): boolean {
  return layers.has(editor);
}
