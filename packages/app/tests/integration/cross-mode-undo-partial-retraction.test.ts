import { setTimeout as wait } from 'node:timers/promises';
import type { EditorView } from '@codemirror/view';
import { MarkdownManager, normalizeBridge, sharedExtensions } from '@inkeep/open-knowledge-core';
import { setupServerObservers } from '@inkeep/open-knowledge-server';
import { Editor, getSchema } from '@tiptap/core';
import Collaboration from '@tiptap/extension-collaboration';
import { yXmlFragmentToProseMirrorRootNode } from '@tiptap/y-tiptap';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';
import { installDomGlobals } from '../../src/editor/walk-currency-test-harness';
import {
  installCmMeasurementStubs,
  mountSourceUndoEditor,
  runSourceUndo,
  typeInSource,
} from './source-undo-rig.test-helper';

const mdManager = new MarkdownManager({ extensions: sharedExtensions });
const schema = getSchema(sharedExtensions);

const NEW_UNDO_FRAME_MS = 600;

const TYPED = 'hello bug\n\n\nhello bug\n';

let restoreDom: (() => void) | null = null;
beforeAll(() => {
  restoreDom = installDomGlobals();
  installCmMeasurementStubs();
}, 30_000);
afterAll(() => {
  restoreDom?.();
});

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

interface Rig {
  ytext: Y.Text;
  fragment: Y.XmlFragment;
  view: EditorView;
  editor: Editor;
}

function createRig(): Rig {
  const doc = new Y.Doc();
  const ytext = doc.getText('source');
  const fragment = doc.getXmlFragment('default');
  cleanups.push(setupServerObservers({ doc, xmlFragment: fragment, ytext, mdManager, schema }));

  const awareness = new Awareness(doc);
  const host = document.createElement('div');
  document.body.appendChild(host);
  const { view, destroy } = mountSourceUndoEditor({
    ytext,
    awareness,
    wiring: 'production',
    parent: host,
  });
  cleanups.push(() => {
    destroy();
    awareness.destroy();
  });

  const editorHost = document.createElement('div');
  document.body.appendChild(editorHost);
  const editor = new Editor({
    element: editorHost,
    extensions: [...sharedExtensions, Collaboration.configure({ document: doc })],
  });
  cleanups.push(() => editor.destroy());

  return { ytext, fragment, view, editor };
}

function appendToBlock(editor: Editor, index: number, text: string): void {
  let pos = -1;
  editor.state.doc.forEach((node, offset, i) => {
    if (i === index) pos = offset + node.nodeSize - 1;
  });
  expect(pos, `WYSIWYG block ${index} not found`).toBeGreaterThan(-1);
  editor.view.dispatch(editor.state.tr.insertText(text, pos, pos));
}

function assertBridgeInvariantHolds(rig: Rig): void {
  const derived = mdManager.serialize(
    yXmlFragmentToProseMirrorRootNode(rig.fragment, schema).toJSON(),
  );
  expect(normalizeBridge(derived)).toBe(normalizeBridge(rig.ytext.toString()));
}

async function typeBothLines(rig: Rig): Promise<void> {
  typeInSource(rig.view, TYPED, 0);
  await wait(NEW_UNDO_FRAME_MS);
  expect(rig.ytext.toString(), 'setup: both lines typed').toBe(TYPED);
  expect(
    rig.editor.state.doc.childCount,
    'setup: the blank run renders as its own WYSIWYG block',
  ).toBe(3);
}

describe('a source undo frame after WYSIWYG edits', () => {
  test('KNOWN-BUG (flip on fix): undo retracts only the FIRST line of the frame, leaving the second', async () => {
    const rig = createRig();
    await typeBothLines(rig);

    appendToBlock(rig.editor, 1, 'oops');
    await wait(NEW_UNDO_FRAME_MS);
    expect(rig.ytext.toString(), 'setup: first WYSIWYG edit landed').toBe(
      'hello bug\n\noops\n\nhello bug\n',
    );

    appendToBlock(rig.editor, 2, 'oops');
    await wait(NEW_UNDO_FRAME_MS);
    expect(rig.ytext.toString(), 'setup: second WYSIWYG edit landed').toBe(
      'hello bug\n\noops\n\nhello bugoops\n',
    );

    expect(runSourceUndo(rig.view, 'production'), 'source undo ran').toBe(true);
    const after = rig.ytext.toString();

    expect(after).toBe('\n\noops\n\nhello bugoops\n');
    expect(after.match(/hello bug/g) ?? [], 'one of the two typed lines survives').toHaveLength(1);
    expect(after.match(/oops/g) ?? [], 'both WYSIWYG edits survive').toHaveLength(2);

    assertBridgeInvariantHolds(rig);
  }, 30_000);

  test('control: with no WYSIWYG edits in between, the same undo retracts the whole frame', async () => {
    const rig = createRig();
    await typeBothLines(rig);

    expect(runSourceUndo(rig.view, 'production'), 'source undo ran').toBe(true);

    expect(rig.ytext.toString()).toBe('');
    assertBridgeInvariantHolds(rig);
  }, 30_000);
});
