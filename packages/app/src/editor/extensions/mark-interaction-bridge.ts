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

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

interface MarkPropPanelContext {
  /** TipTap Editor the panel belongs to. Use for `.chain()`, state reads, etc. */
  editor: Editor;
  /** Mark ID — stable per mark lifetime, resolves via `getCurrentMarkInfo`. */
  nodeId: string;
  /** Caller closes the panel. Forwarded from the layer's InteractionContext. */
  deactivate: () => void;
}

type MarkPropPanelRenderer = (ctx: MarkPropPanelContext) => ReactNode;

/**
 * Context passed to the optional `handlePrimary` hook. Mark chips that want
 * to short-circuit the layer's default "open PropPanel" behavior on bare
 * click / Enter / Space implement this to navigate directly. `newTab`
 * reflects Cmd/Ctrl/middle-click — preserves the universal web convention.
 */
interface MarkPrimaryActionContext {
  editor: Editor;
  nodeId: string;
  newTab: boolean;
}

/**
 * Primary-action hook. Return `true` to mean "handled — do NOT open the
 * PropPanel"; return `false`/`undefined` to fall through to the default
 * (`setActiveNode`).
 */
type MarkPrimaryActionHandler = (ctx: MarkPrimaryActionContext) => boolean | undefined;

interface MarkInteractionBridgeParams {
  /** TipTap Editor instance — used for getInteractionLayer + as renderer ctx. */
  editor: Editor;
  /** Mark type names to track (e.g. `['link']`). */
  markTypes: readonly string[];
  /** Optional additional filter (e.g. only external-link marks). */
  predicate?: (mark: Mark) => boolean;
  /** Render the PropPanel UI for an active mark. */
  renderPropPanel: MarkPropPanelRenderer;
  /**
   * Optional: override the layer's default "open PropPanel" activation.
   * Called on bare click / Enter / Space AND on Cmd/Ctrl+click (with
   * `newTab: true`). Returning `true` skips setActiveNode; returning
   * false/undefined falls through to the PropPanel.
   *
   * Used by link chips (InternalLink) to preserve universal web semantics:
   * bare click → PropPanel, Cmd+click → navigate in new tab.
   */
  handlePrimary?: MarkPrimaryActionHandler;
}

/** Internal params — layer supplied explicitly. Used by tests + the factory. */
interface BuildMarkInteractionBridgeParams extends MarkInteractionBridgeParams {
  layer: InteractionLayerHandle;
}

// ---------------------------------------------------------------------------
// Live-position lookup — pure helper
// ---------------------------------------------------------------------------

/**
 * Read the current `MarkInfo` for a mark ID from the identity plugin's state.
 * Returns null if:
 *   - `markIdentityPlugin` isn't installed on this editor, OR
 *   - The mark ID was never registered / has been removed.
 *
 * Use in PropPanel renderers that need live `from`/`to` positions (which
 * change as the user edits) rather than the values captured at register time.
 *
 * Pure: reads `EditorState` + the identity plugin's state map. No DOM, no
 * React, no side effects.
 */
export function getCurrentMarkInfo(state: EditorState, markId: string): MarkInfo | null {
  const pluginState = markIdentityKey.getState(state);
  return pluginState?.byId.get(markId) ?? null;
}

// ---------------------------------------------------------------------------
// Handler factory — testable without a PM View or DOM
// ---------------------------------------------------------------------------

interface MarkBridgeHandlers {
  onRegister: (info: MarkInfo) => void;
  onDeregister: (id: string) => void;
}

/**
 * Build the onRegister/onDeregister handlers that wire markIdentityPlugin's
 * view lifecycle to an InteractionLayerHandle. Exported for unit tests so the
 * wiring is verifiable without mounting a real PM view.
 *
 * The handlers are closures over the editor/layer/renderPropPanel inputs and
 * can be fed to `markIdentityPlugin({ onRegister, onDeregister, ... })`.
 */
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

// ---------------------------------------------------------------------------
// Plugin factories
// ---------------------------------------------------------------------------

/**
 * Build a markIdentityPlugin pre-wired to the provided layer. Testable form:
 * callers supply both the editor and the layer, so unit tests can pass a mock
 * layer without touching DOM.
 */
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

/**
 * Consumer-facing factory: resolves the InteractionLayer singleton via
 * `getInteractionLayer(editor)` and delegates to `buildMarkInteractionBridge`.
 *
 * Use this from a TipTap extension's `addProseMirrorPlugins()` alongside
 * `markIdentityDecorationPlugin()` to wire a mark chip to the shared
 * editor-root React plane.
 */
export function createMarkInteractionBridgePlugin(params: MarkInteractionBridgeParams): Plugin {
  const layer = getInteractionLayer(params.editor);
  return buildMarkInteractionBridge({ ...params, layer });
}
