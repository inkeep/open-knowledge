import type { EditorView } from '@tiptap/pm/view';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { mountProjectionEditor } from './editor-rig.test-helper';
import { dispatchAsOwnUndoStep, dispatchClosingUndoStep } from './undo-isolation';
import { installDomGlobals } from './walk-currency-test-harness';

let restoreDomGlobals: (() => void) | null = null;

beforeAll(() => {
  restoreDomGlobals = installDomGlobals();
});

afterAll(() => {
  restoreDomGlobals?.();
  restoreDomGlobals = null;
});

test('a throwing dispatch still closes the capture on the projection binding’s manager (stopCapturing runs twice)', () => {
  const rig = mountProjectionEditor('seed\n', []);
  try {
    let stops = 0;
    const originalStop = rig.undoManager.stopCapturing.bind(rig.undoManager);
    rig.undoManager.stopCapturing = () => {
      stops++;
      originalStop();
    };

    const throwingView = {
      state: rig.editor.state,
      dispatch: () => {
        throw new Error('plugin hook exploded');
      },
    } as unknown as EditorView;

    expect(() => dispatchAsOwnUndoStep(throwingView, rig.editor.state.tr)).toThrow(
      'plugin hook exploded',
    );
    expect(stops).toBe(2);
  } finally {
    rig.destroy();
  }
});

test('a closing dispatch leaves the capture open before and closes it after, even when dispatch throws', () => {
  const rig = mountProjectionEditor('seed\n', []);
  try {
    let stops = 0;
    const originalStop = rig.undoManager.stopCapturing.bind(rig.undoManager);
    rig.undoManager.stopCapturing = () => {
      stops++;
      originalStop();
    };

    const throwingView = {
      state: rig.editor.state,
      dispatch: () => {
        throw new Error('plugin hook exploded');
      },
    } as unknown as EditorView;

    expect(() => dispatchClosingUndoStep(throwingView, rig.editor.state.tr)).toThrow(
      'plugin hook exploded',
    );
    expect(stops).toBe(1);
  } finally {
    rig.destroy();
  }
});
