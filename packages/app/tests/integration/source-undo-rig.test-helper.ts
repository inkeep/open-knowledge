import { undo as cmNativeUndo } from '@codemirror/commands';
import { EditorState } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { basicSetup } from 'codemirror';
import { yCollab, yUndoManagerKeymap } from 'y-codemirror.next';
import type { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';
import { sourceModeSetup } from '../../src/editor/source-mode-setup';
import {
  createSourceUndoFlipExtension,
  setSourceViewUndoFlipActive,
} from '../../src/editor/source-undo-mode-flip';

export type SourceUndoWiring = 'production' | 'legacy';

const REMOTE_PROVIDER_ORIGIN = Object.freeze({ kind: 'source-undo-remote-provider' });

export function installCmMeasurementStubs(): void {
  const rangeProto = globalThis.Range?.prototype as Range | undefined;
  if (!rangeProto) return;
  Object.defineProperty(rangeProto, 'getClientRects', {
    configurable: true,
    value: () => [] as unknown as DOMRectList,
  });
  Object.defineProperty(rangeProto, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({
      bottom: 0,
      height: 0,
      left: 0,
      right: 0,
      top: 0,
      width: 0,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }),
  });
}

export interface MountedSourceUndoEditor {
  view: EditorView;
  undoManager: Y.UndoManager;
  setSourceModeActive: (active: boolean) => void;
  destroy: () => void;
}

export function mountSourceUndoEditor(opts: {
  docName?: string;
  ytext: Y.Text;
  awareness?: Awareness;
  wiring: SourceUndoWiring;
  parent: HTMLElement;
}): MountedSourceUndoEditor {
  if (opts.wiring === 'production' && !opts.awareness) {
    throw new Error(
      'mountSourceUndoEditor({ wiring: "production" }) requires awareness: yCollab drops yRemoteSelections without it, so the mount would install a smaller extension set than SourceEditor.tsx',
    );
  }
  const undoManager = new Y.UndoManager(opts.ytext);
  const undoWiring =
    opts.wiring === 'production'
      ? [
          sourceModeSetup,
          yCollab(opts.ytext, opts.awareness, { undoManager }),
          keymap.of(yUndoManagerKeymap),
          createSourceUndoFlipExtension({
            docName: opts.docName ?? 'source-undo-rig',
            ytext: opts.ytext,
            undoManager,
          }),
        ]
      : [basicSetup, yCollab(opts.ytext, opts.awareness, { undoManager })];
  const view = new EditorView({
    state: EditorState.create({ doc: opts.ytext.toString(), extensions: undoWiring }),
    parent: opts.parent,
  });
  const setSourceModeActive = (active: boolean) => {
    if (opts.wiring !== 'production') return;
    setSourceViewUndoFlipActive(view, active);
  };
  setSourceModeActive(true);
  return {
    view,
    undoManager,
    setSourceModeActive,
    destroy: () => view.destroy(),
  };
}

export function typeInSource(view: EditorView, text: string, at?: number): void {
  const pos = at ?? view.state.doc.length;
  view.dispatch({
    changes: { from: pos, insert: text },
    selection: { anchor: pos + text.length },
    userEvent: 'input.type',
  });
}

export function applyRemoteSourceEdit(local: Y.Doc, mutate: (ytext: Y.Text) => void): void {
  const remote = new Y.Doc();
  Y.applyUpdate(remote, Y.encodeStateAsUpdate(local));
  remote.transact(() => mutate(remote.getText('source')));
  const diff = Y.encodeStateAsUpdate(remote, Y.encodeStateVector(local));
  Y.applyUpdate(local, diff, REMOTE_PROVIDER_ORIGIN);
  remote.destroy();
}

export function runSourceUndo(view: EditorView, wiring: SourceUndoWiring): boolean {
  if (wiring === 'production') {
    const binding = yUndoManagerKeymap.find((b) => b.key === 'Mod-z');
    if (!binding?.run) throw new Error('yUndoManagerKeymap no longer binds Mod-z');
    return binding.run(view);
  }
  return cmNativeUndo(view);
}
