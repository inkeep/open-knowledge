import { setTimeout as wait } from 'node:timers/promises';
import type { EditorView } from '@codemirror/view';
import { MarkdownManager, normalizeBridge, sharedExtensions } from '@inkeep/open-knowledge-core';
import { setupServerObservers } from '@inkeep/open-knowledge-server';
import { Editor, getSchema } from '@tiptap/core';
import Collaboration from '@tiptap/extension-collaboration';
import { yXmlFragmentToProseMirrorRootNode } from '@tiptap/y-tiptap';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import { yUndoManagerKeymap } from 'y-codemirror.next';
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

const SEED = '# Doc\n\nAAA lead paragraph.\n\nZZZ trailing paragraph.\n';

const PASTED_TABLE =
  '\n| Format | Input | Output |\n' +
  '| --- | --- | --- |\n' +
  '| Plain text | 10/10 | 10/10 |\n' +
  '| Markdown | **10/10** | **10/10** |\n' +
  '| Screenshot | 2–5/10 | — |\n\n';

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

function runSourceRedo(view: EditorView): boolean {
  const binding = yUndoManagerKeymap.find((b) => b.key === 'Mod-y' || b.key === 'Mod-Shift-z');
  return binding?.run?.(view) ?? false;
}

function lineOf(md: string, marker: string): string | null {
  return md.split('\n').find((l) => l.includes(marker)) ?? null;
}

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

  doc.transact(() => {
    ytext.insert(0, SEED);
  }, 'seed');

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

function insertInWysiwyg(editor: Editor, after: string, text: string): void {
  let pos = -1;
  editor.state.doc.descendants((node, nodePos) => {
    if (pos < 0 && node.isText && node.text?.includes(after)) {
      pos = nodePos + node.text.indexOf(after) + after.length;
    }
    return undefined;
  });
  expect(pos, `WYSIWYG anchor "${after}" not found`).toBeGreaterThan(0);
  editor.view.dispatch(editor.state.tr.insertText(text, pos, pos));
}

async function driveUpToRedo(rig: Rig, interleaveWysiwygUndo: boolean): Promise<void> {
  const { ytext, view, editor } = rig;

  typeInSource(view, PASTED_TABLE, ytext.toString().indexOf('ZZZ trailing'));
  await wait(NEW_UNDO_FRAME_MS);
  expect(ytext.toString(), 'setup: table pasted').toContain('| Screenshot | 2–5/10 |');

  insertInWysiwyg(editor, 'Markdown', '-WYSIN');
  await wait(NEW_UNDO_FRAME_MS);
  expect(lineOf(ytext.toString(), '-WYSIN'), 'setup: WYSIWYG edit is in the table').toMatch(
    /^\| Markdown-WYSIN \|/,
  );

  typeInSource(view, '-SRCOUT', ytext.toString().indexOf('AAA') + 3);
  typeInSource(view, '-SRCIN', ytext.toString().indexOf('| Screenshot') + '| Screenshot'.length);
  await wait(NEW_UNDO_FRAME_MS);
  expect(lineOf(ytext.toString(), '-SRCOUT'), 'setup: source edit is outside the table').toBe(
    'AAA-SRCOUT lead paragraph.',
  );
  expect(lineOf(ytext.toString(), '-SRCIN'), 'setup: source edit is INSIDE the table').toMatch(
    /^\| Screenshot-SRCIN \|/,
  );

  expect(runSourceUndo(view, 'production'), 'setup: source undo ran').toBe(true);
  expect(ytext.toString(), 'setup: merged frame retracted both edits').not.toContain('-SRCIN');
  expect(ytext.toString()).not.toContain('-SRCOUT');

  if (interleaveWysiwygUndo) {
    editor.commands.undo();
    expect(ytext.toString(), 'setup: WYSIWYG undo retracted the in-table edit').not.toContain(
      '-WYSIN',
    );
  }
}

function assertBridgeInvariantHolds(rig: Rig): void {
  const derived = mdManager.serialize(
    yXmlFragmentToProseMirrorRootNode(rig.fragment, schema).toJSON(),
  );
  expect(normalizeBridge(derived)).toBe(normalizeBridge(rig.ytext.toString()));
}

describe('cross-mode undo/redo anchoring across a table boundary', () => {
  test('KNOWN-BUG (flip on fix): an interleaved WYSIWYG undo makes the source redo re-anchor the inside-table edit OUTSIDE the table', async () => {
    const rig = createRig();
    await driveUpToRedo(rig, true);

    expect(runSourceRedo(rig.view), 'source redo ran').toBe(true);
    const after = rig.ytext.toString();

    expect(lineOf(after, '-SRCOUT')).toBe('AAA-SRCOUT lead paragraph.');

    expect(lineOf(after, '-SRCIN')).toBe('-SRCIN');
    expect(after).toContain('\n-SRCIN\n| Format |');
    expect(after, 'the Screenshot row lost the edit that belongs in it').toContain(
      '| Screenshot | 2–5/10 |',
    );

    expect(after.split('\n').filter((l) => l.trim().startsWith('|'))).toHaveLength(5);
    assertBridgeInvariantHolds(rig);
  }, 30_000);

  test('control: without the interleaved WYSIWYG undo the same redo lands inside the table', async () => {
    const rig = createRig();
    await driveUpToRedo(rig, false);

    expect(runSourceRedo(rig.view), 'source redo ran').toBe(true);
    const after = rig.ytext.toString();

    expect(lineOf(after, '-SRCOUT')).toBe('AAA-SRCOUT lead paragraph.');
    expect(lineOf(after, '-SRCIN')).toMatch(/^\| Screenshot-SRCIN \|/);
    expect(after.split('\n').filter((l) => l.trim().startsWith('|'))).toHaveLength(5);
    assertBridgeInvariantHolds(rig);
  }, 30_000);
});
