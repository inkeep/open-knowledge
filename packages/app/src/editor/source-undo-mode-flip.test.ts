import type { EditorView } from '@codemirror/view';
import { FORM_WRITE_ORIGIN } from '@inkeep/open-knowledge-core';
import { beforeEach, describe, expect, test } from 'vitest';
import * as Y from 'yjs';
import { createSourceUndoFlipTracker, setSourceViewUndoFlipActive } from './source-undo-mode-flip';

const UNTRACKED_ORIGIN = Object.freeze({ kind: 'source-undo-flip-untracked' });
const FLIP_CLEAR_MARK = 'ok/source-undo/flip-clear';
const RIG_DOC_NAME = 'source-undo-flip-unit';

function makeRig() {
  const doc = new Y.Doc();
  const ytext = doc.getText('source');
  const undoManager = new Y.UndoManager(ytext);
  const tracker = createSourceUndoFlipTracker({ docName: RIG_DOC_NAME, ytext, undoManager });
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

  test('an untracked rewrite while inactive clears the stack on reactivation', () => {
    const { ytext, undoManager, tracker, trackedEdit, untrackedEdit } = makeRig();
    tracker.setSourceModeActive(true);
    trackedEdit('one');
    expect(undoManager.undoStack.length).toBe(1);

    tracker.setSourceModeActive(false);
    untrackedEdit(' rewritten');
    tracker.setSourceModeActive(true);

    expect(undoManager.undoStack.length).toBe(0);
    expect(undoManager.redoStack.length).toBe(0);
    expect(undoManager.undo()).toBe(null);
    expect(ytext.toString()).toBe('one rewritten');
  });

  test('a tracked write while inactive does not arm the reset', () => {
    const { ytext, undoManager, tracker, trackedEdit } = makeRig();
    tracker.setSourceModeActive(true);
    trackedEdit('one');

    tracker.setSourceModeActive(false);
    trackedEdit(' two');
    tracker.setSourceModeActive(true);

    expect(undoManager.undoStack.length).toBe(2);
    undoManager.undo();
    expect(ytext.toString()).toBe('one');
  });

  test('a real non-editor write surface arms the reset the same way a synthetic origin does', () => {
    const { doc, ytext, undoManager, tracker, trackedEdit } = makeRig();
    tracker.setSourceModeActive(true);
    trackedEdit('one');

    tracker.setSourceModeActive(false);
    doc.transact(() => ytext.insert(ytext.length, ' from the property panel'), FORM_WRITE_ORIGIN);
    tracker.setSourceModeActive(true);

    expect(undoManager.undoStack.length).toBe(0);
    expect(undoManager.undo()).toBe(null);
    expect(ytext.toString()).toBe('one from the property panel');
  });

  test('clearing on return drops redo along with undo', () => {
    const { ytext, undoManager, tracker, trackedEdit, untrackedEdit } = makeRig();
    tracker.setSourceModeActive(true);
    trackedEdit('one');
    undoManager.stopCapturing();
    trackedEdit(' two');
    undoManager.undo();
    expect(ytext.toString()).toBe('one');
    expect(undoManager.redoStack.length).toBe(1);

    tracker.setSourceModeActive(false);
    untrackedEdit(' rewritten');
    tracker.setSourceModeActive(true);

    expect(undoManager.redoStack.length).toBe(0);
    expect(undoManager.redo()).toBe(null);
    expect(ytext.toString()).toBe('one rewritten');
  });

  test('undo works again on text typed after a clear, and only that text', () => {
    const { ytext, undoManager, tracker, trackedEdit, untrackedEdit } = makeRig();
    tracker.setSourceModeActive(true);
    trackedEdit('one');
    tracker.setSourceModeActive(false);
    untrackedEdit(' rewritten');
    tracker.setSourceModeActive(true);

    trackedEdit(' two');
    expect(undoManager.undoStack.length).toBe(1);
    undoManager.undo();
    expect(ytext.toString()).toBe('one rewritten');

    trackedEdit(' three');
    tracker.setSourceModeActive(false);
    tracker.setSourceModeActive(true);
    expect(undoManager.undoStack.length).toBe(1);
    undoManager.undo();
    expect(ytext.toString()).toBe('one rewritten');
  });

  test('a flip with no intervening rewrite preserves the stack', () => {
    const { ytext, undoManager, tracker, trackedEdit } = makeRig();
    tracker.setSourceModeActive(true);
    trackedEdit('one');

    tracker.setSourceModeActive(false);
    tracker.setSourceModeActive(true);

    expect(undoManager.undoStack.length).toBe(1);
    undoManager.undo();
    expect(ytext.toString()).toBe('');
  });

  test('an untracked rewrite while active does not arm the reset', () => {
    const { ytext, undoManager, tracker, trackedEdit, untrackedEdit } = makeRig();
    tracker.setSourceModeActive(true);
    trackedEdit('one');
    untrackedEdit(' rewritten');

    tracker.setSourceModeActive(false);
    tracker.setSourceModeActive(true);

    expect(undoManager.undoStack.length).toBe(1);
    undoManager.undo();
    expect(ytext.toString()).toBe(' rewritten');
  });

  test('characterization: an untracked rewrite while active leaves both bursts in one undo frame', () => {
    const { ytext, undoManager, tracker, trackedEdit, untrackedEdit } = makeRig();
    tracker.setSourceModeActive(true);

    trackedEdit('one');
    untrackedEdit(' rewritten');
    trackedEdit(' two');

    expect(undoManager.undoStack.length).toBe(1);
    undoManager.undo();
    expect(ytext.toString()).toBe(' rewritten');
  });

  test('a destroyed tracker stops clearing an already-armed reset', () => {
    const { ytext, undoManager, tracker, trackedEdit, untrackedEdit } = makeRig();
    tracker.setSourceModeActive(true);
    trackedEdit('one');

    tracker.setSourceModeActive(false);
    untrackedEdit(' rewritten');
    tracker.destroy();
    tracker.setSourceModeActive(true);

    expect(undoManager.undoStack.length).toBe(1);
    undoManager.undo();
    expect(ytext.toString()).toBe(' rewritten');
  });

  test('a destroyed tracker stops arming the reset', () => {
    const { ytext, undoManager, tracker, trackedEdit, untrackedEdit } = makeRig();
    tracker.setSourceModeActive(true);
    trackedEdit('one');

    tracker.setSourceModeActive(false);
    tracker.destroy();
    untrackedEdit(' rewritten');
    tracker.setSourceModeActive(true);

    expect(undoManager.undoStack.length).toBe(1);
    undoManager.undo();
    expect(ytext.toString()).toBe(' rewritten');
  });
});

describe('setSourceViewUndoFlipActive', () => {
  test('throws when the flip extension is not installed on the view', () => {
    const view = {} as EditorView;
    expect(() => setSourceViewUndoFlipActive(view, true)).toThrow(/not installed/);
  });
});

class FakeSyncConfig {}

function makeClassOriginRig() {
  const doc = new Y.Doc();
  const ytext = doc.getText('source');
  const undoManager = new Y.UndoManager(ytext);
  undoManager.addTrackedOrigin(FakeSyncConfig);
  const tracker = createSourceUndoFlipTracker({ docName: RIG_DOC_NAME, ytext, undoManager });
  tracker.setSourceModeActive(true);
  doc.transact(() => ytext.insert(0, 'seed'));
  return { doc, ytext, undoManager, tracker };
}

describe('constructor-fallback origin classification', () => {
  test('an instance of a class-registered tracked origin does not arm the reset', () => {
    const { doc, ytext, undoManager, tracker } = makeClassOriginRig();
    expect(undoManager.undoStack.length).toBe(1);

    tracker.setSourceModeActive(false);
    doc.transact(() => ytext.insert(ytext.length, ' from ySync'), new FakeSyncConfig());
    tracker.setSourceModeActive(true);

    expect(undoManager.undoStack.length).toBeGreaterThan(0);
    undoManager.undo();
    expect(ytext.toString()).toBe('seed');
  });

  test('an instance of an unregistered class still arms the reset', () => {
    const { doc, ytext, undoManager, tracker } = makeClassOriginRig();
    expect(undoManager.undoStack.length).toBe(1);

    tracker.setSourceModeActive(false);
    doc.transact(() => ytext.insert(ytext.length, ' rewritten'), UNTRACKED_ORIGIN);
    tracker.setSourceModeActive(true);

    expect(undoManager.undoStack.length).toBe(0);
    expect(undoManager.undo()).toBe(null);
    expect(ytext.toString()).toBe('seed rewritten');
  });
});

describe('flip-clear observability mark', () => {
  beforeEach(() => {
    performance.clearMeasures(FLIP_CLEAR_MARK);
  });

  test('an armed reactivation emits the mark with the doc name', () => {
    const { ytext, tracker, trackedEdit, untrackedEdit } = makeRig();
    tracker.setSourceModeActive(true);
    trackedEdit('one');

    tracker.setSourceModeActive(false);
    untrackedEdit(' rewritten');
    tracker.setSourceModeActive(true);

    expect(ytext.toString()).toBe('one rewritten');
    expect(performance.getEntriesByName(FLIP_CLEAR_MARK)).toHaveLength(1);
  });

  test('an unarmed peek emits nothing', () => {
    const { tracker, trackedEdit } = makeRig();
    tracker.setSourceModeActive(true);
    trackedEdit('one');

    tracker.setSourceModeActive(false);
    tracker.setSourceModeActive(true);

    expect(performance.getEntriesByName(FLIP_CLEAR_MARK)).toHaveLength(0);
  });
});
