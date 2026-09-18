/**
 * None supports "wrap N consecutive sibling nodes in a shared parent without touching schema."
 * Slate-based editors like Plate use a structural-node chunking model; PM forbids that without a
 * schema change (precedent #9 add-only).
 */

import type { Node as PmNode } from '@tiptap/pm/model';
import { Plugin, PluginKey, type Transaction } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { mark } from '@/lib/perf';

export const chunkWrapperDecorationKey = new PluginKey<DecorationSet>('chunkWrapperDecoration');

export const OK_CHUNK_WRAPPER_CLASS = 'ok-chunk-wrapper';

let firstEmitFired = false;

export function __resetFirstEmitForTesting(): void {
  firstEmitFired = false;
}

function supportsContentVisibilityAuto(): boolean {
  if (typeof globalThis.CSS === 'undefined' || typeof globalThis.CSS.supports !== 'function') {
    return true;
  }
  return globalThis.CSS.supports('content-visibility', 'auto');
}

const cvAutoSupported = supportsContentVisibilityAuto();

function wrapperFor(node: PmNode, pos: number): Decoration | null {
  if (node.isInline) return null;
  if (node.type.name === 'jsxComponent') return null;
  return Decoration.node(pos, pos + node.nodeSize, { class: OK_CHUNK_WRAPPER_CLASS });
}

function wrapAll(doc: PmNode): DecorationSet {
  const decos: Decoration[] = [];
  doc.forEach((node, pos) => {
    const wrapper = wrapperFor(node, pos);
    if (wrapper !== null) decos.push(wrapper);
  });
  if (decos.length === 0) return DecorationSet.empty;
  if (!firstEmitFired) {
    firstEmitFired = true;
    mark(
      'ok/render/cv-auto-skip',
      { chunkCount: decos.length },
      { startTime: performance.now(), duration: 0 },
    );
  }
  return DecorationSet.create(doc, decos);
}

interface ChangedRange {
  from: number;
  to: number;
}

function changedRanges(tr: Transaction): ChangedRange[] {
  const ranges: ChangedRange[] = [];
  const { maps } = tr.mapping;
  maps.forEach((map, index) => {
    const later = maps.slice(index + 1);
    map.forEach((_oldStart, _oldEnd, newStart, newEnd) => {
      let from = newStart;
      let to = newEnd;
      for (const step of later) {
        from = step.map(from, -1);
        to = step.map(to, 1);
      }
      ranges.push({ from, to });
    });
  });
  return ranges;
}

/* STOP: rebuilding every block's wrapper on each state makes a keystroke cost the whole
   document, in the build and again in the view's decoration diff. The set is mapped instead,
   and only the top-level blocks a step touched are rewrapped -- including their neighbours,
   since a join or split changes a neighbour's bounds without touching its text. */
function rewrap(set: DecorationSet, tr: Transaction): DecorationSet {
  const doc = tr.doc;
  const size = doc.content.size;
  let next = set.map(tr.mapping, doc);
  for (const range of changedRanges(tr)) {
    let start = -1;
    let end = -1;
    const fresh: Decoration[] = [];
    doc.nodesBetween(Math.max(0, range.from - 1), Math.min(size, range.to + 1), (node, pos) => {
      if (start < 0) start = pos;
      end = pos + node.nodeSize;
      const wrapper = wrapperFor(node, pos);
      if (wrapper !== null) fresh.push(wrapper);
      return false;
    });
    if (start < 0) continue;
    const stale = next.find(start, end).filter((deco) => deco.from >= start && deco.to <= end);
    next = next.remove(stale).add(doc, fresh);
  }
  return next;
}

export function chunkWrapperDecorationPlugin(): Plugin {
  if (!cvAutoSupported) {
    return new Plugin({ key: chunkWrapperDecorationKey });
  }
  return new Plugin<DecorationSet>({
    key: chunkWrapperDecorationKey,
    state: {
      init: (_config, state) => wrapAll(state.doc),
      apply: (tr, set) => (tr.docChanged ? rewrap(set, tr) : set),
    },
    props: {
      decorations(state) {
        const set = chunkWrapperDecorationKey.getState(state);
        return set === undefined || set === DecorationSet.empty ? null : set;
      },
    },
  });
}
