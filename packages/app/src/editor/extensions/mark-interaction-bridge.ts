/**
 * mark-interaction-bridge — wires markIdentityPlugin's register/deregister
 * lifecycle to an InteractionLayerHandle so mark chip extensions
 * (InternalLink) can route per-mark interactions through the shared editor-root
 * React plane.
 *
 * Sits between two already-shipped primitives:
 *   - `markIdentityPlugin` assigns stable IDs to PM marks and fires
 *     register/deregister callbacks on mark lifecycle via its view update.
 *   - `InteractionLayer` hosts the singleton PropPanel/Toolbar/
 *     Breadcrumb subtree at editor root, routed by active nodeId.
 *
 * Concentrates three subtle correctness points that every mark chip extension
 * would otherwise re-solve:
 *
 *   1. **Live position lookup** — a mark's `from`/`to` captured at register
 *      time goes stale as the user edits. `getCurrentMarkInfo(state, id)`
 *      resolves the latest MarkInfo from the identity plugin's state on
 *      demand, so PropPanel renderers never operate on stale positions.
 *
 *   2. **Context bridging** — the layer's `InteractionContext` exposes only
 *      `{ nodeId, type, deactivate }`. Mark chip renderers typically want
 *      `{ editor, nodeId, deactivate }` so they can reach back into the
 *      editor for commands / state. The bridge augments the context for
 *      `renderPropPanel` without forcing the layer to know about editors.
 *
 *   3. **Deregister ordering** — onDeregister fires synchronously from the
 *      plugin's view update after a transaction. The bridge calls
 *      `layer.deregister(id)` inline so the singleton PropPanel (if active)
 *      unmounts before the next render.
 *
 * Consumer pattern (targeted by `internal-link.ts` port):
 *
 *     addProseMirrorPlugins() {
 *       return [
 *         createMarkInteractionBridgePlugin({
 *           editor: this.editor,
 *           markTypes: ['link'],
 *           renderPropPanel: ({ editor, nodeId, deactivate }) => (
 *             <InternalLinkPropPanel
 *               editor={editor}
 *               nodeId={nodeId}
 *               onClose={deactivate}
 *             />
 *           ),
 *         }),
 *         markIdentityDecorationPlugin(),
 *       ];
 *     }
 *
 * The PropPanel component reads live MarkInfo via `getCurrentMarkInfo(editor.state, nodeId)`.
 *
 * No consumers wired in this module today — ships as scope-reduction:
 * concentrates the wiring pattern + correctness handling
 * in one tested place so the eventual atomic refactor is smaller.
 *
 * Precedent #9 (add-only schema) is preserved — all identity lives in
 * PluginState, never in mark attrs.
 */

import type { Editor } from '@tiptap/core';
import type { Mark } from '@tiptap/pm/model';
import type { EditorState, Plugin } from '@tiptap/pm/state';
import type { ReactNode } from 'react';
import type { InteractionLayerHandle } from '../interaction-layer';
import { getInteractionLayer } from '../interaction-layer-host';
import { type MarkInfo, markIdentityKey, markIdentityPlugin } from './mark-identity';

interface MarkPropPanelContext {
  editor: Editor;
  nodeId: string;
  deactivate: () => void;
}

type MarkPropPanelRenderer = (ctx: MarkPropPanelContext) => ReactNode;

interface MarkPrimaryActionContext {
  editor: Editor;
  nodeId: string;
  newTab: boolean;
}

type MarkPrimaryActionHandler = (ctx: MarkPrimaryActionContext) => boolean | undefined;

interface MarkInteractionBridgeParams {
  editor: Editor;
  markTypes: readonly string[];
  predicate?: (mark: Mark) => boolean;
  renderPropPanel: MarkPropPanelRenderer;
  handlePrimary?: MarkPrimaryActionHandler;
}

interface BuildMarkInteractionBridgeParams extends MarkInteractionBridgeParams {
  layer: InteractionLayerHandle;
}

export function getCurrentMarkInfo(state: EditorState, markId: string): MarkInfo | null {
  const pluginState = markIdentityKey.getState(state);
  return pluginState?.byId.get(markId) ?? null;
}

interface MarkBridgeHandlers {
  onRegister: (info: MarkInfo) => void;
  onDeregister: (id: string) => void;
}

export function buildMarkBridgeHandlers(params: {
  editor: Editor;
  layer: InteractionLayerHandle;
  renderPropPanel: MarkPropPanelRenderer;
  handlePrimary?: MarkPrimaryActionHandler;
}): MarkBridgeHandlers {
  const { editor, layer, renderPropPanel, handlePrimary } = params;
  return {
    onRegister: (info) => {
      layer.register({
        type: info.markType,
        nodeId: info.id,
        controls: {
          propPanel: (ctx) =>
            renderPropPanel({
              editor,
              nodeId: ctx.nodeId,
              deactivate: ctx.deactivate,
            }),
        },
        handlePrimary: handlePrimary
          ? (ctx) => handlePrimary({ editor, nodeId: ctx.nodeId, newTab: ctx.newTab })
          : undefined,
      });
    },
    onDeregister: (id) => {
      layer.deregister(id);
    },
  };
}

export function buildMarkInteractionBridge(params: BuildMarkInteractionBridgeParams): Plugin {
  const { editor, layer, markTypes, predicate, renderPropPanel, handlePrimary } = params;
  const handlers = buildMarkBridgeHandlers({ editor, layer, renderPropPanel, handlePrimary });
  return markIdentityPlugin({
    markTypes: [...markTypes],
    predicate,
    onRegister: handlers.onRegister,
    onDeregister: handlers.onDeregister,
  });
}

export function createMarkInteractionBridgePlugin(params: MarkInteractionBridgeParams): Plugin {
  const layer = getInteractionLayer(params.editor);
  return buildMarkInteractionBridge({ ...params, layer });
}
