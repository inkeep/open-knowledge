/**
 * CONTRACT — the named write-surface origins are excluded from the editor's
 * undo. A frontmatter form write, a markdownlint auto-fix, and a chunked
 * source paste each stamp a distinct single-root local origin that no editor
 * UndoManager tracks, so a user's Cmd+Z reverts the user's own keystrokes and
 * never one of these programmatic writes.
 *
 * Drives a REAL CodeMirror 6 EditorView over a REAL Y.Text with the production
 * source-mode wiring (the origin-aware y-codemirror Y.UndoManager is the only
 * undo authority).
 *
 * Two things make the rows discriminating rather than a restatement of "an
 * arbitrary object is not the tracked origin":
 *
 *   1. A TRACKED control row runs the identical shape with real keystrokes.
 *      Two typed frames drain under two undos, so the harness demonstrably
 *      does drain frames on a second undo — which is the only reason a
 *      write-surface row surviving that second undo means anything.
 *   2. The lint-fix row calls the PRODUCTION `applyLintFixes`, so the origin
 *      under test is the shipped module-local constant rather than a
 *      reconstruction of it.
 *
 * Residual: the chunked-paste origin is reachable only behind a >500 kB
 * HTML-conversion paste, so that row still reconstructs the shipped shape;
 * the origin-undoability sweep pins that the real constant exists and stays
 * classified.
 */

import type { EditorView } from '@codemirror/view';
import { FORM_WRITE_ORIGIN } from '@inkeep/open-knowledge-core';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';
import { applyLintFixes } from '../../src/editor/apply-lint-fix';
import { installDomGlobals } from '../../src/editor/walk-currency-test-harness';
import {
  installCmMeasurementStubs,
  mountSourceUndoEditor,
  runSourceUndo,
  typeInSource,
} from './source-undo-rig.test-helper';

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

function mount(): { doc: Y.Doc; ytext: Y.Text; view: EditorView; um: Y.UndoManager } {
  const doc = new Y.Doc();
  const ytext = doc.getText('source');
  const awareness = new Awareness(doc);
  const parent = globalThis.document.createElement('div');
  globalThis.document.body.appendChild(parent);
  const { view, undoManager, destroy } = mountSourceUndoEditor({
    ytext,
    awareness,
    wiring: 'production',
    parent,
  });
  cleanups.push(() => {
    destroy();
    parent.remove();
    awareness.destroy();
    doc.destroy();
  });
  return { doc, ytext, view, um: undoManager };
}

/** The shipped single-root local write shape (`source: 'local'`, not paired). */
function reconstructLocalOrigin(originLabel: string): unknown {
  return Object.freeze({
    source: 'local' as const,
    skipStoreHooks: false,
    context: Object.freeze({ origin: originLabel }),
  });
}

interface WriteSurfaceCase {
  name: string;
  /** Perform the programmatic write that must never become an undoable frame. */
  write: (doc: Y.Doc, ytext: Y.Text) => void;
}

const CASES: WriteSurfaceCase[] = [
  {
    name: 'frontmatter form-write',
    write: (doc, ytext) => {
      doc.transact(() => ytext.insert(0, 'SURVIVES\n'), FORM_WRITE_ORIGIN);
    },
  },
  {
    // The PRODUCTION entry point. `applyLintFixes` stamps its own module-local
    // `LINT_FIX_ORIGIN` internally, so nothing about the origin is modelled
    // here — a change to that constant's shape lands in this row.
    name: 'markdownlint auto-fix',
    write: (doc, ytext) => {
      doc.transact(() => ytext.insert(0, 'SURVIVES  \n'), 'seed-with-trailing-spaces');
      const applied = applyLintFixes({ document: doc }, [
        {
          range: { start: { line: 0, character: 8 }, end: { line: 0, character: 10 } },
          newText: '',
        },
      ]);
      expect(applied).toBe(true);
    },
  },
  {
    name: 'chunked source paste',
    write: (doc, ytext) => {
      doc.transact(() => ytext.insert(0, 'SURVIVES\n'), reconstructLocalOrigin('source-paste'));
    },
  },
];

describe('write-surface origins are excluded from source-mode undo', () => {
  /**
   * The control. Without it, every row below is satisfied by ANY origin the
   * UndoManager does not track — including `{}` — because nothing shows the
   * second undo is capable of draining a frame in the first place.
   *
   */
  test('control: two tracked keystroke frames DO drain under two undos', () => {
    const { view, ytext, um } = mount();

    typeInSource(view, 'first');
    // y-codemirror's UndoManager coalesces edits inside one capture window;
    // `stopCapturing` is what makes these two SEPARATE frames.
    um.stopCapturing();
    typeInSource(view, '-second', ytext.length);
    expect(ytext.toString()).toBe('first-second');
    expect(um.undoStack.length).toBe(2);

    expect(runSourceUndo(view, 'production')).toBe(true);
    expect(ytext.toString()).toBe('first');
    expect(um.undoStack.length).toBe(1);

    // The second undo drains a further frame — the discriminator every row
    // below relies on.
    expect(runSourceUndo(view, 'production')).toBe(true);
    expect(ytext.toString()).toBe('');
    expect(um.undoStack.length).toBe(0);
  });

  for (const testCase of CASES) {
    test(`a ${testCase.name} survives repeated source-mode undo`, () => {
      const { doc, ytext, view, um } = mount();

      // A programmatic write under the write-surface origin — never a keystroke.
      testCase.write(doc, ytext);
      const programmatic = ytext.toString();
      expect(programmatic).toBe('SURVIVES\n');
      expect(view.state.doc.toString()).toBe(programmatic);
      // The direct oracle: the write produced NO undoable frame at all.
      expect(um.undoStack.length).toBe(0);

      // A real user keystroke — routed under the tracked local sync origin.
      um.stopCapturing();
      typeInSource(view, 'typed', ytext.length);
      expect(ytext.toString()).toBe(`${programmatic}typed`);
      // Exactly one frame: the keystroke's. Were the write-surface origin
      // tracked, the stopCapturing boundary above would have left two.
      expect(um.undoStack.length).toBe(1);

      // First undo reverts the keystroke; the write-surface content stays.
      expect(runSourceUndo(view, 'production')).toBe(true);
      expect(ytext.toString()).toBe(programmatic);
      expect(um.undoStack.length).toBe(0);

      // A second undo cannot touch the write-surface content — it never became
      // an undoable frame. The control above proves a second undo WOULD drain a
      // tracked frame, so surviving it is a fact about the origin.
      runSourceUndo(view, 'production');
      expect(ytext.toString()).toBe(programmatic);
    });
  }
});
