import { Extension } from '@tiptap/core';
import type { EditorState } from '@tiptap/pm/state';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { ySyncPluginKey } from '@tiptap/y-tiptap';
import type * as Y from 'yjs';

interface BridgeIdState {
  yElementToId: WeakMap<Y.XmlElement, string>;
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

function getYMapping(state: EditorState): Map<Y.AbstractType<unknown>, unknown> | null {
  const syncState = ySyncPluginKey.getState(state);
  if (!syncState?.binding?.mapping) return null;
  return syncState.binding.mapping as Map<Y.AbstractType<unknown>, unknown>;
}

function buildPmNodeToYElementIndex(
  state: EditorState,
): Map<import('@tiptap/pm/model').Node, Y.XmlElement> | null {
  const mapping = getYMapping(state);
  if (!mapping) return null;
  const out = new Map<import('@tiptap/pm/model').Node, Y.XmlElement>();
  for (const [yType, pmNode] of mapping) {
    if (!pmNode) continue;
    if ('nodeName' in yType && typeof (yType as Y.XmlElement).getAttribute === 'function') {
      out.set(pmNode as import('@tiptap/pm/model').Node, yType as Y.XmlElement);
    }
  }
  return out;
}

function findYElementForPosIndexed(
  index: Map<import('@tiptap/pm/model').Node, Y.XmlElement> | null,
  node: import('@tiptap/pm/model').Node,
): Y.XmlElement | null {
  if (!index) return null;
  return index.get(node) ?? null;
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
            const initial: BridgeIdState = {
              yElementToId: new WeakMap(),
              posToId: new Map(),
              counter: 0,
            };

            const initIndex = buildPmNodeToYElementIndex(state);
            state.doc.descendants((node, pos) => {
              if (node.type.name !== 'jsxComponent') return;
              const yEl = findYElementForPosIndexed(initIndex, node);
              if (yEl) {
                const id = `b${++initial.counter}`;
                initial.yElementToId.set(yEl, id);
                initial.posToId.set(pos, id);
              } else {
                const id = `b${++initial.counter}`;
                initial.posToId.set(pos, id);
              }
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
            const { yElementToId } = prev;
            const applyIndex = buildPmNodeToYElementIndex(newState);

            newState.doc.descendants((node, pos) => {
              if (node.type.name !== 'jsxComponent') return;

              const yEl = findYElementForPosIndexed(applyIndex, node);
              if (yEl) {
                const existing = yElementToId.get(yEl);
                if (existing) {
                  newPosToId.set(pos, existing);
                } else {
                  const id = `b${++counter}`;
                  yElementToId.set(yEl, id);
                  newPosToId.set(pos, id);
                }
              } else {
                let found = false;
                for (const [oldPos, id] of prev.posToId) {
                  const mappedPos = tr.mapping.map(oldPos);
                  if (mappedPos === pos) {
                    newPosToId.set(pos, id);
                    found = true;
                    break;
                  }
                }
                if (!found) {
                  const id = `b${++counter}`;
                  newPosToId.set(pos, id);
                }
              }
            });

            return { yElementToId, posToId: newPosToId, counter };
          },
        },
      }),
    ];
  },
});
