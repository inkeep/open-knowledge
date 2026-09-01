import type { EditorView } from '@tiptap/pm/view';
import { afterAll, beforeAll, expect, test } from 'vitest';
import * as Y from 'yjs';
import { mountCollabEditor, readUndoManager } from './editor-rig.test-helper';
import { dispatchAsOwnUndoStep } from './undo-isolation';
import { installDomGlobals } from './walk-currency-test-harness';

let restoreDomGlobals: (() => void) | null = null;

beforeAll(() => {
  restoreDomGlobals = installDomGlobals();
});

afterAll(() => {
  restoreDomGlobals?.();
  restoreDomGlobals = null;
});

test('a throwing dispatch still closes the capture (stopCapturing runs twice)', () => {
  const ydoc = new Y.Doc();
  const editor = mountCollabEditor(ydoc, []);
  try {
    const undoManager = readUndoManager(editor);
    expect(undoManager).not.toBeNull();
    if (!undoManager) return;

    let stops = 0;
    const originalStop = undoManager.stopCapturing.bind(undoManager);
    undoManager.stopCapturing = () => {
      stops++;
      originalStop();
    };

    const throwingView = {
      state: editor.state,
      dispatch: () => {
        throw new Error('plugin hook exploded');
      },
    } as unknown as EditorView;

    expect(() => dispatchAsOwnUndoStep(throwingView, editor.state.tr)).toThrow(
      'plugin hook exploded',
    );
    expect(stops).toBe(2);
  } finally {
    editor.destroy();
    ydoc.destroy();
  }
});
