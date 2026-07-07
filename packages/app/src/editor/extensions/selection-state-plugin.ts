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

// ── Types ────────────────────────────────────────────────────────────────

type SelectionOrigin = 'keyboard' | 'pointer' | 'programmatic';

export interface BlockChainEntry {
  /** Stable bridgeId for the jsxComponent wrapper, or a position-derived
   *  fallback when y-prosemirror binding hasn't published a mapping yet
   *  (briefly true at editor init — not in steady state). */
  readonly bridgeId: string;
  /** Descriptor name, e.g. "Card", "Steps", "Callout". */
  readonly componentName: string;
  /** PM position of the jsxComponent wrapper's start (index of `<` in doc). */
  readonly pos: number;
}

/**
 * INVARIANT: `selectedBlockId` and `ancestorChain` are always in agreement —
 * either both express "no block selected" (`selectedBlockId === null` AND
 * `ancestorChain.length === 0`) or both express "block selected"
 * (`selectedBlockId !== null` AND `ancestorChain[ancestorChain.length - 1]
 * .bridgeId === selectedBlockId`).
 *
 * This invariant is enforced by `deriveBlockSelection` being the SOLE
 * constructor in this module. Consumers safely guard on either field; both
 * resolve to the same selected/not-selected state.
 *
 * If a second constructor is ever added (e.g. multi-block range selection,
 * imperative test-harness selection injection), refactor to a discriminated
 * union (`{ kind: 'none' | 'selected' }`) so the type system enforces the
 * invariant at the API boundary instead of relying on constructor discipline.
 * Declined as premature in v1 (one producer — `deriveBlockSelection` —
 * guarantees the invariant by construction); worth the lift the moment a
 * second constructor lands.
 */
export interface BlockSelection {
  /** bridgeId of the innermost selected jsxComponent, or null if no block selected. */
  readonly selectedBlockId: string | null;
  /** Ancestor chain outer→innermost. Empty when no block is selected. */
  readonly ancestorChain: readonly BlockChainEntry[];
  /** How this selection was initiated. */
  readonly selectionOrigin: SelectionOrigin;
  /** True while an HTML5 drag is active (set by `dragstart`, cleared by `dragend`). */
  readonly isDragging: boolean;
  /**
   * BridgeIds of every jsxComponent wrapper fully contained within the
   * current TextSelection / AllSelection range. Empty for NodeSelection
   * (single-node range — already represented by `selectedBlockId`) and for
   * collapsed selections.
   *
   * Drives the soft "this block is in your selection" halo on JSX wrappers
   * that the native browser text-selection paint can't reach (their chrome
   * is `contentEditable={false}` so the OS highlight stops at the edge).
   *
   * Relationship to `selectedBlockId`: NodeSelection always leaves this set
   * empty. For TextSelection / AllSelection, `selectedBlockId` independently
   * reflects the innermost jsxComponent ancestor of `$from` (via
   * `deriveAncestorChain`), which may or may not overlap with the wrappers
   * fully covered by the selection range — e.g., a TextSelection that runs
   * from inside Callout A to inside Callout B leaves `selectedBlockId =
   * Callout A's bridgeId` while this set contains any sibling wrappers
   * sitting fully between them.
   */
  readonly rangeEncompassedBlockIds: ReadonlySet<string>;
}

// ── Tr-meta keys ─────────────────────────────────────────────────────────

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

/** PM transaction meta key for the plugin's own meta-only refresh
 *  transactions (dragstart / dragend / drop → re-run apply with new
 *  isDragging). Tagged so `apply` can distinguish "we dispatched this
 *  to surface a runtime change" from "the user did something" and not
 *  consume `pendingOrigin` on these passes. */
const SELECTION_REFRESH_META_KEY = 'selectionStatePlugin/refresh';

// ── PluginKey + imperative API ───────────────────────────────────────────

export const selectionStatePluginKey = new PluginKey<BlockSelection>('selectionState');

const EMPTY_RANGE_SET: ReadonlySet<string> = new Set<string>();

const EMPTY_SELECTION: BlockSelection = {
  selectedBlockId: null,
  ancestorChain: [],
  selectionOrigin: 'programmatic',
  isDragging: false,
  rangeEncompassedBlockIds: EMPTY_RANGE_SET,
};

/** Imperative read — returns the current plugin state or a safe empty value
 *  if the plugin is not registered (e.g. in a harness without this extension).
 *
 *  For React subscription, use `useBlockSelection(editor)` from
 *  `../hooks/use-block-selection.ts` — it wires TipTap's `transaction` +
 *  `selectionUpdate` events, matching the BubbleMenu / SideMenu pattern.
 *  Non-React callers that need change notification should listen to those
 *  events directly and call `getBlockSelection(editor)` inside the handler. */
export function getBlockSelection(editor: Editor): BlockSelection {
  const state = selectionStatePluginKey.getState(editor.state);
  return state ?? EMPTY_SELECTION;
}

// ── Ancestry derivation (pure) ───────────────────────────────────────────

/**
 * Walk `$from.node(depth)` outward, collecting every jsxComponent ancestor.
 * Returns chain outer→innermost.
 *
 * Exported for unit testing. In-plugin callers use `deriveBlockSelection`.
 */
export function deriveAncestorChain(
  state: EditorState,
  selection: EditorState['selection'],
): BlockChainEntry[] {
  const chain: BlockChainEntry[] = [];

  // Start with the selection's $from path. For a NodeSelection on a
  // jsxComponent, $from.node($from.depth + 1) is the node itself — include it.
  const { $from } = selection;

  // Collect ancestors from depth 0 → $from.depth (outer → inner).
  for (let depth = 1; depth <= $from.depth; depth++) {
    const node = $from.node(depth);
    if (node.type.name !== 'jsxComponent') continue;
    // $from.before(depth) is the position just before the node at that depth.
    const pos = $from.before(depth);
    chain.push(toChainEntry(state, node, pos));
  }

  // Special case: NodeSelection sitting ON a jsxComponent. The node itself is
  // at $from.nodeAfter, NOT in the $from.node(depth) walk above (because
  // node(depth) returns the parent at that depth, not the child). Include it
  // so the innermost selected Card-in-Cards shows up as the tail.
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

/**
 * Canonical lookup: get the stable bridgeId for a jsxComponent wrapper at a
 * given position.
 *
 * **Production:** `BridgeIdPlugin` is registered in `sharedExtensions` and its
 * `init` walks the doc to assign every jsxComponent a `b{N}`-style ID
 * synchronously, even before y-prosemirror has built its Y.XmlElement
 * mapping. After init, every jsxComponent in the doc has an entry in the
 * plugin's `posToId` map at steady state. The position-derived fallback
 * below is still hit during the init window BEFORE y-prosemirror has
 * published its binding (and in any future surface that accesses
 * `getWrapperBridgeId` before BridgeIdPlugin.apply has run) — brief,
 * but non-zero. Do not rely on the fallback's stability; it's a
 * best-effort breadcrumb for components that couldn't be keyed yet.
 *
 * **Tests / harness without BridgeIdPlugin:** the fallback returns a
 * `pos-N` synthetic. This path is positional and unstable across edits,
 * which is acceptable in unit-test contexts where edits don't shift
 * positions of nodes that need bridge-id stability. Do not rely on the
 * synthetic ID's stability in any new production path.
 *
 * NodeView consumers (e.g. JsxComponentView) use this to compare against
 * `BlockSelection.selectedBlockId` / `ancestorChain[].bridgeId` — both must
 * resolve from this single helper so the fallback paths match.
 */
export function getWrapperBridgeId(state: EditorState, pos: number): string {
  return bridgeIdPluginKey.getState(state)?.posToId.get(pos) ?? `pos-${pos}`;
}

/**
 * Compute the set of jsxComponent bridgeIds whose nodes are fully covered by
 * the current selection range. Returns an empty set for NodeSelection
 * (single-node range already represented by `selectedBlockId`) and for any
 * collapsed selection.
 *
 * Implementation: iterates `bridgeIdPluginKey.posToId` — the bridge-id
 * plugin already maintains an authoritative `Map<number, string>` of every
 * jsxComponent position to its stable bridgeId. Cost is O(K) over
 * jsxComponent count, not O(N) over total doc nodes; obviates a caching
 * plan at any plausible scale.
 *
 * Containment rule: a wrapper at `pos` with nodeSize `n` is "encompassed"
 * iff `pos >= selection.from && pos + n <= selection.to`. Strict
 * containment — a selection whose `to` lands inside a wrapper's content
 * hole does NOT count it.
 */
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

/**
 * Compute the full BlockSelection from the current editor state + origin hints.
 * Pure — no side effects. Used by the plugin `apply` and testable in isolation.
 */
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
  // Identity preservation — if derived state is structurally identical to
  // prev, return prev. `useSyncExternalStore` bails out on ===, so this is
  // load-bearing for React re-render minimization.
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

// ── TipTap Extension ─────────────────────────────────────────────────────

/**
 * Internal mutable ref for the plugin — holds pending DOM-event-classified
 * origin + isDragging, consumed by the next `apply`.
 *
 * Stored per-plugin-instance via a WeakMap keyed on the plugin. (PM plugins
 * are long-lived singletons, so this is effectively per-editor.)
 */
export interface PluginRuntime {
  pendingOrigin: SelectionOrigin | null;
  isDragging: boolean;
}

const RUNTIME = new WeakMap<Plugin<BlockSelection>, PluginRuntime>();

/**
 * Pure apply logic — testable without TipTap or DOM. Mutates `runtime`
 * in-place to consume `pendingOrigin` on selection-changing transactions.
 *
 * Origin precedence (highest → lowest):
 *   1. `metaOrigin` — caller-controlled, e.g. agent-write, programmatic
 *      `setNodeSelection`. Wins absolutely.
 *   2. `pendingOrigin` — DOM-event-derived ('pointer' / 'keyboard'),
 *      consumed only when this tx changes the selection. Foreign
 *      transactions (y-prosemirror remote sync, plugin refresh) that
 *      don't change selection do NOT consume the pending origin —
 *      otherwise a remote sync arriving between user click and PM's
 *      selection-set would steal the classification.
 *   3. `prev.selectionOrigin` — carry-forward when nothing newer applies.
 *
 * Drag state: read from runtime on every apply (no pendingOrigin
 * coupling); the plugin's view() drag handlers schedule a refresh tx that
 * triggers apply, which then reflects the new isDragging.
 */
export function computeSelectionApply(
  tr: import('@tiptap/pm/state').Transaction,
  prev: BlockSelection,
  newState: EditorState,
  runtime: PluginRuntime | undefined,
): BlockSelection {
  const isDragging = runtime?.isDragging ?? prev.isDragging;

  // Selection-changed gate: only consume pendingOrigin when this tx
  // actually moved the selection. PM exposes `tr.selectionSet` for this.
  // Refresh transactions (drag) explicitly disclaim consumption regardless.
  const isRefreshTx = Boolean(tr.getMeta(SELECTION_REFRESH_META_KEY));
  const consumesPending = tr.selectionSet && !isRefreshTx;

  const metaOrigin = tr.getMeta(SELECTION_ORIGIN_META_KEY) as SelectionOrigin | undefined;
  const pendingOrigin = consumesPending ? (runtime?.pendingOrigin ?? null) : null;
  const origin = metaOrigin ?? pendingOrigin ?? prev.selectionOrigin;

  // Consume pendingOrigin only when we actually used (or could have used) it.
  // A foreign tx that doesn't change selection leaves the pending origin
  // intact, so the user's NEXT selection change still picks it up.
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
          // Pointer events fire before PM commits the selection-changing tx.
          // Set pendingOrigin; next `apply` consumes it.
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
          // Drag events intentionally handled in view() via capture-phase
          // listeners on view.dom.parentElement — NodeView wrappers'
          // stopEvent() intercepts drag events before PM's handleDOMEvents
          // chain runs, and chrome-host drags (BlockDragHandle) originate
          // at a sibling of view.dom, so capture phase on parentElement is
          // the only registration point that catches both classes.
        },
        handleKeyDown: (_view, event) => {
          // Classify arrow/tab/escape/enter as keyboard-origin; other keys
          // don't move the block selection, so they're irrelevant.
          if (isBlockNavigationKey(event.key)) {
            const runtime = RUNTIME.get(plugin);
            if (runtime) runtime.pendingOrigin = 'keyboard';
          }
          return false;
        },
      },

      view(view: EditorView) {
        RUNTIME.set(plugin, { pendingOrigin: null, isDragging: false });

        // Drag listeners live on view.dom.parentElement, not view.dom. The
        // editor's block drag-handle (BlockDragHandle / @tiptap/extension-
        // drag-handle) mounts its draggable container as a SIBLING of view.dom
        // — both are children of editor.view.dom.parentElement. dragstart
        // events on the chrome container bubble UP toward parentElement; they
        // never reach view.dom, which is sibling, not ancestor.
        //
        // Listening on parentElement in CAPTURE phase catches:
        //  - chrome drags (grip-initiated block reorder) — originate at the
        //    sibling container and bubble through parentElement.
        //  - view.dom-internal drags (draggable images, NodeView wrappers) —
        //    originate inside view.dom and bubble through parentElement.
        // NodeView wrappers can still set pmViewDesc.stopEvent for drag
        // events, which short-circuits PM's handleDOMEvents chain — capture
        // phase on the parentElement fires BEFORE any descendant handler.
        //
        // Falls back to view.dom when parentElement is null (during editor
        // teardown / a few intermediate mount states); the fallback preserves
        // pre-existing behavior rather than dropping the listener entirely.
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

/** Exported pure helper — exported so `selection-state-plugin.test.ts` can
 *  assert the full key list without exercising the keydown handler. The
 *  branching here determines which keys tag the pending origin as
 *  `'keyboard'`; a future refactor that drops e.g. PageUp/PageDown would
 *  regress origin classification silently, and the E2E test only exercises
 *  ArrowDown. */
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

/**
 * Dispatch a meta-only transaction to force PM to re-run `apply` so the
 * plugin state reflects the latest runtime (e.g. after dragstart/dragend
 * toggled `isDragging`). The tx mutates no document content — only PM's
 * tx pipeline propagates the runtime change to subscribers.
 *
 * Tagged with `SELECTION_REFRESH_META_KEY` so `computeSelectionApply` can
 * distinguish "we dispatched this to surface a runtime change" from
 * "the user did something" and not consume `pendingOrigin` on these
 * passes.
 *
 * Note: this is the ONE intentional case where the plugin dispatches a tx.
 * The plugin remains read-only with respect to the PM doc; the
 * dispatch is a meta-only signal carrier, not a doc
 * mutation.
 */
function scheduleRefresh(editor: Editor): void {
  // The dragstart/dragend may fire during PM's internal event processing.
  // Deferring to the next microtask ensures we don't dispatch mid-tr.
  queueMicrotask(() => {
    // Pre-check inside the microtask (not before enqueue): destruction can
    // happen between enqueue and execution. Matches the TipTap community
    // idiom for extensions that dispatch async (ueberdosis/tiptap#3798).
    if (editor.isDestroyed) return;
    try {
      const tr = editor.state.tr.setMeta(SELECTION_REFRESH_META_KEY, true);
      editor.view.dispatch(tr);
    } catch {
      // Defense-in-depth for the race window between `isDestroyed` check
      // and `dispatch` execution — both can be straddled by a final
      // teardown on the event loop.
    }
  });
}
