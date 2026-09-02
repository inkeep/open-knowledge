/**
 * Undo is one global LIFO across both editing surfaces.
 *
 * Both views are real: a CodeMirror view bound by `yCollab` and a ProseMirror
 * view bound by the projection, over one `Y.Text` and one `Y.UndoManager`. The
 * claim under test is that the most recent edit retracts whichever view made
 * it, and that a frame spanning several edits comes back whole.
 */

import { EditorState } from '@codemirror/state';
import { EditorView as CmEditorView } from '@codemirror/view';
import { MarkdownManager, sharedExtensions } from '@inkeep/open-knowledge-core';
import { Editor } from '@tiptap/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { yCollab } from 'y-codemirror.next';
import * as Y from 'yjs';
import { createProjectionBinding } from './projection-binding';
import { sharedUndoManagerFor } from './shared-undo-manager';
import { installDomGlobals } from './walk-currency-test-harness';

const md = new MarkdownManager({ extensions: sharedExtensions });

let restoreDom: (() => void) | undefined;
beforeAll(() => {
  restoreDom = installDomGlobals();
});
afterAll(() => {
  restoreDom?.();
});

interface CrossModeRig {
  wysiwyg: Editor;
  source: CmEditorView;
  ytext: Y.Text;
  undoManager: Y.UndoManager;
  /** Close the current undo frame so the next edit is its own stack item. */
  breakFrame(): void;
  destroy(): void;
}

function createCrossModeRig(initial: string): CrossModeRig {
  const ydoc = new Y.Doc();
  const ytext = ydoc.getText('source');
  ydoc.transact(() => ytext.insert(0, initial), 'seed');

  const undoManager = sharedUndoManagerFor(ytext);

  const wysiwygHost = document.createElement('div');
  document.body.appendChild(wysiwygHost);
  const binding = createProjectionBinding({ ytext, md });
  const wysiwyg = new Editor({
    element: wysiwygHost,
    content: binding.content,
    extensions: [...sharedExtensions, binding.extension],
  });

  const sourceHost = document.createElement('div');
  document.body.appendChild(sourceHost);
  const source = new CmEditorView({
    state: EditorState.create({
      doc: ytext.toString(),
      // The manager is handed in, not created: `yCollab` would otherwise make
      // its own, and two managers over one type is the defect in a new shape.
      extensions: [yCollab(ytext, null, { undoManager })],
    }),
    parent: sourceHost,
  });

  return {
    wysiwyg,
    source,
    ytext,
    undoManager,
    breakFrame() {
      undoManager.stopCapturing();
    },
    destroy() {
      wysiwyg.destroy();
      source.destroy();
      wysiwygHost.remove();
      sourceHost.remove();
      ydoc.destroy();
    },
  };
}

/** Type at the end of a top-level WYSIWYG block. */
function typeInWysiwyg(editor: Editor, blockIndex: number, text: string): void {
  const doc = editor.state.doc;
  let pos = 0;
  for (let i = 0; i <= blockIndex; i++) pos += doc.child(i).nodeSize;
  editor.view.dispatch(editor.state.tr.insertText(text, pos - 1, pos - 1));
}

/** Type into the source view at a source offset. */
function typeInSource(view: CmEditorView, at: number, text: string): void {
  view.dispatch({ changes: { from: at, to: at, insert: text } });
}

const DOC = '# Heading\n\nBody paragraph.\n';

describe('one undo stack across both surfaces', () => {
  it('retracts the most recent edit whichever view made it — WYSIWYG last', () => {
    const rig = createCrossModeRig(DOC);
    typeInSource(rig.source, rig.ytext.toString().indexOf('\n'), ' from source');
    rig.breakFrame();
    typeInWysiwyg(rig.wysiwyg, 1, ' from wysiwyg');
    rig.breakFrame();

    expect(rig.ytext.toString()).toBe('# Heading from source\n\nBody paragraph. from wysiwyg\n');

    // The WYSIWYG edit is the most recent, so it is what comes back, even
    // though the undo is issued while source mode holds the caret.
    rig.undoManager.undo();
    expect(rig.ytext.toString()).toBe('# Heading from source\n\nBody paragraph.\n');

    rig.undoManager.undo();
    expect(rig.ytext.toString()).toBe(DOC);
    rig.destroy();
  });

  it('retracts the most recent edit whichever view made it — source last', () => {
    const rig = createCrossModeRig(DOC);
    typeInWysiwyg(rig.wysiwyg, 1, ' from wysiwyg');
    rig.breakFrame();
    typeInSource(rig.source, rig.ytext.toString().indexOf('\n'), ' from source');
    rig.breakFrame();

    expect(rig.ytext.toString()).toBe('# Heading from source\n\nBody paragraph. from wysiwyg\n');

    rig.undoManager.undo();
    expect(rig.ytext.toString()).toBe('# Heading\n\nBody paragraph. from wysiwyg\n');

    rig.undoManager.undo();
    expect(rig.ytext.toString()).toBe(DOC);
    rig.destroy();
  });

  it('brings both views back with the document, not just the one that undid', () => {
    const rig = createCrossModeRig(DOC);
    typeInWysiwyg(rig.wysiwyg, 0, ' edited');
    rig.breakFrame();
    expect(rig.source.state.doc.toString()).toContain('# Heading edited');

    rig.undoManager.undo();
    expect(rig.source.state.doc.toString()).toBe(DOC);
    expect(rig.wysiwyg.state.doc.child(0).textContent).toBe('Heading');
    rig.destroy();
  });

  it('redoes across surfaces too', () => {
    const rig = createCrossModeRig(DOC);
    typeInSource(rig.source, rig.ytext.toString().indexOf('\n'), '!');
    rig.breakFrame();
    rig.undoManager.undo();
    expect(rig.ytext.toString()).toBe(DOC);
    rig.undoManager.redo();
    expect(rig.ytext.toString()).toBe('# Heading!\n\nBody paragraph.\n');
    expect(rig.wysiwyg.state.doc.child(0).textContent).toBe('Heading!');
    rig.destroy();
  });

  it('retracts a multi-line source frame whole, even with a WYSIWYG edit interleaved', () => {
    // A source frame spanning two lines with a WYSIWYG edit landing between
    // them. One manager tracks all three, so the frame cannot be retracted in
    // pieces.
    const rig = createCrossModeRig('one\n\ntwo\n');
    typeInSource(rig.source, 3, ' edited');
    typeInSource(rig.source, rig.ytext.toString().indexOf('two') + 3, ' edited');
    rig.breakFrame();
    expect(rig.ytext.toString()).toBe('one edited\n\ntwo edited\n');

    typeInWysiwyg(rig.wysiwyg, 1, '!');
    rig.breakFrame();

    rig.undoManager.undo();
    expect(rig.ytext.toString()).toBe('one edited\n\ntwo edited\n');
    // The whole source frame retracts — both lines, together.
    rig.undoManager.undo();
    expect(rig.ytext.toString()).toBe('one\n\ntwo\n');
    rig.destroy();
  });

  it('gives both surfaces the same manager instance', () => {
    const rig = createCrossModeRig(DOC);
    const binding = createProjectionBinding({ ytext: rig.ytext, md });
    expect(binding.undoManager).toBe(rig.undoManager);
    rig.destroy();
  });
});

/**
 * Frames merge across surfaces when nothing closes them.
 *
 * `Y.UndoManager` decides whether a transaction joins the open stack item by
 * ELAPSED TIME alone — `captureTimeout`, 500ms, Yjs's default. There is no
 * origin check, so a source edit and a WYSIWYG edit inside that window become
 * ONE stack item and a single undo retracts both.
 *
 * `EditorPane.handleModeChange` closes the frame on every mode switch, which is
 * what puts this out of reach in the product: getting to the other view means
 * passing through it. Every other row in this file calls `breakFrame()` between
 * edits and so cannot see the merge; these two rows pin both sides of it.
 */
describe('undo frames across surfaces', () => {
  it('merges a source and a WYSIWYG edit when no boundary closes the frame', () => {
    const rig = createCrossModeRig(DOC);
    typeInSource(rig.source, rig.ytext.length, 'source');
    // Deliberately NO breakFrame here — this is the unguarded shape.
    typeInWysiwyg(rig.wysiwyg, 1, 'wysiwyg');

    expect(rig.undoManager.undoStack).toHaveLength(1);
    rig.undoManager.undo();
    // One undo, both edits gone: the defect.
    expect(rig.ytext.toString()).not.toContain('source');
    expect(rig.ytext.toString()).not.toContain('wysiwyg');
    rig.destroy();
  });

  it('keeps them separate once the boundary closes the frame', () => {
    const rig = createCrossModeRig(DOC);
    typeInSource(rig.source, rig.ytext.length, 'source');
    // What `handleModeChange` does on every mode switch.
    rig.breakFrame();
    typeInWysiwyg(rig.wysiwyg, 1, 'wysiwyg');

    expect(rig.undoManager.undoStack).toHaveLength(2);
    rig.undoManager.undo();
    // The most recent edit retracts, and only that one.
    expect(rig.ytext.toString()).not.toContain('wysiwyg');
    expect(rig.ytext.toString()).toContain('source');
    rig.destroy();
  });
});
