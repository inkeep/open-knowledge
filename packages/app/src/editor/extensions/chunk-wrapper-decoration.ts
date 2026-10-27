/**
 * None supports "wrap N consecutive sibling nodes in a shared parent without touching schema."
 * Slate-based editors like Plate use a structural-node chunking model; PM forbids that without a
 * schema change (precedent #9 add-only).
 */

import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { mark } from '@/lib/perf';

export const chunkWrapperDecorationKey = new PluginKey('chunkWrapperDecoration');

export const OK_CHUNK_WRAPPER_CLASS = 'ok-chunk-wrapper';

const CHUNK_WRAPPER_ATTRS = { class: OK_CHUNK_WRAPPER_CLASS };

const SELECTION_BLOCK_ATTRS = { ...CHUNK_WRAPPER_ATTRS, 'data-ok-selection-block': '' };

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

export function chunkWrapperDecorationPlugin(): Plugin {
  if (!cvAutoSupported) {
    return new Plugin({ key: chunkWrapperDecorationKey });
  }
  return new Plugin({
    key: chunkWrapperDecorationKey,
    props: {
      decorations(state) {
        const selectionStartIndex = state.selection.$from.index(0);
        const selectionEndIndex = state.selection.$to.index(0);
        const decos: Decoration[] = [];
        state.doc.forEach((node, pos, index) => {
          if (node.isInline) return;
          if (node.type.name === 'jsxComponent') return;
          const holdsSelection = index === selectionStartIndex || index === selectionEndIndex;
          const attrs = holdsSelection ? SELECTION_BLOCK_ATTRS : CHUNK_WRAPPER_ATTRS;
          decos.push(Decoration.node(pos, pos + node.nodeSize, attrs));
        });
        if (decos.length === 0) return null;
        if (!firstEmitFired) {
          firstEmitFired = true;
          mark(
            'ok/render/cv-auto-skip',
            { chunkCount: decos.length },
            { startTime: performance.now(), duration: 0 },
          );
        }
        return DecorationSet.create(state.doc, decos);
      },
    },
  });
}
