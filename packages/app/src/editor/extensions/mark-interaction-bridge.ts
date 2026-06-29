
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
