import type { Mark, Node as PmNode } from '@tiptap/pm/model';
import { Plugin, PluginKey } from '@tiptap/pm/state';

interface PositionMapper {
  map(pos: number, assoc?: number): number;
}

export interface MarkInfo {
  id: string;
  markType: string;
  attrs: Record<string, unknown>;
  from: number;
  to: number;
}

interface MarkIdentityState {
  byId: Map<string, MarkInfo>;
  counter: number;
}

interface MarkIdentityPluginParams {
  markTypes: string[];
  predicate?: (mark: Mark) => boolean;
  onRegister?: (info: MarkInfo) => void;
  onDeregister?: (id: string) => void;
}

export const markIdentityKey = new PluginKey<MarkIdentityState>('markIdentity');

export function initialMarkIdentityState(): MarkIdentityState {
  return { byId: new Map(), counter: 0 };
}

export function computeMarkIdentity(
  doc: PmNode,
  prev: MarkIdentityState,
  markTypeSet: Set<string>,
  predicate: ((mark: Mark) => boolean) | undefined,
  mapping?: PositionMapper,
): MarkIdentityState {
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

  const byId = new Map<string, MarkInfo>();
  const usedIds = new Set<string>();
  let counter = prev.counter;

  doc.descendants((node, pos) => {
    if (!node.isInline || node.marks.length === 0) return;
    for (const mark of node.marks) {
      if (!markTypeSet.has(mark.type.name)) continue;
      if (predicate && !predicate(mark)) continue;

      let reusedId: string | null = null;
      for (const range of mappedRanges) {
        if (usedIds.has(range.id)) continue;
        if (range.markType !== mark.type.name) continue;
        if (!attrsEqual(range.attrs, mark.attrs)) continue;
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

function attrsEqual(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  for (const k of keysA) {
    const va = a[k];
    const vb = b[k];
    if (va === vb) continue;
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
          for (const id of lastFired) onDeregister?.(id);
          lastFired = new Set();
        },
      };
    },
  });
}
