/**
 * bridgeId PluginState — stable PM-side identity for jsxComponent nodes.
 *
 * Assigns a unique string `bridgeId` to every jsxComponent PM node, keyed
 * by the backing Y.XmlElement identity from y-prosemirror. Kept in
 * PluginState (not a schema attr) so the id survives Observer B re-parse
 * cycles without flicking y-prosemirror's `equalYTypePNode` attr-diff:
 *   - parse output has no attr for y-prosemirror to compare
 *   - Y.XmlElement identity is preserved by y-prosemirror for unchanged content
 *   - WeakMap entry preserved → bridgeId stable across parse cycles
 *
 * **Why Y.XmlElement-keyed (CRDT identity) and NOT a nonce + `tr.mapping`
 * counter.** A nonce counter remapped via `tr.mapping` handles LOCAL
 * position shifts fine — incremental inserts / deletes within one client's
 * editor. It does NOT handle multi-peer shape: a remote peer's delete-
 * then-reinsert produces a fresh Y.XmlElement locally, and a nonce scheme
 * would assign a fresh id to what the user perceives as "the same block
 * they selected a moment ago." The consumers below — programmatic ancestor
 * NodeSelection restore (`SelectionStatePlugin.ancestorChain`) and the
 * `rangeEncompassedBlockIds` derivation — rely on the id staying stable
 * across remote churn so a selection re-anchor still resolves to the
 * intended block even after a collaborator's rearrangement. Y.XmlElement
 * identity is the minimum primitive that carries peer-stable cross-client
 * identity for free.
 *
 * **Current consumers.**
 *   - `SelectionStatePlugin.BlockSelection.ancestorChain` entries carry
 *     `bridgeId` so programmatic ancestor NodeSelections survive
 *     collaborative position shifts between render and dispatch. Precedent
 *     "Selection state as typed PM PluginState" (§27).
 *   - `JsxComponentView` reads `getWrapperBridgeId(state, pos)` to decide
 *     halo / `data-has-child-selected` state against `BlockSelection`.
 *
 * **Future consumers that will need this primitive rather than a nonce:**
 * user-authored compound descriptors (require stable cross-peer id for
 * Context bridging when / if Fallback-2 upgrades to a registry); multi-peer
 * presence pins anchored to a block; deterministic test seed-replay
 * (seed-scoped ids must match the CRDT's replay order).
 *
 * The stable-id primitive is in place because the SelectionStatePlugin
 * consumers documented above depend on it (Fallback 2, "Compound components
 * use DOM data-attributes", is the active path for cross-block coordination).
 * If a future consumer needs the same primitive, reuse this plugin —
 * don't duplicate it.
 *
 * jsxInline is excluded (thin zero-attr shape by design).
 */

import { Extension } from '@tiptap/core';
import type { EditorState } from '@tiptap/pm/state';
import { Plugin, PluginKey } from '@tiptap/pm/state';
// Sourced from @tiptap/y-tiptap (TipTap v3 official path), not y-prosemirror
// directly. Aligns with editor-cache.ts's yUndoPluginKey import — both
// must reference the SAME `new PluginKey('y-sync')` constant for
// Y.UndoManager.trackedOrigins Set-by-identity matching to work across the
// edit (sync) and undo paths. y-prosemirror is the upstream library that
// @tiptap/y-tiptap re-exports; mixing direct y-prosemirror imports with
// @tiptap/y-tiptap imports produces two distinct module-level PluginKey
// instances and silently breaks origin-keyed tracking.
import { ySyncPluginKey } from '@tiptap/y-tiptap';
import type * as Y from 'yjs';

interface BridgeIdState {
  /** WeakMap keyed by Y.XmlElement for GC-friendly stable identity */
  yElementToId: WeakMap<Y.XmlElement, string>;
  /** Forward map for lookup by pos — rebuilt each transaction */
  posToId: Map<number, string>;
  /** Monotonic counter for this editor instance */
  counter: number;
}

export const bridgeIdPluginKey = new PluginKey<BridgeIdState>('bridgeId');

/**
 * Get the bridgeId for a jsxComponent node at a given position.
 * Returns undefined if the node is not a jsxComponent or has no ID assigned yet.
 */
export function getBridgeId(state: EditorState, pos: number): string | undefined {
  return bridgeIdPluginKey.getState(state)?.posToId.get(pos);
}

/**
 * Assert every jsxComponent in the doc has a bridgeId. Throws on failure.
 * Used in integration tests.
 */
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

/**
 * Get the y-prosemirror binding's mapping (Y.AbstractType → PM.Node).
 * Returns the binding's internal mapping if available, else null.
 */
function getYMapping(state: EditorState): Map<Y.AbstractType<unknown>, unknown> | null {
  const syncState = ySyncPluginKey.getState(state);
  if (!syncState?.binding?.mapping) return null;
  return syncState.binding.mapping as Map<Y.AbstractType<unknown>, unknown>;
}

/**
 * Build a reverse index once per apply: PM.Node → Y.XmlElement. Callers
 * pass this to `findYElementForPos` instead of re-scanning the mapping
 * per descendant (the previous shape was O(mapping) per jsxComponent
 * node, O(N²) on MDX-heavy docs).
 *
 * Duck-type check uses y-js `XmlElement` structural identity (nodeName +
 * getAttribute) rather than `instanceof` to avoid pulling a value-import
 * of the whole `yjs` module into this file — only `import type` is in
 * scope at the top, and switching to a value import would mildly affect
 * bundle dedup (y-prosemirror / y-protocols / y-codemirror.next share
 * the same Yjs instance via the hoisted top-level y-js dep, not a
 * per-extension one).
 */
function buildPmNodeToYElementIndex(
  state: EditorState,
): Map<import('@tiptap/pm/model').Node, Y.XmlElement> | null {
  const mapping = getYMapping(state);
  if (!mapping) return null;
  const out = new Map<import('@tiptap/pm/model').Node, Y.XmlElement>();
  for (const [yType, pmNode] of mapping) {
    if (!pmNode) continue;
    if ('nodeName' in yType && typeof (yType as Y.XmlElement).getAttribute === 'function') {
      // One Y.XmlElement maps to exactly one PM.Node; the reverse is
      // also true in y-prosemirror's binding. If a duplicate key shows
      // up (shouldn't happen in practice), last-wins — the latest
      // binding wins the reverse lookup.
      out.set(pmNode as import('@tiptap/pm/model').Node, yType as Y.XmlElement);
    }
  }
  return out;
}

/** O(1) lookup via the reverse index. */
function findYElementForPosIndexed(
  index: Map<import('@tiptap/pm/model').Node, Y.XmlElement> | null,
  node: import('@tiptap/pm/model').Node,
): Y.XmlElement | null {
  if (!index) return null;
  return index.get(node) ?? null;
}

export const BridgeIdPlugin = Extension.create({
  name: 'bridgeIdPlugin',
  // Priority 1000 (higher than default 100) ensures this extension is
  // processed BEFORE SelectionStatePlugin so its PM plugin state field is
  // registered first — SelectionStatePlugin.state.apply then sees the
  // BridgeIdPlugin state in its newState. TipTap sorts extensions by
  // descending priority; PM fields end up in that order; PM's applyInner
  // loop runs them in field order.
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

            // Initial assignment for any jsxComponent nodes already in the doc.
            // Build the PM.Node → Y.XmlElement reverse index ONCE per apply and
            // share it across descendants (O(N) total) instead of re-scanning
            // the mapping per descendant (O(N²) on MDX-heavy docs).
            const initIndex = buildPmNodeToYElementIndex(state);
            state.doc.descendants((node, pos) => {
              if (node.type.name !== 'jsxComponent') return;
              const yEl = findYElementForPosIndexed(initIndex, node);
              if (yEl) {
                const id = `b${++initial.counter}`;
                initial.yElementToId.set(yEl, id);
                initial.posToId.set(pos, id);
              } else {
                // No Y.XmlElement yet (editor initializing) — assign by position
                // This entry will be upgraded to Y.XmlElement-keyed on next apply
                const id = `b${++initial.counter}`;
                initial.posToId.set(pos, id);
              }
            });

            return initial;
          },

          apply(tr, prev, _oldState, newState) {
            // If no doc change, just remap positions
            if (!tr.docChanged) {
              const newPosToId = new Map<number, string>();
              for (const [oldPos, id] of prev.posToId) {
                const newPos = tr.mapping.map(oldPos);
                // Verify the mapped position still has a jsxComponent
                const node = newState.doc.nodeAt(newPos);
                if (node?.type.name === 'jsxComponent') {
                  newPosToId.set(newPos, id);
                }
              }
              return { ...prev, posToId: newPosToId };
            }

            // Doc changed — rebuild posToId from Y.XmlElement identity.
            // Single reverse-index build per apply, reused for every
            // descendant lookup below (see `buildPmNodeToYElementIndex`).
            const newPosToId = new Map<number, string>();
            let { counter } = prev;
            const { yElementToId } = prev;
            const applyIndex = buildPmNodeToYElementIndex(newState);

            newState.doc.descendants((node, pos) => {
              if (node.type.name !== 'jsxComponent') return;

              // Try to find the backing Y.XmlElement
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
                // No Y.XmlElement found — try position mapping from prev
                // This handles the brief window during editor init before
                // y-prosemirror has built its mapping
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
