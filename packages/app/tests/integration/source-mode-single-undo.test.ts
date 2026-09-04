import { undoDepth } from '@codemirror/commands';
import type { EditorView } from '@codemirror/view';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';
import { installDomGlobals } from '../../src/editor/walk-currency-test-harness';
import {
  applyRemoteSourceEdit,
  installCmMeasurementStubs,
  mountSourceUndoEditor,
  runSourceUndo,
  type SourceUndoWiring,
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

interface Rig {
  doc: Y.Doc;
  ytext: Y.Text;
  view: EditorView;
}

function mount(wiring: SourceUndoWiring, seed = ''): Rig {
  const doc = new Y.Doc();
  const ytext = doc.getText('source');
  if (seed) ytext.insert(0, seed);
  const awareness = new Awareness(doc);
  const parent = globalThis.document.createElement('div');
  globalThis.document.body.appendChild(parent);
  const { view, destroy } = mountSourceUndoEditor({ ytext, awareness, wiring, parent });
  cleanups.push(() => {
    destroy();
    parent.remove();
    awareness.destroy();
    doc.destroy();
  });
  return { doc, ytext, view };
}

describe('source-mode single origin-aware undo (production wiring)', () => {
  test('a source edit registers no CodeMirror native undo history', () => {
    const { view, ytext } = mount('production');

    typeInSource(view, 'hello');
    expect(ytext.toString()).toBe('hello');
    expect(undoDepth(view.state)).toBe(0);

    runSourceUndo(view, 'production');
    expect(view.state.doc.toString()).toBe('');
    expect(ytext.toString()).toBe('');
  });

  test('undo reverts the user edit but never a remote write (origin-blind negative)', () => {
    const { view, doc, ytext } = mount('production');

    applyRemoteSourceEdit(doc, (t) => t.insert(0, 'REMOTE\n'));
    expect(view.state.doc.toString()).toBe('REMOTE\n');

    typeInSource(view, 'local');
    expect(ytext.toString()).toBe('REMOTE\nlocal');

    runSourceUndo(view, 'production');
    expect(ytext.toString()).toBe('REMOTE\n');
    expect(view.state.doc.toString()).toBe('REMOTE\n');
  });

  test('undo is a no-op when only remote content is present', () => {
    const { view, doc, ytext } = mount('production');

    applyRemoteSourceEdit(doc, (t) => t.insert(0, 'REMOTE\n'));

    runSourceUndo(view, 'production');
    expect(ytext.toString()).toBe('REMOTE\n');
    expect(view.state.doc.toString()).toBe('REMOTE\n');
  });
});

describe('source-mode undo pre-fix characterization (legacy CodeMirror history)', () => {
  test('native history reverts a remote write (the origin-blind defect this fix removes)', () => {
    const { view, doc } = mount('legacy');

    applyRemoteSourceEdit(doc, (t) => t.insert(0, 'REMOTE\n'));
    expect(view.state.doc.toString()).toBe('REMOTE\n');
    expect(undoDepth(view.state)).toBeGreaterThan(0);

    runSourceUndo(view, 'legacy');
    expect(view.state.doc.toString()).not.toContain('REMOTE');
  });
});
