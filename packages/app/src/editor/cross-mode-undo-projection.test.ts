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

function typeInWysiwyg(editor: Editor, blockIndex: number, text: string): void {
  const doc = editor.state.doc;
  let pos = 0;
  for (let i = 0; i <= blockIndex; i++) pos += doc.child(i).nodeSize;
  editor.view.dispatch(editor.state.tr.insertText(text, pos - 1, pos - 1));
}

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
    const rig = createCrossModeRig('one\n\ntwo\n');
    typeInSource(rig.source, 3, ' edited');
    typeInSource(rig.source, rig.ytext.toString().indexOf('two') + 3, ' edited');
    rig.breakFrame();
    expect(rig.ytext.toString()).toBe('one edited\n\ntwo edited\n');

    typeInWysiwyg(rig.wysiwyg, 1, '!');
    rig.breakFrame();

    rig.undoManager.undo();
    expect(rig.ytext.toString()).toBe('one edited\n\ntwo edited\n');
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

function nativeHistoryEvent(inputType: 'historyUndo' | 'historyRedo'): Event {
  const event = new Event('beforeinput', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'inputType', { value: inputType });
  return event;
}

describe("the browser's own undo and redo", () => {
  it('reach the shared manager instead of editing the DOM', () => {
    const rig = createCrossModeRig(DOC);
    typeInWysiwyg(rig.wysiwyg, 1, ' one');
    rig.breakFrame();
    typeInWysiwyg(rig.wysiwyg, 0, ' two');
    rig.breakFrame();

    const undo = nativeHistoryEvent('historyUndo');
    rig.wysiwyg.view.dom.dispatchEvent(undo);
    expect(undo.defaultPrevented).toBe(true);
    expect(rig.ytext.toString()).toBe('# Heading\n\nBody paragraph. one\n');

    rig.wysiwyg.view.dom.dispatchEvent(nativeHistoryEvent('historyUndo'));
    expect(rig.ytext.toString()).toBe(DOC);
    expect(rig.undoManager.undoStack).toHaveLength(0);

    const redo = nativeHistoryEvent('historyRedo');
    rig.wysiwyg.view.dom.dispatchEvent(redo);
    expect(redo.defaultPrevented).toBe(true);
    expect(rig.ytext.toString()).toBe('# Heading\n\nBody paragraph. one\n');
    expect(rig.undoManager.redoStack).toHaveLength(1);
    rig.destroy();
  });
});

describe('undo frames across surfaces', () => {
  it('merges a source and a WYSIWYG edit when no boundary closes the frame', () => {
    const rig = createCrossModeRig(DOC);
    typeInSource(rig.source, rig.ytext.length, 'source');
    typeInWysiwyg(rig.wysiwyg, 1, 'wysiwyg');

    expect(rig.undoManager.undoStack).toHaveLength(1);
    rig.undoManager.undo();
    expect(rig.ytext.toString()).not.toContain('source');
    expect(rig.ytext.toString()).not.toContain('wysiwyg');
    rig.destroy();
  });

  it('keeps them separate once the boundary closes the frame', () => {
    const rig = createCrossModeRig(DOC);
    typeInSource(rig.source, rig.ytext.length, 'source');
    rig.breakFrame();
    typeInWysiwyg(rig.wysiwyg, 1, 'wysiwyg');

    expect(rig.undoManager.undoStack).toHaveLength(2);
    rig.undoManager.undo();
    expect(rig.ytext.toString()).not.toContain('wysiwyg');
    expect(rig.ytext.toString()).toContain('source');
    rig.destroy();
  });
});
