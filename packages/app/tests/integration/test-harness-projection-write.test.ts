import { describe, expect, test } from 'vitest';
import * as Y from 'yjs';
import {
  PROJECTION_WRITE_ORIGIN,
  sharedUndoManagerFor,
} from '../../src/editor/shared-undo-manager';
import { applyProjectionEdit } from './test-harness';

const REMOTE_ORIGIN = Object.freeze({ kind: 'harness-projection-write-remote' });

function seeded(seed: string) {
  const doc = new Y.Doc();
  const ytext = doc.getText('source');
  doc.transact(() => ytext.insert(0, seed), REMOTE_ORIGIN);
  const deltas: unknown[] = [];
  ytext.observe((event) => deltas.push(event.delta));
  return { doc, ytext, deltas };
}

function endOfBlock(doc: { child: (i: number) => { nodeSize: number } }, index: number): number {
  let pos = 0;
  for (let i = 0; i < index; i++) pos += doc.child(i).nodeSize;
  return pos + doc.child(index).nodeSize - 1;
}

describe('the integration harness writes projection edits the way the binding does', () => {
  test('an append at a paragraph end writes only the appended characters', () => {
    const target = seeded('hello bug');
    applyProjectionEdit(target, (tr, doc) => tr.insertText(' visual', endOfBlock(doc, 0)));

    expect(target.ytext.toString()).toBe('hello bug visual');
    expect(target.deltas).toEqual([[{ retain: 9 }, { insert: ' visual' }]]);
  });

  test('an edit in the second paragraph leaves the first paragraph untouched', () => {
    const target = seeded('one\n\ntwo');
    applyProjectionEdit(target, (tr, doc) => tr.insertText('X', endOfBlock(doc, 1)));

    expect(target.ytext.toString()).toBe('one\n\ntwoX');
    expect(target.deltas).toEqual([[{ retain: 8 }, { insert: 'X' }]]);
  });

  test('undoing a harness edit leaves a peer insert at the edge of that block in place', () => {
    const target = seeded('');
    const undoManager = sharedUndoManagerFor(target.ytext);
    target.doc.transact(() => target.ytext.insert(0, 'hello bug'));
    undoManager.stopCapturing();
    applyProjectionEdit(
      target,
      (tr, doc) => tr.insertText(' visual', endOfBlock(doc, 0)),
      PROJECTION_WRITE_ORIGIN,
    );
    undoManager.stopCapturing();

    const peer = new Y.Doc();
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(target.doc));
    peer.transact(() => peer.getText('source').insert(0, 'PEER '));
    Y.applyUpdate(
      target.doc,
      Y.encodeStateAsUpdate(peer, Y.encodeStateVector(target.doc)),
      REMOTE_ORIGIN,
    );
    expect(target.ytext.toString()).toBe('PEER hello bug visual');

    undoManager.undo();
    expect(target.ytext.toString()).toBe('PEER hello bug');
  });
});
