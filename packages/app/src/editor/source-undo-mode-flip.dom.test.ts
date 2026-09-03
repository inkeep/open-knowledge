import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { afterEach, describe, expect, test } from 'vitest';
import * as Y from 'yjs';
import {
  createSourceUndoFlipExtension,
  setSourceViewUndoFlipActive,
} from './source-undo-mode-flip';

Object.defineProperty(window.Range.prototype, 'getClientRects', {
  configurable: true,
  value: () => [],
});
Object.defineProperty(window.Range.prototype, 'getBoundingClientRect', {
  configurable: true,
  value: () => ({ bottom: 0, height: 0, left: 0, right: 0, top: 0, width: 0 }),
});

const UNTRACKED_ORIGIN = Object.freeze({ kind: 'source-undo-flip-dom-untracked' });

interface Rig {
  doc: Y.Doc;
  ytext: Y.Text;
  undoManager: Y.UndoManager;
  view: EditorView;
  parent: HTMLElement;
}

const rigs: Rig[] = [];

function mountRig(): Rig {
  const doc = new Y.Doc();
  const ytext = doc.getText('source');
  const undoManager = new Y.UndoManager(ytext);
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  const view = new EditorView({
    state: EditorState.create({
      extensions: [
        createSourceUndoFlipExtension({ docName: 'source-undo-flip-dom', ytext, undoManager }),
      ],
    }),
    parent,
  });
  const rig = { doc, ytext, undoManager, view, parent };
  rigs.push(rig);
  return rig;
}

afterEach(() => {
  for (const rig of rigs.splice(0)) {
    try {
      rig.view.destroy();
    } catch {}
    rig.parent.remove();
    rig.doc.destroy();
  }
});

describe('createSourceUndoFlipExtension plugin lifecycle', () => {
  test('the view plugin registers a tracker the accessor can reach', () => {
    const { doc, ytext, undoManager, view } = mountRig();
    setSourceViewUndoFlipActive(view, true);
    doc.transact(() => ytext.insert(0, 'one'));
    expect(undoManager.undoStack.length).toBe(1);

    setSourceViewUndoFlipActive(view, false);
    doc.transact(() => ytext.insert(ytext.length, ' rewritten'), UNTRACKED_ORIGIN);
    setSourceViewUndoFlipActive(view, true);

    expect(undoManager.undoStack.length).toBe(0);
  });

  test('a destroyed view stops arming, so a later reactivation keeps the stack', () => {
    const { doc, ytext, undoManager, view } = mountRig();
    setSourceViewUndoFlipActive(view, true);
    doc.transact(() => ytext.insert(0, 'one'));
    expect(undoManager.undoStack.length).toBe(1);

    setSourceViewUndoFlipActive(view, false);
    view.destroy();

    doc.transact(() => ytext.insert(ytext.length, ' rewritten'), UNTRACKED_ORIGIN);
    setSourceViewUndoFlipActive(view, true);

    expect(undoManager.undoStack.length).toBe(1);
    undoManager.undo();
    expect(ytext.toString()).toBe(' rewritten');
  });
});
