import type { EditorView } from '@codemirror/view';
import { describe, expect, test } from 'vitest';
import * as Y from 'yjs';
import { createSourceUndoFlipTracker, setSourceViewUndoFlipActive } from './source-undo-mode-flip';

const UNTRACKED_ORIGIN = Object.freeze({ kind: 'source-undo-flip-untracked' });

function makeRig() {
  const doc = new Y.Doc();
  const ytext = doc.getText('source');
  const undoManager = new Y.UndoManager(ytext);
  const tracker = createSourceUndoFlipTracker({ undoManager });
  const trackedEdit = (text: string) => doc.transact(() => ytext.insert(ytext.length, text));
  const untrackedEdit = (text: string) =>
    doc.transact(() => ytext.insert(ytext.length, text), UNTRACKED_ORIGIN);
  return { doc, ytext, undoManager, tracker, trackedEdit, untrackedEdit };
}

describe('createSourceUndoFlipTracker', () => {
  test('deactivating source mode seals the capture window', () => {
    const { ytext, undoManager, tracker, trackedEdit } = makeRig();
    tracker.setSourceModeActive(true);

    trackedEdit('one');
    tracker.setSourceModeActive(false);
    trackedEdit('two');

    expect(undoManager.undoStack.length).toBe(2);
    undoManager.undo();
    expect(ytext.toString()).toBe('one');
  });

  test('an untracked write while inactive leaves the stack for the return', () => {
    const { ytext, undoManager, tracker, trackedEdit, untrackedEdit } = makeRig();
    tracker.setSourceModeActive(true);
    trackedEdit('one');

    tracker.setSourceModeActive(false);
    untrackedEdit(' peer');
    tracker.setSourceModeActive(true);

    expect(undoManager.undoStack.length).toBe(1);
    undoManager.undo();
    expect(ytext.toString()).toBe(' peer');
  });

  test('a flip with no intervening write preserves the stack', () => {
    const { ytext, undoManager, tracker, trackedEdit } = makeRig();
    tracker.setSourceModeActive(true);
    trackedEdit('one');

    tracker.setSourceModeActive(false);
    tracker.setSourceModeActive(true);

    expect(undoManager.undoStack.length).toBe(1);
    undoManager.undo();
    expect(ytext.toString()).toBe('');
  });

  test('a destroyed tracker stops sealing', () => {
    const { undoManager, tracker, trackedEdit } = makeRig();
    tracker.setSourceModeActive(true);
    trackedEdit('one');

    tracker.destroy();
    tracker.setSourceModeActive(false);
    trackedEdit('two');

    expect(undoManager.undoStack.length).toBe(1);
  });
});

describe('setSourceViewUndoFlipActive', () => {
  test('throws when the flip extension is not installed on the view', () => {
    const view = {} as EditorView;
    expect(() => setSourceViewUndoFlipActive(view, true)).toThrow(/not installed/);
  });
});
