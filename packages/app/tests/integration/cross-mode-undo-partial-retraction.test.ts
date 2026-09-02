/**
 * A source undo frame is only PARTIALLY retracted after WYSIWYG edits.
 *
 * Reported recipe, reproduced verbatim below: type two identical `hello bug`
 * lines separated by blank lines in markdown mode, add two edits in the
 * WYSIWYG, return to markdown and undo. The undo deletes `hello bug` from the
 * FIRST line and leaves everything else — the second `hello bug` and both
 * WYSIWYG edits — in place.
 *
 * Why that is wrong under EITHER reading of the intended semantics. The two
 * editors run independent undo stacks over different CRDT types, and bridge
 * writes carry `OBSERVER_SYNC_ORIGIN`, deliberately outside both managers'
 * tracked origins, so WYSIWYG edits are not in the source stack at all. Under
 * that design the source undo should retract its own last frame — the typing
 * — which was ONE frame covering BOTH `hello bug` lines, so both should go
 * (the `control:` row pins exactly that when no WYSIWYG edit intervenes).
 * Under the user's expectation it should instead retract the most recent
 * change, an `oops`. What actually happens is neither: half of one frame.
 *
 * Mechanism. When the WYSIWYG edits land, Observer A rewrites `Y.Text` from
 * the fragment through a diff (`applyIncrementalDiff` / `applyFastDiff`), which
 * replaces the spans it touches rather than preserving every item. The second
 * `hello bug` line is inside a touched span, so its original items — the ones
 * the user's undo frame owns — are deleted and re-inserted as bridge-authored
 * items under `OBSERVER_SYNC_ORIGIN`. The undo manager can no longer retract
 * them. The first line was untouched by the diff, so its items survive and are
 * retracted. The frame is silently split in two by ownership transfer, and
 * undoing it applies only the half the user still owns.
 *
 * Note what does NOT fire: the bridge invariant holds throughout. Both CRDTs
 * agree, so no invariant violation, no loss-detector event, and no recovery
 * checkpoint — the document timeline stays empty, and because the damage is
 * server-resident, neither reopening the document nor reloading the renderer
 * clears it.
 *
 * Sibling defect, same family, different symptom:
 * `cross-mode-undo-redo-table-anchor.test.ts` pins a REDO re-anchoring an
 * inside-table edit outside the table. This row is about UNDO under-applying.
 *
 * FLIP CONTRACT — the `KNOWN-BUG` row asserts today's WRONG outcome on purpose.
 * When a fix lands it fails loudly; decide which semantics the fix adopts, move
 * the assertion to match, and retitle. Written this way round rather than as
 * `test.fail()` so a setup regression (the typing or the WYSIWYG edits never
 * landing) cannot be silently swallowed as an expected failure — the
 * mid-recipe setup assertions exist for the same reason.
 */

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

/** Past Yjs's 500 ms `captureTimeout`, so the next edit opens a NEW undo frame. */
const NEW_UNDO_FRAME_MS = 600;

/** `hello bug` on line 1, blank lines 2 and 3, `hello bug` on line 4. */
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

/** Append `text` at the end of the block at `index`, in the WYSIWYG. */
function appendToBlock(editor: Editor, index: number, text: string): void {
  let pos = -1;
  editor.state.doc.forEach((node, offset, i) => {
    if (i === index) pos = offset + node.nodeSize - 1;
  });
  expect(pos, `WYSIWYG block ${index} not found`).toBeGreaterThan(-1);
  editor.view.dispatch(editor.state.tr.insertText(text, pos, pos));
}

/** The bridge invariant, through the same tolerance the server watchdog uses. */
function assertBridgeInvariantHolds(rig: Rig): void {
  const derived = mdManager.serialize(
    yXmlFragmentToProseMirrorRootNode(rig.fragment, schema).toJSON(),
  );
  expect(normalizeBridge(derived)).toBe(normalizeBridge(rig.ytext.toString()));
}

/**
 * Steps 1-3 of the recipe: type both `hello bug` lines in markdown mode as ONE
 * undo frame, and wait past the capture window so nothing later merges into it.
 */
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

    // 5. WYSIWYG: "oops" on the blank line BETWEEN the two `hello bug` lines.
    appendToBlock(rig.editor, 1, 'oops');
    await wait(NEW_UNDO_FRAME_MS);
    expect(rig.ytext.toString(), 'setup: first WYSIWYG edit landed').toBe(
      'hello bug\n\noops\n\nhello bug\n',
    );

    // 6. WYSIWYG: "oops" behind the SECOND `hello bug`.
    appendToBlock(rig.editor, 2, 'oops');
    await wait(NEW_UNDO_FRAME_MS);
    expect(rig.ytext.toString(), 'setup: second WYSIWYG edit landed').toBe(
      'hello bug\n\noops\n\nhello bugoops\n',
    );

    // 7. Back to markdown mode. Undo.
    expect(runSourceUndo(rig.view, 'production'), 'source undo ran').toBe(true);
    const after = rig.ytext.toString();

    // Half the frame is retracted: line 1 loses `hello bug`, line 4 keeps it.
    // ON FIX: whichever semantics is adopted, this becomes either
    // `''` + '\n\noops\n\noops\n' (retract the whole typed frame) or
    // 'hello bug\n\noops\n\nhello bug\n' (retract the last WYSIWYG edit).
    expect(after).toBe('\n\noops\n\nhello bugoops\n');
    expect(after.match(/hello bug/g) ?? [], 'one of the two typed lines survives').toHaveLength(1);
    expect(after.match(/oops/g) ?? [], 'both WYSIWYG edits survive').toHaveLength(2);

    assertBridgeInvariantHolds(rig);
  }, 30_000);

  test('control: with no WYSIWYG edits in between, the same undo retracts the whole frame', async () => {
    const rig = createRig();
    await typeBothLines(rig);

    expect(runSourceUndo(rig.view, 'production'), 'source undo ran').toBe(true);

    // Both typed lines go — one frame, fully retracted.
    expect(rig.ytext.toString()).toBe('');
    assertBridgeInvariantHolds(rig);
  }, 30_000);
});
