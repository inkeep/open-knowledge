/**
 * CONTRACT — client UndoManager behavior when a timeline restore/rollback lands.
 *
 * Pins the ratified undo topology: a server rollback reaches the client as a
 * remote paired write. Production rollback is `replaceRawBody` (one of the
 * three sibling bridge-intake primitives): Y.Text delete(0,len)+insert(0,md)
 * then `updateYFragment` re-derive, all wrapped in a single
 * `document.transact(..., ROLLBACK_ORIGIN)`. That origin's `context.origin`
 * is `'rollback-apply'` — NOT `ySyncPluginKey` — so the client fragment-space
 * `Y.UndoManager` (trackedOrigins {ySyncPluginKey}) sees it as an untracked,
 * remote-shaped transaction. Consequence: the rollback is not Cmd+Z-undoable,
 * and a pre-rollback stack item cannot recover the content the rollback
 * discarded. This is deliberate (precedent #38; the choice is documented at
 * the `handleRollback` catch region in `api-extension.ts`).
 *
 * A behavior flip here is an undo-topology regression to investigate, not a
 * test to silently re-baseline.
 *
 */

import { ROLLBACK_ORIGIN } from '@inkeep/open-knowledge-server';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import * as Y from 'yjs';

import { replaceRawBody } from '../../../server/src/bridge-intake.ts';
import {
  insertLocal,
  mountCollabEditor,
  readUndoManager,
} from '../../src/editor/editor-rig.test-helper';
import { installDomGlobals } from '../../src/editor/walk-currency-test-harness';

let restoreDom: (() => void) | null = null;
beforeAll(() => {
  restoreDom = installDomGlobals();
}, 30_000);
afterAll(() => {
  restoreDom?.();
});

/**
 * The server rollback paired write, landing on the client's ydoc through the
 * PRODUCTION spine: `replaceRawBody` (the bridge-intake sibling primitive
 * `handleRollback` calls) wrapped in the caller's transact under the real
 * exported `ROLLBACK_ORIGIN`. Hand-reproducing the primitive would model the
 * wire shape while leaving a drift in either free to go unnoticed.
 */
function applyRollback(ydoc: Y.Doc, targetMarkdown: string): void {
  ydoc.transact(() => {
    replaceRawBody(ydoc, targetMarkdown);
  }, ROLLBACK_ORIGIN);
}

function countOccurrences(hay: string, needle: string): number {
  let n = 0;
  let i = hay.indexOf(needle);
  while (i !== -1) {
    n++;
    i = hay.indexOf(needle, i + needle.length);
  }
  return n;
}

describe('client UndoManager under a timeline rollback', () => {
  test('rollback is not undoable and a pre-rollback stack item does not recover discarded content', () => {
    const ydoc = new Y.Doc();
    const editor = mountCollabEditor(ydoc, []);
    try {
      const um = readUndoManager(editor) as Y.UndoManager;
      expect(um).not.toBeNull();

      // User types — captured on the client UM.
      insertLocal(editor, 'USER TYPED CONTENT', 1);
      expect(editor.state.doc.textContent).toContain('USER TYPED CONTENT');
      const stackBefore = um.undoStack.length;
      expect(stackBefore).toBeGreaterThan(0);

      // A timeline restore lands (server → remote paired write).
      applyRollback(ydoc, '# Rolled Back\n\nrestored body\n');
      const captured = editor.state.doc.textContent;
      const stackAfterRollback = um.undoStack.length;

      // The rollback landed and replaced the visible content.
      expect(captured).toContain('restored body');
      expect(captured).not.toContain('USER TYPED CONTENT');
      // The rollback itself was NOT captured as an undoable item: the untracked
      // origin left the stack exactly where the user's typing put it.
      expect(stackAfterRollback).toBe(stackBefore);

      // Cmd+Z after the rollback. Every assertion below re-reads state AFTER
      // the call — the second clause of this test's title lives here, and a
      // snapshot taken before `undo()` cannot observe it.
      um.undo();
      const afterUndo = editor.state.doc.textContent;
      // Not undoable: the restore is still what the user sees.
      expect(afterUndo).toContain('restored body');
      // The pre-rollback stack item did not recover the content the rollback
      // discarded — the clause that was previously unasserted.
      expect(afterUndo).not.toContain('USER TYPED CONTENT');
      // Nor did it wipe the document, nor splice a second copy in.
      expect(afterUndo.trim().length).toBeGreaterThan(0);
      expect(countOccurrences(afterUndo, 'restored body')).toBe(1);
      // The UM is FRAGMENT-scoped: the undo cannot have rewritten Y.Text, so
      // the restored source bytes are untouched (Y.Text-is-truth, precedent #38).
      expect(ydoc.getText('source').toString()).toContain('restored body');
      expect(ydoc.getText('source').toString()).not.toContain('USER TYPED CONTENT');

      // Cmd+Shift+Z. A redo of a no-op undo is itself a no-op — it must not
      // become a back door that re-applies the discarded typing.
      um.redo();
      const afterRedo = editor.state.doc.textContent;
      expect(afterRedo).toBe(afterUndo);
      expect(afterRedo).not.toContain('USER TYPED CONTENT');
      expect(countOccurrences(afterRedo, 'restored body')).toBe(1);
    } finally {
      editor.destroy();
    }
  });
});
