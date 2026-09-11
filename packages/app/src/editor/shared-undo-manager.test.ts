import { beforeEach, describe, expect, test } from 'vitest';
import * as Y from 'yjs';
import { PROJECTION_WRITE_ORIGIN, sharedUndoManagerFor } from './shared-undo-manager';

const REMOTE_ORIGIN = Object.freeze({ kind: 'shared-undo-remote-provider' });
const FULL_REPLACE_CLEAR_MARK = 'ok/undo/full-replace-clear';

function makeRig(seed = '') {
  const doc = new Y.Doc();
  const ytext = doc.getText('source');
  if (seed) doc.transact(() => ytext.insert(0, seed), REMOTE_ORIGIN);
  const undoManager = sharedUndoManagerFor(ytext);
  const remote = (mutate: (text: Y.Text) => void) => {
    const peer = new Y.Doc();
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc));
    peer.transact(() => mutate(peer.getText('source')));
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(peer, Y.encodeStateVector(doc)), REMOTE_ORIGIN);
    peer.destroy();
  };
  const local = (mutate: (text: Y.Text) => void, origin: unknown = PROJECTION_WRITE_ORIGIN) => {
    undoManager.stopCapturing();
    doc.transact(() => mutate(ytext), origin);
  };
  return { doc, ytext, undoManager, remote, local };
}

describe('sharedUndoManagerFor: an untracked whole-text replacement', () => {
  beforeEach(() => {
    performance.clearMeasures(FULL_REPLACE_CLEAR_MARK);
  });

  test('a peer inserting elsewhere leaves your history undoable', () => {
    const { ytext, undoManager, remote, local } = makeRig('one\n\ntwo\n');
    local((t) => t.insert(3, ' mine'));
    remote((t) => t.insert(t.length, 'PEER\n'));

    expect(undoManager.undoStack.length).toBe(1);
    undoManager.undo();
    expect(ytext.toString()).toBe('one\n\ntwo\nPEER\n');
  });

  test('a peer deleting elsewhere leaves your history undoable', () => {
    const { ytext, undoManager, remote, local } = makeRig('one\n\ntwo\n');
    local((t) => t.insert(3, ' mine'));
    remote((t) => t.delete(t.toString().indexOf('two'), 3));

    expect(undoManager.undoStack.length).toBe(1);
    undoManager.undo();
    expect(ytext.toString()).toBe('one\n\n\n');
  });

  test('clears undo and redo', () => {
    const { ytext, undoManager, remote, local } = makeRig('one\n\ntwo\n');
    local((t) => t.insert(3, ' a'));
    local((t) => t.insert(5, ' b'));
    undoManager.undo();
    expect(undoManager.redoStack.length).toBe(1);

    remote((t) => {
      t.delete(0, t.length);
      t.insert(0, 'rewritten\n');
    });

    expect(undoManager.undoStack.length).toBe(0);
    expect(undoManager.redoStack.length).toBe(0);
    expect(ytext.toString()).toBe('rewritten\n');
  });

  test('undo cannot put text you deleted back into a document someone else rewrote', () => {
    const { ytext, undoManager, remote, local } = makeRig('Seed paragraph one.\n\ntwo\n');
    local((t) => t.delete(t.toString().indexOf(' one.'), 5));
    remote((t) => {
      t.delete(0, t.length);
      t.insert(0, 'Agent rewrote paragraph one.\n\ntwo\n');
    });

    expect(undoManager.undo()).toBe(null);
    expect(ytext.toString()).toBe('Agent rewrote paragraph one.\n\ntwo\n');
  });

  test('your own whole-text replacement is an ordinary undo step', () => {
    const { ytext, undoManager, local } = makeRig('one\n');
    local((t) => t.insert(3, ' a'));
    local((t) => {
      t.delete(0, t.length);
      t.insert(0, 'pasted over everything\n');
    }, null);

    expect(undoManager.undoStack.length).toBe(2);
    undoManager.undo();
    expect(ytext.toString()).toBe('one a\n');
  });

  test('a replacement under a class-registered tracked origin does not clear', () => {
    class FakeSyncConfig {}
    const { ytext, undoManager, doc, local } = makeRig('one\n');
    undoManager.addTrackedOrigin(FakeSyncConfig);
    local((t) => t.insert(3, ' a'));
    undoManager.stopCapturing();
    doc.transact(() => {
      ytext.delete(0, ytext.length);
      ytext.insert(0, 'replaced\n');
    }, new FakeSyncConfig());

    expect(undoManager.undoStack.length).toBe(2);
  });

  test('a remote insert into an empty text does not clear', () => {
    const { undoManager, remote, local } = makeRig('one\n');
    local((t) => t.delete(0, t.length));
    remote((t) => t.insert(0, 'peer typed into the empty doc\n'));

    expect(undoManager.undoStack.length).toBe(1);
  });

  test('emits the clear mark once, and nothing for a partial remote edit', () => {
    const { remote, local } = makeRig('one\n\ntwo\n');
    local((t) => t.insert(3, ' a'));
    remote((t) => t.insert(0, 'PEER '));
    expect(performance.getEntriesByName(FULL_REPLACE_CLEAR_MARK)).toHaveLength(0);

    remote((t) => {
      t.delete(0, t.length);
      t.insert(0, 'rewritten\n');
    });
    expect(performance.getEntriesByName(FULL_REPLACE_CLEAR_MARK)).toHaveLength(1);
  });
});
