/**
 * Cross-mode undo/redo re-anchors an inside-table edit OUTSIDE the table.
 *
 * Source mode and the WYSIWYG run two independent undo stacks over two
 * different CRDT types — `Y.UndoManager` over `Y.Text('source')` (created
 * inside y-codemirror's `YSyncConfig`) and y-prosemirror's over
 * `Y.XmlFragment('default')`. Neither can see the other's type, and the
 * bridge's own writes carry `OBSERVER_SYNC_ORIGIN`, which is deliberately
 * outside both managers' tracked origins so sync never becomes user-undoable.
 *
 * That isolation has a cost this suite pins. When a source undo frame spans
 * BOTH a region inside a table and one outside it, and a WYSIWYG undo runs
 * between that frame's undo and its redo, the redo re-anchors the inside-table
 * portion outside the table — it reappears as a bare line above the table
 * instead of in the cell it was typed into. The interleaved WYSIWYG undo
 * rewrites the fragment, Observer A rewrites `Y.Text` from it, and the source
 * frame's redo then resolves its stored positions against bytes that moved
 * underneath it.
 *
 * BOTH ingredients are load-bearing, each established by removing it and
 * watching the misplacement disappear:
 *   1. ONE source undo frame spanning the table boundary. Yjs merges edits made
 *      within `captureTimeout` (500 ms, Yjs's default — not OK config) into a
 *      single frame, so rapid editing produces this and deliberate editing does
 *      not. Every other step below is paced past that window; only the two
 *      source edits sit inside it. Pace them apart and the redo lands correctly.
 *   2. An interleaved WYSIWYG undo that retracts an edit INSIDE THE TABLE. An
 *      undo of a WYSIWYG edit elsewhere in the document is NOT sufficient — the
 *      interleaved undo has to disturb the table region the source frame's redo
 *      will re-anchor into. That is what the `control:` row removes.
 *
 * Note what does NOT fire: the bridge invariant still HOLDS on the corrupted
 * result (asserted below). Both CRDTs agree with each other, so there is no
 * invariant violation, no loss-detector event, and no recovery checkpoint. A
 * user hitting this finds an empty document timeline, and because the damage is
 * server-resident, neither reopening the document nor reloading the renderer
 * clears it — only restarting the app, which reloads the doc from disk.
 *
 * The table survives structurally; this is a misplacement, not a mangling,
 * which is why every downstream classifier reads it as a legitimate edit.
 *
 * FLIP CONTRACT — the `KNOWN-BUG` row asserts today's WRONG placement on
 * purpose. When a fix lands, it fails loudly; move its assertion to the
 * inside-the-table shape the `control:` row already uses, and retitle it.
 * Written this way round, rather than as `test.fail()`, so a setup regression
 * (the markers never landing where the recipe needs them) cannot be silently
 * swallowed as an expected failure. The mid-recipe setup assertions in
 * `driveUpToRedo` exist for the same reason.
 */

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

/** Past Yjs's 500 ms `captureTimeout`, so the next edit opens a NEW undo frame. */
const NEW_UNDO_FRAME_MS = 600;

const SEED = '# Doc\n\nAAA lead paragraph.\n\nZZZ trailing paragraph.\n';

/** The table the user pastes into the markdown view. */
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

/** The redo command the source keymap binds to Mod-y / Mod-Shift-z. */
function runSourceRedo(view: EditorView): boolean {
  const binding = yUndoManagerKeymap.find((b) => b.key === 'Mod-y' || b.key === 'Mod-Shift-z');
  return binding?.run?.(view) ?? false;
}

/** The line `marker` sits on, or null when absent. */
function lineOf(md: string, marker: string): string | null {
  return md.split('\n').find((l) => l.includes(marker)) ?? null;
}

interface Rig {
  ytext: Y.Text;
  fragment: Y.XmlFragment;
  view: EditorView;
  editor: Editor;
}

/**
 * One Y.Doc carrying BOTH real editors and the real server bridge in-process.
 *
 * No WebSocket: `installDomGlobals` replaces the global `Event` class, which
 * Node's WebSocket rejects, so the booted-server harness and the jsdom editors
 * cannot coexist in one process. The bridge is the production
 * `setupServerObservers` either way — only the transport is elided.
 */
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

/** Insert `text` immediately after the first occurrence of `after`, in the WYSIWYG. */
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

/**
 * Drive the recipe up to the point where the source frame has been undone.
 *
 * `interleaveWysiwygUndo` is the single variable between the two rows: it runs
 * a WYSIWYG undo between the source undo and the caller's redo.
 */
async function driveUpToRedo(rig: Rig, interleaveWysiwygUndo: boolean): Promise<void> {
  const { ytext, view, editor } = rig;

  // 1. Paste a table into the SOURCE view — one large insert, its own frame.
  typeInSource(view, PASTED_TABLE, ytext.toString().indexOf('ZZZ trailing'));
  await wait(NEW_UNDO_FRAME_MS);
  expect(ytext.toString(), 'setup: table pasted').toContain('| Screenshot | 2–5/10 |');

  // 2. Edit INSIDE the table, in the WYSIWYG. Own frame.
  insertInWysiwyg(editor, 'Markdown', '-WYSIN');
  await wait(NEW_UNDO_FRAME_MS);
  expect(lineOf(ytext.toString(), '-WYSIN'), 'setup: WYSIWYG edit is in the table').toMatch(
    /^\| Markdown-WYSIN \|/,
  );

  // 3 + 4. Two SOURCE edits inside one capture window — one outside the table,
  // one inside it. No wait between them: this is the merged frame spanning the
  // table boundary that the defect needs.
  typeInSource(view, '-SRCOUT', ytext.toString().indexOf('AAA') + 3);
  typeInSource(view, '-SRCIN', ytext.toString().indexOf('| Screenshot') + '| Screenshot'.length);
  await wait(NEW_UNDO_FRAME_MS);
  expect(lineOf(ytext.toString(), '-SRCOUT'), 'setup: source edit is outside the table').toBe(
    'AAA-SRCOUT lead paragraph.',
  );
  expect(lineOf(ytext.toString(), '-SRCIN'), 'setup: source edit is INSIDE the table').toMatch(
    /^\| Screenshot-SRCIN \|/,
  );

  // 5. Undo in SOURCE — retracts the merged frame, both markers at once.
  expect(runSourceUndo(view, 'production'), 'setup: source undo ran').toBe(true);
  expect(ytext.toString(), 'setup: merged frame retracted both edits').not.toContain('-SRCIN');
  expect(ytext.toString()).not.toContain('-SRCOUT');

  // 6. The variable: a WYSIWYG undo — retracting the INSIDE-table edit —
  // between the source undo and its redo.
  if (interleaveWysiwygUndo) {
    editor.commands.undo();
    expect(ytext.toString(), 'setup: WYSIWYG undo retracted the in-table edit').not.toContain(
      '-WYSIN',
    );
  }
}

/**
 * The bridge invariant still HOLDS on the corrupted result — the two CRDTs
 * agree with each other modulo the bridge's own tolerance. That is why nothing
 * downstream classifies this as damage: no invariant violation, no loss event,
 * no recovery checkpoint. Compared through `normalizeBridge` (the same
 * tolerance the server watchdog and the harness's `assertBridgeInvariant` use)
 * rather than raw bytes, so an in-tolerance blank-run difference mid-settle is
 * not mistaken for divergence.
 */
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

    // The outside-table half of the frame is restored correctly.
    expect(lineOf(after, '-SRCOUT')).toBe('AAA-SRCOUT lead paragraph.');

    // The inside-table half is NOT. It reappears as a bare line above the
    // table instead of in the `Screenshot` cell it was typed into.
    // ON FIX: this becomes `toMatch(/^\| Screenshot-SRCIN \|/)`.
    expect(lineOf(after, '-SRCIN')).toBe('-SRCIN');
    expect(after).toContain('\n-SRCIN\n| Format |');
    expect(after, 'the Screenshot row lost the edit that belongs in it').toContain(
      '| Screenshot | 2–5/10 |',
    );

    // The table itself survives structurally — this is a misplacement, not a
    // mangling, which is why nothing downstream classifies it as damage.
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
