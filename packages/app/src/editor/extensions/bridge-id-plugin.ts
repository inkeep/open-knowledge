import { Extension } from '@tiptap/core';
import type { EditorState } from '@tiptap/pm/state';
import { Plugin, PluginKey } from '@tiptap/pm/state';

interface BridgeIdState {
  posToId: Map<number, string>;
  counter: number;
}

export const bridgeIdPluginKey = new PluginKey<BridgeIdState>('bridgeId');

export function getBridgeId(state: EditorState, pos: number): string | undefined {
  return bridgeIdPluginKey.getState(state)?.posToId.get(pos);
}

export function assertBridgeIdInvariant(state: EditorState): void {
  const pluginState = bridgeIdPluginKey.getState(state);
  if (!pluginState) {
    throw new Error('bridgeIdPlugin not installed');
  }

  const seen = new Set<string>();
  state.doc.descendants((node, pos) => {
    if (node.type.name !== 'jsxComponent') return;
    const id = pluginState.posToId.get(pos);
    if (!id) {
      throw new Error(`jsxComponent at pos ${pos} has no bridgeId`);
    }
    if (seen.has(id)) {
      throw new Error(`Duplicate bridgeId "${id}" at pos ${pos}`);
    }
    seen.add(id);
  });
}

export const BridgeIdPlugin = Extension.create({
  name: 'bridgeIdPlugin',
  priority: 1000,

  addProseMirrorPlugins() {
    return [
      new Plugin<BridgeIdState>({
        key: bridgeIdPluginKey,

        state: {
          init(_config, state) {
            const initial: BridgeIdState = { posToId: new Map(), counter: 0 };

            state.doc.descendants((node, pos) => {
              if (node.type.name !== 'jsxComponent') return;
              initial.posToId.set(pos, `b${++initial.counter}`);
            });

            return initial;
          },

          apply(tr, prev, _oldState, newState) {
            if (!tr.docChanged) {
              const newPosToId = new Map<number, string>();
              for (const [oldPos, id] of prev.posToId) {
                const newPos = tr.mapping.map(oldPos);
                const node = newState.doc.nodeAt(newPos);
                if (node?.type.name === 'jsxComponent') {
                  newPosToId.set(newPos, id);
                }
              }
              return { ...prev, posToId: newPosToId };
            }

            const newPosToId = new Map<number, string>();
            let { counter } = prev;

            newState.doc.descendants((node, pos) => {
              if (node.type.name !== 'jsxComponent') return;

              let found = false;
              for (const [oldPos, id] of prev.posToId) {
                if (tr.mapping.map(oldPos) === pos) {
                  newPosToId.set(pos, id);
                  found = true;
                  break;
                }
              }
              if (!found) newPosToId.set(pos, `b${++counter}`);
            });

            return { posToId: newPosToId, counter };
          },
        },
      }),
    ];
  },
});
