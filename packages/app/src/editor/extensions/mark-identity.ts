/**
 * markIdentityPlugin — stable IDs for PM marks without touching the schema.
 *
 * Problem: PM marks have no identity across transactions — `mark.type.create(attrs)`
 * can be called afresh anywhere in the PM pipeline, and text-node splits/merges
 * on every keystroke hand back marks whose Object identity differs from before.
 * InteractionLayer needs a stable string id to key `data-mark-id`
 * chip attributes and to fire register/deregister on mark lifecycle.
 *
 * Solution: a PM plugin maintains
 * PluginState<{ byId: Map<id, MarkInfo>, counter: number }>. On every
 * `docChanged` transaction, it carries prior IDs forward via
 * `tr.mapping` and walks the new doc to produce the updated map:
 *
 *   - already-known range that remains in the doc → keep its ID
 *   - new marked span → assign `m${++counter}` fresh ID
 *   - deleted range → ID evicted (view layer fires onDeregister)
 *
 * **Schema is NOT touched** — no mark attr added, narrowed, or removed.
 * Precedent #9 add-only schema preserved (bridgeId stored in
 * PluginState rather than schema attr).
 *
 * Pattern mirrors the existing PM plugins in `heading-anchors.ts` (decoration)
 * and `wiki-link-suggestion.ts` (PluginKey). Registration callbacks wire
 * into InteractionLayer.
 */

import type { Mark, Node as PmNode } from '@tiptap/pm/model';
import { Plugin, PluginKey } from '@tiptap/pm/state';

/**
 * Minimal shape we consume from ProseMirror's `Mapping` — a `map(pos, bias)`
 * call. Accepts `tr.mapping` (which implements `Mappable` with additional
 * methods) as well as test-shaped identity mappings.
 */
interface PositionMapper {
  map(pos: number, assoc?: number): number;
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface MarkInfo {
  /** Stable ID — `m${counter}` assigned per-editor-instance. */
  id: string;
  /** Mark type name (e.g. 'link', 'internalLink', 'wikiLink'). */
  markType: string;
  /** Mark attrs at mount time — read-only snapshot. */
  attrs: Record<string, unknown>;
  /** Inclusive start PM position. */
  from: number;
  /** Exclusive end PM position. */
  to: number;
}

interface MarkIdentityState {
  byId: Map<string, MarkInfo>;
  counter: number;
}

interface MarkIdentityPluginParams {
  /** Mark type names to track (e.g. `['link', 'wikiLink']`). */
  markTypes: string[];
  /**
   * Optional predicate run AFTER the markType filter. Allows consumers to
   * scope further — e.g. only track external-link marks, or only wiki-links
   * that resolve to an existing page. If omitted, all marks of `markTypes`
   * are tracked.
   */
  predicate?: (mark: Mark) => boolean;
  /** Called synchronously from the plugin's view update when an ID is first seen. */
  onRegister?: (info: MarkInfo) => void;
  /** Called synchronously from the plugin's view update when an ID disappears. */
  onDeregister?: (id: string) => void;
}

export const markIdentityKey = new PluginKey<MarkIdentityState>('markIdentity');

// ---------------------------------------------------------------------------
// Pure logic — testable without a live editor / plugin wiring
// ---------------------------------------------------------------------------

/** Seed state used when the plugin first initializes (no marks yet). */
export function initialMarkIdentityState(): MarkIdentityState {
  return { byId: new Map(), counter: 0 };
}

/**
 * Assign IDs to marks in the new document, carrying IDs forward from the
 * previous state through `mapping` (typically `tr.mapping`).
 *
 * Algorithm:
 *   1. Map each prev ID's (from,to) range through the mapping (with side
 *      bias) to locate where it should be in the new doc.
 *   2. Walk the new doc. For each marked text-node span, find a mapped
 *      range that (a) contains the span's start, (b) matches markType +
 *      attrs. If found, reuse the ID. Otherwise, assign a fresh ID.
 *   3. Merge contiguous same-ID spans (PM can split text nodes arbitrarily).
 *
 * Pure w.r.t. PM — only reads doc structure and `mapping.map()`. No side
 * effects; safe to call from tests with a fake mapping (`{ map: p => p }`
 * simulates an identity transformation).
 */
export function computeMarkIdentity(
  doc: PmNode,
  prev: MarkIdentityState,
  markTypeSet: Set<string>,
  predicate: ((mark: Mark) => boolean) | undefined,
  mapping?: PositionMapper,
): MarkIdentityState {
  // Step 1: map previous ranges forward.
  interface MappedRange {
    id: string;
    markType: string;
    attrs: Record<string, unknown>;
    from: number;
    to: number;
  }
  const mappedRanges: MappedRange[] = [];
  for (const info of prev.byId.values()) {
    const from = mapping ? mapping.map(info.from, -1) : info.from;
    const to = mapping ? mapping.map(info.to, 1) : info.to;
    if (to <= from) continue; // range collapsed → drop ID (will be deregistered)
    mappedRanges.push({
      id: info.id,
      markType: info.markType,
      attrs: info.attrs,
      from,
      to,
    });
  }

  // Step 2: walk new doc, match spans to mapped ranges.
  const byId = new Map<string, MarkInfo>();
  const usedIds = new Set<string>();
  let counter = prev.counter;

  doc.descendants((node, pos) => {
    if (!node.isInline || node.marks.length === 0) return;
    for (const mark of node.marks) {
      if (!markTypeSet.has(mark.type.name)) continue;
      if (predicate && !predicate(mark)) continue;

      // Try to reuse a carried-over ID.
      let reusedId: string | null = null;
      for (const range of mappedRanges) {
        if (usedIds.has(range.id)) continue;
        if (range.markType !== mark.type.name) continue;
        if (!attrsEqual(range.attrs, mark.attrs)) continue;
        // The span's start must fall within the mapped range (inclusive on
        // the start; exclusive on the end — a span starting exactly at
        // `range.to` is a DIFFERENT span that abuts the carried one).
        if (pos < range.from || pos >= range.to) continue;
        reusedId = range.id;
        break;
      }

      const id = reusedId ?? `m${++counter}`;
      usedIds.add(id);

      const spanFrom = pos;
      const spanTo = pos + node.nodeSize;

      const existing = byId.get(id);
      if (existing) {
        // Contiguous extension: PM can split a mark across multiple text
        // nodes. Merge them into a single info entry.
        existing.to = Math.max(existing.to, spanTo);
      } else {
        byId.set(id, {
          id,
          markType: mark.type.name,
          attrs: mark.attrs,
          from: spanFrom,
          to: spanTo,
        });
      }
    }
  });

  return { byId, counter };
}

/**
 * Plain-object deep equality good enough for mark attrs (which are
 * primitives / plain objects / arrays). Not a general-purpose deep-eq;
 * restricted to the shapes PM mark attrs actually use.
 */
function attrsEqual(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  for (const k of keysA) {
    const va = a[k];
    const vb = b[k];
    if (va === vb) continue;
    // Allow nested comparison for arrays / plain objects.
    if (
      typeof va === 'object' &&
      va !== null &&
      typeof vb === 'object' &&
      vb !== null &&
      attrsEqual(va as Record<string, unknown>, vb as Record<string, unknown>)
    ) {
      continue;
    }
    return false;
  }
  return true;
}

/**
 * Diff two states and invoke onRegister/onDeregister for each added/removed
 * ID. Returns the set of IDs currently active (for callers that want to
 * track lastFired). Pure — no PM access.
 */
export function diffMarkIdentity(
  prev: ReadonlySet<string>,
  next: MarkIdentityState,
  onRegister?: (info: MarkInfo) => void,
  onDeregister?: (id: string) => void,
): Set<string> {
  const nextIds = new Set(next.byId.keys());
  for (const [id, info] of next.byId) {
    if (!prev.has(id)) onRegister?.(info);
  }
  for (const id of prev) {
    if (!nextIds.has(id)) onDeregister?.(id);
  }
  return nextIds;
}

// ---------------------------------------------------------------------------
// Plugin factory
// ---------------------------------------------------------------------------

export function markIdentityPlugin(params: MarkIdentityPluginParams): Plugin<MarkIdentityState> {
  const { markTypes, predicate, onRegister, onDeregister } = params;
  const markTypeSet = new Set(markTypes);

  return new Plugin<MarkIdentityState>({
    key: markIdentityKey,
    state: {
      init(_cfg, editorState) {
        return computeMarkIdentity(
          editorState.doc,
          initialMarkIdentityState(),
          markTypeSet,
          predicate,
        );
      },
      apply(tr, prev, _oldState, newState) {
        if (!tr.docChanged) return prev;
        return computeMarkIdentity(newState.doc, prev, markTypeSet, predicate, tr.mapping);
      },
    },
    view() {
      let lastFired: Set<string> = new Set();
      return {
        update(view) {
          const next = markIdentityKey.getState(view.state);
          if (!next) return;
          lastFired = diffMarkIdentity(lastFired, next, onRegister, onDeregister);
        },
        destroy() {
          // Fire deregister for every still-active ID so consumers clean up.
          for (const id of lastFired) onDeregister?.(id);
          lastFired = new Set();
        },
      };
    },
  });
}
