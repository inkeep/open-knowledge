/**
 * The exception-safety property of `dispatchAsOwnUndoStep`: the CLOSING
 * `stopCapturing()` must run even when `view.dispatch` throws — a
 * split-open-but-never-closed capture merges the user's next keystrokes into
 * the failed item, and one undo then strips them together. The happy path is
 * covered by the collab-rig undo suites in gfm-autolink-plugin.test.ts and
 * inline-link-input-rule.test.ts; this file pins the throw path (the only
 * path where the `finally` matters — a try/catch refactor would break it).
 */

import { afterAll, beforeAll, expect, test } from 'bun:test';
import type { EditorView } from '@tiptap/pm/view';
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

    // dispatchAsOwnUndoStep reads only `state` and `dispatch` from the view;
    // hand it the real editor state with a dispatch that throws mid-step.
    const throwingView = {
      state: editor.state,
      dispatch: () => {
        throw new Error('plugin hook exploded');
      },
    } as unknown as EditorView;

    expect(() => dispatchAsOwnUndoStep(throwingView, editor.state.tr)).toThrow(
      'plugin hook exploded',
    );
    // Split before + close after — BOTH ran despite the throw.
    expect(stops).toBe(2);
  } finally {
    editor.destroy();
    ydoc.destroy();
  }
});
