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

      insertLocal(editor, 'USER TYPED CONTENT', 1);
      expect(editor.state.doc.textContent).toContain('USER TYPED CONTENT');
      const stackBefore = um.undoStack.length;
      expect(stackBefore).toBeGreaterThan(0);

      applyRollback(ydoc, '# Rolled Back\n\nrestored body\n');
      const captured = editor.state.doc.textContent;
      const stackAfterRollback = um.undoStack.length;

      expect(captured).toContain('restored body');
      expect(captured).not.toContain('USER TYPED CONTENT');
      expect(stackAfterRollback).toBe(stackBefore);

      um.undo();
      const afterUndo = editor.state.doc.textContent;
      expect(afterUndo).toContain('restored body');
      expect(afterUndo).not.toContain('USER TYPED CONTENT');
      expect(afterUndo.trim().length).toBeGreaterThan(0);
      expect(countOccurrences(afterUndo, 'restored body')).toBe(1);
      expect(ydoc.getText('source').toString()).toContain('restored body');
      expect(ydoc.getText('source').toString()).not.toContain('USER TYPED CONTENT');

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
