/**
 * SelectionStatePlugin — the canonical block-selection state store (Precedent #31).
 *
 * Derives a typed {selectedBlockId, ancestorChain, selectionOrigin, isDragging}
 * state from the current PM selection + event-classified origin. One source of
 * truth for every selection-adjacent surface — NodeView `data-*` attrs,
 * aria-live announcer, selection-anchored popovers.
 *
 * Replaces three patterns formerly duplicated across the codebase:
 *   - `.is-selected` className toggled from `NodeViewProps.selected`.
 *   - Per-NodeView `$pos.node(depth)` walks to compute ancestor chains.
 *   - Ad-hoc `:has()`-based innermost-wins CSS rules.
 *
 * Read-only over the PM doc: never mutates document content. Meta-only
 * transactions ARE dispatched (see `scheduleRefresh` below) to flow
 * drag/selection signalling through PM's standard apply pipeline —
 * these carry no doc steps and leave the bridge invariant
 * unchanged.
 *
 * Origin classification is event-driven (not tx-heuristic): DOM
 * pointerdown/mousedown → 'pointer'; keydown on nav keys → 'keyboard'; a
 * transaction stamped with `SELECTION_ORIGIN_META_KEY` → 'programmatic'
 * (covers agent writes + imperative test-harness `setNodeSelection`). The
 * discipline of one typed meta key per origin category extends Precedent #1
 * (typed transaction origins).
 *
 * Drag tracking: HTML5 `dragstart` / `dragend` / `drop` on
 * `view.dom.parentElement` (the editor container — capture phase)
 * toggle `isDragging`. The CSS layer uses this to suppress the halo
 * mid-drag. `drop` is included because a cancelled drag sometimes ends
 * in a drop without a preceding dragend in current browser behavior.
 * The parentElement target is load-bearing: BlockDragHandle mounts its
 * draggable container as a sibling of view.dom — see the view() block
 * below for the bubble-vs-capture topology.
 *
 * Subscription model: the canonical React integration is
 * `useBlockSelection(editor)` (see `../hooks/use-block-selection.ts`), which
 * wires through TipTap's `transaction` + `selectionUpdate` events — the same
 * path used by BubbleMenu and SideMenu. Non-React callers read imperatively
 * via `getBlockSelection(editor)` and listen directly to TipTap events.
 */

import { type Editor, Extension } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import type { EditorState, Selection } from '@tiptap/pm/state';
import { NodeSelection, Plugin, PluginKey } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';
import { bridgeIdPluginKey } from './bridge-id-plugin.ts';

type SelectionOrigin = 'keyboard' | 'pointer' | 'programmatic';

export interface BlockChainEntry {
  readonly bridgeId: string;
  readonly componentName: string;
  readonly pos: number;
}

export interface BlockSelection {
  readonly selectedBlockId: string | null;
  readonly ancestorChain: readonly BlockChainEntry[];
  readonly selectionOrigin: SelectionOrigin;
  readonly isDragging: boolean;
  readonly rangeEncompassedBlockIds: ReadonlySet<string>;
}

/** PM transaction meta key — consumers that want to override origin
 *  classification set `tr.setMeta(SELECTION_ORIGIN_META_KEY, 'programmatic')`.
 *  The plugin's `apply` checks this before consulting the DOM-event-derived
 *  `pendingOrigin`. Used by agent writes and imperative `setNodeSelection`
 *  in the test harness.
 *
 *  Note on Precedent #1: that precedent governs Y.Doc transaction origins
 *  (typed `LocalTransactionOrigin` objects, identity-matched). PM tr-meta
 *  keys are a different surface — PM's `tr.getMeta(key)` API takes string
 *  or PluginKey instances. We use a unique namespaced string here, in line
 *  with PM convention. */
export const SELECTION_ORIGIN_META_KEY = 'selectionStatePlugin/origin';

const SELECTION_REFRESH_META_KEY = 'selectionStatePlugin/refresh';

export const selectionStatePluginKey = new PluginKey<BlockSelection>('selectionState');

const EMPTY_RANGE_SET: ReadonlySet<string> = new Set<string>();

const EMPTY_SELECTION: BlockSelection = {
  selectedBlockId: null,
  ancestorChain: [],
  selectionOrigin: 'programmatic',
  isDragging: false,
  rangeEncompassedBlockIds: EMPTY_RANGE_SET,
};

export function getBlockSelection(editor: Editor): BlockSelection {
  const state = selectionStatePluginKey.getState(editor.state);
  return state ?? EMPTY_SELECTION;
}

export function deriveAncestorChain(
  state: EditorState,
  selection: EditorState['selection'],
): BlockChainEntry[] {
  const chain: BlockChainEntry[] = [];

  const { $from } = selection;

  for (let depth = 1; depth <= $from.depth; depth++) {
    const node = $from.node(depth);
    if (node.type.name !== 'jsxComponent') continue;
    const pos = $from.before(depth);
    chain.push(toChainEntry(state, node, pos));
  }

  if (selection instanceof NodeSelection) {
    const node = selection.node;
    if (node.type.name === 'jsxComponent') {
      chain.push(toChainEntry(state, node, selection.from));
    }
  }

  return chain;
}

function toChainEntry(state: EditorState, node: PMNode, pos: number): BlockChainEntry {
  const componentName = (node.attrs.componentName as string | undefined) ?? 'unknown';
  return { bridgeId: getWrapperBridgeId(state, pos), componentName, pos };
}

export function getWrapperBridgeId(state: EditorState, pos: number): string {
  return bridgeIdPluginKey.getState(state)?.posToId.get(pos) ?? `pos-${pos}`;
}

function deriveRangeEncompassedBlockIds(
  state: EditorState,
  selection: Selection,
): ReadonlySet<string> {
  if (selection instanceof NodeSelection) return EMPTY_RANGE_SET;
  const { from, to } = selection;
  if (from >= to) return EMPTY_RANGE_SET;
  const posToId = bridgeIdPluginKey.getState(state)?.posToId;
  if (!posToId) return EMPTY_RANGE_SET;
  let ids: Set<string> | null = null;
  for (const [pos, id] of posToId) {
    if (pos < from) continue;
    const node = state.doc.nodeAt(pos);
    if (!node) continue;
    if (pos + node.nodeSize > to) continue;
    ids ||= new Set<string>();
    ids.add(id);
  }
  return ids ?? EMPTY_RANGE_SET;
}

export function deriveBlockSelection(
  state: EditorState,
  prev: BlockSelection,
  overrides: { origin?: SelectionOrigin; isDragging?: boolean } = {},
): BlockSelection {
  const chain = deriveAncestorChain(state, state.selection);
  const innermost = chain[chain.length - 1];
  const rangeEncompassedBlockIds = deriveRangeEncompassedBlockIds(state, state.selection);
  const next: BlockSelection = {
    selectedBlockId: innermost?.bridgeId ?? null,
    ancestorChain: chain,
    selectionOrigin: overrides.origin ?? prev.selectionOrigin,
    isDragging: overrides.isDragging ?? prev.isDragging,
    rangeEncompassedBlockIds,
  };
  if (blockSelectionEqual(prev, next)) return prev;
  return next;
}

function blockSelectionEqual(a: BlockSelection, b: BlockSelection): boolean {
  if (a === b) return true;
  if (a.selectedBlockId !== b.selectedBlockId) return false;
  if (a.selectionOrigin !== b.selectionOrigin) return false;
  if (a.isDragging !== b.isDragging) return false;
  if (a.ancestorChain.length !== b.ancestorChain.length) return false;
  for (let i = 0; i < a.ancestorChain.length; i++) {
    const x = a.ancestorChain[i];
    const y = b.ancestorChain[i];
    if (x.bridgeId !== y.bridgeId) return false;
    if (x.componentName !== y.componentName) return false;
    if (x.pos !== y.pos) return false;
  }
  if (a.rangeEncompassedBlockIds.size !== b.rangeEncompassedBlockIds.size) return false;
  for (const id of a.rangeEncompassedBlockIds) {
    if (!b.rangeEncompassedBlockIds.has(id)) return false;
  }
  return true;
}

export interface PluginRuntime {
  pendingOrigin: SelectionOrigin | null;
  isDragging: boolean;
}

const RUNTIME = new WeakMap<Plugin<BlockSelection>, PluginRuntime>();

export function computeSelectionApply(
  tr: import('@tiptap/pm/state').Transaction,
  prev: BlockSelection,
  newState: EditorState,
  runtime: PluginRuntime | undefined,
): BlockSelection {
  const isDragging = runtime?.isDragging ?? prev.isDragging;

  const isRefreshTx = Boolean(tr.getMeta(SELECTION_REFRESH_META_KEY));
  const consumesPending = tr.selectionSet && !isRefreshTx;

  const metaOrigin = tr.getMeta(SELECTION_ORIGIN_META_KEY) as SelectionOrigin | undefined;
  const pendingOrigin = consumesPending ? (runtime?.pendingOrigin ?? null) : null;
  const origin = metaOrigin ?? pendingOrigin ?? prev.selectionOrigin;

  if (consumesPending && runtime) runtime.pendingOrigin = null;

  return deriveBlockSelection(newState, prev, { origin, isDragging });
}

export const SelectionStatePlugin = Extension.create({
  name: 'selectionStatePlugin',

  addProseMirrorPlugins() {
    const editor = this.editor as Editor;

    const plugin = new Plugin<BlockSelection>({
      key: selectionStatePluginKey,

      state: {
        init(_config, state): BlockSelection {
          return deriveBlockSelection(state, EMPTY_SELECTION);
        },

        apply(tr, prev, _oldState, newState): BlockSelection {
          return computeSelectionApply(tr, prev, newState, RUNTIME.get(plugin));
        },
      },

      props: {
        handleDOMEvents: {
          mousedown: () => {
            const runtime = RUNTIME.get(plugin);
            if (runtime) runtime.pendingOrigin = 'pointer';
            return false;
          },
          pointerdown: () => {
            const runtime = RUNTIME.get(plugin);
            if (runtime) runtime.pendingOrigin = 'pointer';
            return false;
          },
        },
        handleKeyDown: (_view, event) => {
          if (isBlockNavigationKey(event.key)) {
            const runtime = RUNTIME.get(plugin);
            if (runtime) runtime.pendingOrigin = 'keyboard';
          }
          return false;
        },
      },

      view(view: EditorView) {
        RUNTIME.set(plugin, { pendingOrigin: null, isDragging: false });

        const dragHost = view.dom.parentElement ?? view.dom;

        const onDragStart = () => {
          const runtime = RUNTIME.get(plugin);
          if (!runtime) return;
          runtime.isDragging = true;
          scheduleRefresh(editor);
        };
        const onDragEnd = () => {
          const runtime = RUNTIME.get(plugin);
          if (!runtime) return;
          runtime.isDragging = false;
          scheduleRefresh(editor);
        };

        dragHost.addEventListener('dragstart', onDragStart, true);
        dragHost.addEventListener('dragend', onDragEnd, true);
        dragHost.addEventListener('drop', onDragEnd, true);

        return {
          destroy: () => {
            dragHost.removeEventListener('dragstart', onDragStart, true);
            dragHost.removeEventListener('dragend', onDragEnd, true);
            dragHost.removeEventListener('drop', onDragEnd, true);
            RUNTIME.delete(plugin);
          },
        };
      },
    });

    return [plugin];
  },
});

export function isBlockNavigationKey(key: string): boolean {
  return (
    key === 'ArrowUp' ||
    key === 'ArrowDown' ||
    key === 'ArrowLeft' ||
    key === 'ArrowRight' ||
    key === 'Tab' ||
    key === 'Escape' ||
    key === 'Enter' ||
    key === 'Home' ||
    key === 'End' ||
    key === 'PageUp' ||
    key === 'PageDown'
  );
}

function scheduleRefresh(editor: Editor): void {
  queueMicrotask(() => {
    if (editor.isDestroyed) return;
    try {
      const tr = editor.state.tr.setMeta(SELECTION_REFRESH_META_KEY, true);
      editor.view.dispatch(tr);
    } catch {}
  });
}
