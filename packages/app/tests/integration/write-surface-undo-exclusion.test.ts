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

function reconstructLocalOrigin(originLabel: string): unknown {
  return Object.freeze({
    source: 'local' as const,
    skipStoreHooks: false,
    context: Object.freeze({ origin: originLabel }),
  });
}

interface WriteSurfaceCase {
  name: string;
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
  test('control: two tracked keystroke frames DO drain under two undos', () => {
    const { view, ytext, um } = mount();

    typeInSource(view, 'first');
    um.stopCapturing();
    typeInSource(view, '-second', ytext.length);
    expect(ytext.toString()).toBe('first-second');
    expect(um.undoStack.length).toBe(2);

    expect(runSourceUndo(view, 'production')).toBe(true);
    expect(ytext.toString()).toBe('first');
    expect(um.undoStack.length).toBe(1);

    expect(runSourceUndo(view, 'production')).toBe(true);
    expect(ytext.toString()).toBe('');
    expect(um.undoStack.length).toBe(0);
  });

  for (const testCase of CASES) {
    test(`a ${testCase.name} survives repeated source-mode undo`, () => {
      const { doc, ytext, view, um } = mount();

      testCase.write(doc, ytext);
      const programmatic = ytext.toString();
      expect(programmatic).toBe('SURVIVES\n');
      expect(view.state.doc.toString()).toBe(programmatic);
      expect(um.undoStack.length).toBe(0);

      um.stopCapturing();
      typeInSource(view, 'typed', ytext.length);
      expect(ytext.toString()).toBe(`${programmatic}typed`);
      expect(um.undoStack.length).toBe(1);

      expect(runSourceUndo(view, 'production')).toBe(true);
      expect(ytext.toString()).toBe(programmatic);
      expect(um.undoStack.length).toBe(0);

      runSourceUndo(view, 'production');
      expect(ytext.toString()).toBe(programmatic);
    });
  }
});
