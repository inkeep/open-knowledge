/**
 * Shared rig for the source-mode undo contract suites.
 *
 * Mounts a real CodeMirror 6 EditorView bound to a real Y.Text('source') via
 * y-codemirror.next, in either the shipped `production` wiring (sourceModeSetup
 * + yUndoManagerKeymap → the origin-aware Y.UndoManager is the only undo
 * authority) or the `legacy` wiring (codemirror `basicSetup`, whose native
 * history captures the sync plugin's remote/agent-reflecting transactions).
 * The legacy arm exists to characterize the pre-fix dual-capture behavior.
 *
 * Test-only module — not imported by production code.
 */

import { undo as cmNativeUndo } from '@codemirror/commands';
import { EditorState } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { basicSetup } from 'codemirror';
import { yCollab, yUndoManagerKeymap } from 'y-codemirror.next';
import type { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';
import { sourceModeSetup } from '../../src/editor/source-mode-setup';

export type SourceUndoWiring = 'production' | 'legacy';

// The non-binding origin a HocuspocusProvider stamps on a remote peer's update;
// mirrors the provider stand-in the ProseMirror walk-currency rig uses so the
// modeled remote write is byte-shaped like production intake.
const REMOTE_PROVIDER_ORIGIN = Object.freeze({ kind: 'source-undo-remote-provider' });

/**
 * jsdom's `Range` omits the geometry methods CodeMirror calls while measuring;
 * install no-op stubs so a headless EditorView mounts and dispatches. Idempotent.
 */
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
  /**
   * The very `Y.UndoManager` `yCollab` binds — constructed here with the same
   * `new Y.UndoManager(ytext)` expression yCollab uses by default, purely so
   * callers can read `undoStack.length` and set frame boundaries with
   * `stopCapturing()`. y-codemirror.next does not re-export `yUndoManagerFacet`
   * or `undoDepth` from its package root, so there is no other handle on it.
   */
  undoManager: Y.UndoManager;
  destroy: () => void;
}

export function mountSourceUndoEditor(opts: {
  ytext: Y.Text;
  awareness: Awareness;
  wiring: SourceUndoWiring;
  parent: HTMLElement;
}): MountedSourceUndoEditor {
  const undoManager = new Y.UndoManager(opts.ytext);
  const undoWiring =
    opts.wiring === 'production'
      ? [
          sourceModeSetup,
          yCollab(opts.ytext, opts.awareness, { undoManager }),
          keymap.of(yUndoManagerKeymap),
        ]
      : [basicSetup, yCollab(opts.ytext, opts.awareness, { undoManager })];
  const view = new EditorView({
    state: EditorState.create({ doc: opts.ytext.toString(), extensions: undoWiring }),
    parent: opts.parent,
  });
  return { view, undoManager, destroy: () => view.destroy() };
}

/**
 * Type at a position via a real CodeMirror transaction — routes through
 * y-codemirror's sync plugin into Y.Text under the local (tracked) origin,
 * exactly as a keystroke does. Appends at the document end by default.
 */
export function typeInSource(view: EditorView, text: string, at?: number): void {
  const pos = at ?? view.state.doc.length;
  view.dispatch({
    changes: { from: pos, insert: text },
    selection: { anchor: pos + text.length },
    userEvent: 'input.type',
  });
}

/**
 * Apply a remote peer / agent write to `local`'s Y.Text('source') the way a
 * provider does: replicate to a detached doc, mutate there, apply the diff back
 * under a non-binding origin. The source editor's sync plugin reflects it into
 * the buffer; the origin sits outside the Y.UndoManager's tracked set, so a
 * correct source-mode undo can never revert it.
 */
export function applyRemoteSourceEdit(local: Y.Doc, mutate: (ytext: Y.Text) => void): void {
  const remote = new Y.Doc();
  Y.applyUpdate(remote, Y.encodeStateAsUpdate(local));
  remote.transact(() => mutate(remote.getText('source')));
  const diff = Y.encodeStateAsUpdate(remote, Y.encodeStateVector(local));
  Y.applyUpdate(local, diff, REMOTE_PROVIDER_ORIGIN);
  remote.destroy();
}

/**
 * Invoke the undo command the source-mode keymap binds to Mod-z: in production
 * the y-codemirror Y.UndoManager undo; in legacy CodeMirror's native history.
 */
export function runSourceUndo(view: EditorView, wiring: SourceUndoWiring): boolean {
  if (wiring === 'production') {
    const binding = yUndoManagerKeymap.find((b) => b.key === 'Mod-z');
    return binding?.run?.(view) ?? false;
  }
  return cmNativeUndo(view);
}
