import { prependFrontmatter } from '@inkeep/open-knowledge-core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { updateYFragment, yXmlFragmentToProseMirrorRootNode } from '@tiptap/y-tiptap';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import * as Y from 'yjs';

import { deriveFragmentFromYtext } from '../../../server/src/bridge-intake.ts';
import type { DeriveLossObservation } from '../../../server/src/bridge-loss-detector.ts';
import { detectPairedIntakeLoss } from '../../../server/src/bridge-loss-detector.ts';
import {
  insertLocal,
  mountCollabEditor,
  readUndoManager,
} from '../../src/editor/editor-rig.test-helper';
import { installDomGlobals } from '../../src/editor/walk-currency-test-harness';
import { mdManager, schema } from './test-harness';

let restoreDom: (() => void) | null = null;
beforeAll(() => {
  restoreDom = installDomGlobals();
}, 30_000);
afterAll(() => {
  restoreDom?.();
});

function makeHarmlessPlugin(name: string): Plugin {
  return new Plugin({ key: new PluginKey(name) });
}

describe('client undo survives editor plugin churn', () => {
  test('baseline: typing then undo reverts the edit (undo alive without any reconfigure)', () => {
    const ydoc = new Y.Doc();
    const editor = mountCollabEditor(ydoc, []);
    try {
      const um = readUndoManager(editor);
      expect(um).not.toBeNull();

      insertLocal(editor, 'hello world', 1);
      expect(editor.state.doc.textContent).toContain('hello world');
      expect((um as Y.UndoManager).undoStack.length).toBeGreaterThan(0);

      (um as Y.UndoManager).undo();
      expect(editor.state.doc.textContent).not.toContain('hello world');
    } finally {
      editor.destroy();
    }
  });

  test('registerPlugin before the first keystroke does not kill undo', () => {
    const ydoc = new Y.Doc();
    const editor = mountCollabEditor(ydoc, []);
    try {
      const umBefore = readUndoManager(editor) as Y.UndoManager;
      expect(umBefore).not.toBeNull();

      const obs = (ydoc as unknown as { _observers: Map<string, Set<unknown>> })._observers;
      const beforeHandlers = obs.get('afterTransaction')?.size ?? 0;

      editor.registerPlugin(makeHarmlessPlugin('probe-flash'));

      const umAfter = readUndoManager(editor) as Y.UndoManager;
      const afterHandlers = obs.get('afterTransaction')?.size ?? 0;

      insertLocal(editor, 'typed after register', 1);
      const captured = umAfter.undoStack.length;
      umAfter.undo();
      const revertedByUndo = !editor.state.doc.textContent.includes('typed after register');

      expect(umAfter).toBe(umBefore);
      expect(afterHandlers).toBe(beforeHandlers);
      expect(captured).toBeGreaterThan(0);
      expect(revertedByUndo).toBe(true);
    } finally {
      editor.destroy();
    }
  });

  test('register + unregister churn also preserves undo', () => {
    const ydoc = new Y.Doc();
    const editor = mountCollabEditor(ydoc, []);
    try {
      const key = new PluginKey('probe-removable');
      editor.registerPlugin(new Plugin({ key }));
      editor.unregisterPlugin(key);

      const um = readUndoManager(editor) as Y.UndoManager;
      insertLocal(editor, 'edit after churn', 1);
      const captured = um.undoStack.length;
      um.undo();
      const reverted = !editor.state.doc.textContent.includes('edit after churn');
      expect(captured).toBeGreaterThan(0);
      expect(reverted).toBe(true);
    } finally {
      editor.destroy();
    }
  });
});

function applyToFragment(doc: Y.Doc, frag: Y.XmlFragment, md: string, origin?: string): void {
  const parsed = mdManager.parse(md);
  const pmNode = schema.nodeFromJSON(parsed);
  doc.transact(() => {
    updateYFragment(doc, frag, pmNode, { mapping: new Map(), isOMark: new Map() });
  }, origin);
}

function serializeFrag(frag: Y.XmlFragment): string {
  return mdManager.serialize(yXmlFragmentToProseMirrorRootNode(frag, schema).toJSON());
}

describe('the derive-from-Y.Text primitive reports what its rebuild discards', () => {
  test('a re-derive over an un-propagated keystroke reports it as lost with a restore payload', () => {
    const doc = new Y.Doc();
    const ytext = doc.getText('source');
    const frag = doc.getXmlFragment('default');

    const base = '# Doc\n\nuser paragraph\n';
    doc.transact(() => ytext.insert(0, prependFrontmatter('', base)), 'seed');
    applyToFragment(doc, frag, base, 'seed');

    const um = new Y.UndoManager(ytext, {
      trackedOrigins: new Set(['agent']),
      captureTimeout: 0,
    });
    doc.transact(() => {
      ytext.insert(ytext.toString().length, '\nagent line\n');
      deriveFragmentFromYtext(doc);
    }, 'agent');

    applyToFragment(
      doc,
      frag,
      '# Doc\n\nuser paragraph\n\nagent line\n\nfresh keystroke\n',
      'user',
    );
    expect(serializeFrag(frag)).toContain('fresh keystroke');
    expect(ytext.toString()).not.toContain('fresh keystroke');

    const baselineFullMd = ytext.toString();
    const observations: DeriveLossObservation[] = [];
    um.undo();
    doc.transact(() => {
      deriveFragmentFromYtext(doc, undefined, {
        baselineFullMd,
        report: (obs) => observations.push(obs),
      });
    }, 'agent-undo');

    expect(observations).toHaveLength(1);
    const lost = detectPairedIntakeLoss(observations[0] as DeriveLossObservation);

    expect(lost.join('\n')).toContain('fresh keystroke');
    expect(lost.join('\n')).not.toContain('agent line');
    expect(observations[0]?.restorePayload).toContain('fresh keystroke');

    const finalFrag = serializeFrag(frag);
    expect(finalFrag).not.toContain('agent line');
    expect(finalFrag).toContain('user paragraph');
  });
});
