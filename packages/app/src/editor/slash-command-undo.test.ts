import { Extension } from '@tiptap/core';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { mountProjectionEditor, type ProjectionEditorRig } from './editor-rig.test-helper';
import { createSuggestionUndoWindow } from './suggestion-undo-window';
import { installDomGlobals } from './walk-currency-test-harness';

let restoreDom: (() => void) | null = null;
beforeAll(() => {
  restoreDom = installDomGlobals();
});
afterAll(() => {
  restoreDom?.();
});

/* STOP: the boundary between the trigger and the command is elapsed wall-clock, not an
   explicit stopCapturing, and lib0 binds Date.now by reference at module load so a fake
   clock cannot reach the UndoManager. This has to be a real pause. */
const MENU_PAUSE_MS = 600;
const pauseAtTheMenu = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, MENU_PAUSE_MS));

const InertSlashCommand = Extension.create({ name: 'slashCommand' });

function mountRig(): ProjectionEditorRig {
  return mountProjectionEditor('Existing paragraph.\n', [InertSlashCommand]);
}

async function typeTriggerAndApply(
  rig: ProjectionEditorRig,
  opts: { withWindow: boolean },
): Promise<void> {
  const { editor } = rig;
  const undoWindow = createSuggestionUndoWindow(() => editor);

  editor.commands.focus('end');
  editor.commands.enter();
  rig.undoManager.stopCapturing();
  editor.commands.insertContent('/');
  if (opts.withWindow) undoWindow.open();
  editor.commands.insertContent('he');

  const caret = editor.state.selection.from;
  await pauseAtTheMenu();

  editor
    .chain()
    .focus()
    .deleteRange({ from: caret - 3, to: caret })
    .setNode('heading', { level: 1 })
    .run();
  if (opts.withWindow) undoWindow.close();

  editor.commands.insertContent('Title');
}

describe('a slash command leaves no trace in the undo stack', () => {
  test('undoing past the heading never resurrects the trigger text', async () => {
    const rig = mountRig();
    try {
      await typeTriggerAndApply(rig, { withWindow: true });
      expect(rig.ytext.toString()).toBe('Existing paragraph.\n\n# Title\n');

      rig.undoManager.undo();
      expect(rig.ytext.toString()).toBe('Existing paragraph.\n\n#\n');

      rig.undoManager.undo();
      expect(rig.ytext.toString()).toBe('Existing paragraph.\n\n');
      expect(rig.editor.state.doc.childCount).toBe(2);

      rig.undoManager.undo();
      expect(rig.ytext.toString()).toBe('Existing paragraph.\n');
      expect(rig.editor.state.doc.childCount).toBe(1);
    } finally {
      rig.destroy();
    }
  });

  test('CONTROL: without the window the trigger comes back, which is the defect', async () => {
    const rig = mountRig();
    try {
      await typeTriggerAndApply(rig, { withWindow: false });
      rig.undoManager.undo();
      expect(rig.ytext.toString()).toContain('/he');
    } finally {
      rig.destroy();
    }
  });

  test('an escaped menu still leaves the trigger as one ordinary undo step', () => {
    const rig = mountRig();
    const undoWindow = createSuggestionUndoWindow(() => rig.editor);
    try {
      rig.editor.commands.focus('end');
      rig.editor.commands.enter();
      rig.undoManager.stopCapturing();
      rig.editor.commands.insertContent('/');
      undoWindow.open();
      rig.editor.commands.insertContent('he');
      undoWindow.close();
      expect(rig.ytext.toString()).toContain('/he');

      rig.undoManager.undo();
      expect(rig.ytext.toString()).toBe('Existing paragraph.\n\n');
      expect(rig.editor.state.doc.childCount).toBe(2);

      rig.undoManager.undo();
      expect(rig.ytext.toString()).toBe('Existing paragraph.\n');
      expect(rig.editor.state.doc.childCount).toBe(1);
    } finally {
      rig.destroy();
    }
  });

  test('the window restores the capture timeout it found', () => {
    const rig = mountRig();
    const undoWindow = createSuggestionUndoWindow(() => rig.editor);
    try {
      const before = rig.undoManager.captureTimeout;
      undoWindow.open();
      expect(rig.undoManager.captureTimeout).toBe(Number.POSITIVE_INFINITY);
      undoWindow.close();
      expect(rig.undoManager.captureTimeout).toBe(before);
    } finally {
      rig.destroy();
    }
  });
});
