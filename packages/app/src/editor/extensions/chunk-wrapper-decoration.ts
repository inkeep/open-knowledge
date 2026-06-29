
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { mark } from '@/lib/perf';

export const chunkWrapperDecorationKey = new PluginKey('chunkWrapperDecoration');

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

export function chunkWrapperDecorationPlugin(): Plugin {
  if (!cvAutoSupported) {
    return new Plugin({ key: chunkWrapperDecorationKey });
  }
  return new Plugin({
    key: chunkWrapperDecorationKey,
    props: {
      decorations(state) {
        const decos: Decoration[] = [];
        state.doc.forEach((node, pos) => {
          if (node.isInline) return;
          if (node.type.name === 'jsxComponent') return;
          decos.push(
            Decoration.node(pos, pos + node.nodeSize, {
              class: OK_CHUNK_WRAPPER_CLASS,
            }),
          );
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
