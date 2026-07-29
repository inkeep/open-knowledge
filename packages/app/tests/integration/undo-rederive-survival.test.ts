/**
 * CONTRACT — client WYSIWYG undo survives editor plugin churn, and the
 * derive-from-Y.Text primitive reports the un-propagated fragment content its
 * rebuild discards.
 *
 * Two pins:
 *
 * 1. Plugin-churn undo survival. The upstream y-prosemirror plugin-lifecycle
 *    bug (UndoManager destroyed on plugin reconfigure) IS present in the
 *    pinned y-tiptap dist: yUndoPlugin's state.init mints the UndoManager
 *    once; the plugin view's destroy() calls undoManager.destroy();
 *    EditorState.reconfigure reuses the existing plugin field, so init never
 *    re-runs and the manager is never re-minted. TipTap's Collaboration
 *    extension neutralizes it — its addProseMirrorPlugins wraps the plugin
 *    view so destroy() snapshots trackedOrigins + observers into
 *    undoManager.restore, and the next view creation re-attaches the doc
 *    afterTransaction capture handler. OK relies on this (the
 *    ok/cache/undo-manager-read-failed guard in editor-cache). Production
 *    hits this reconfigure on every mount: a deferred registerPlugin for the
 *    agent-write flash, unregistered on cleanup. Contract: undo stays alive
 *    across registerPlugin / unregisterPlugin driven through the PUBLIC
 *    editor interface.
 *
 * 2. Derive-from-Y.Text loss DETECTION. The production
 *    `deriveFragmentFromYtext` (imported, not reproduced) rebuilds the
 *    fragment from Y.Text's bytes, so a WYSIWYG keystroke still living only
 *    in the fragment is discarded by the rebuild. The contract this pins is
 *    NOT that the stomp happens — pinning the bug leaves the test green if
 *    the bug is fixed — but that the primitive's `detect` branch OBSERVES it:
 *    the reporter names the discarded line and hands back a restore payload
 *    that still carries it. That branch is the loss detection this program
 *    adds, and a reproduced copy of the derive body structurally cannot see it.
 *
 * A flip in pin 1 (undo dies on plugin churn) is an undo-topology regression.
 *
 */

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

/** A harmless PM plugin to force a plugins-array reconfigure. */
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

      // The doc's live afterTransaction capture handlers before the reconfigure.
      const obs = (ydoc as unknown as { _observers: Map<string, Set<unknown>> })._observers;
      const beforeHandlers = obs.get('afterTransaction')?.size ?? 0;

      // The production trigger: a deferred registerPlugin fires right after
      // mount, before the user has typed.
      editor.registerPlugin(makeHarmlessPlugin('probe-flash'));

      const umAfter = readUndoManager(editor) as Y.UndoManager;
      const afterHandlers = obs.get('afterTransaction')?.size ?? 0;

      insertLocal(editor, 'typed after register', 1);
      const captured = umAfter.undoStack.length;
      umAfter.undo();
      const revertedByUndo = !editor.state.doc.textContent.includes('typed after register');

      // state.init did NOT re-run, so the manager object is the same (the
      // upstream lifecycle-bug surface)...
      expect(umAfter).toBe(umBefore);
      // ...but the capture handler was restored (destroy re-added it)...
      expect(afterHandlers).toBe(beforeHandlers);
      // ...so the post-reconfigure edit IS captured and undo IS alive.
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
  /**
   * Stage the loss window the primitive's detector exists for: Y.Text holds an
   * agent write, the fragment additionally holds a keystroke Observer A has not
   * propagated yet, and the post-undo re-derive is about to rebuild over it.
   *
   * The undo itself is modelled with a Y.Text-scoped `Y.UndoManager` — the
   * primitive's documented pre-state contract is "ytext already holds the
   * post-undo bytes", and the shipped `applyAgentUndo` spine that produces them
   * is covered at its own rung in `agent-undo.test.ts`. What is under test here
   * is the primitive itself, imported from production.
   *
   */
  test('a re-derive over an un-propagated keystroke reports it as lost with a restore payload', () => {
    const doc = new Y.Doc();
    const ytext = doc.getText('source');
    const frag = doc.getXmlFragment('default');

    const base = '# Doc\n\nuser paragraph\n';
    doc.transact(() => ytext.insert(0, prependFrontmatter('', base)), 'seed');
    applyToFragment(doc, frag, base, 'seed');

    // Agent write captured under an UndoManager tracking Y.Text.
    const um = new Y.UndoManager(ytext, {
      trackedOrigins: new Set(['agent']),
      captureTimeout: 0,
    });
    doc.transact(() => {
      ytext.insert(ytext.toString().length, '\nagent line\n');
      deriveFragmentFromYtext(doc);
    }, 'agent');

    // Concurrent user keystroke lands in the FRAGMENT only (Observer A debounce
    // window: Y.Text does not yet have it).
    applyToFragment(
      doc,
      frag,
      '# Doc\n\nuser paragraph\n\nagent line\n\nfresh keystroke\n',
      'user',
    );
    expect(serializeFrag(frag)).toContain('fresh keystroke');
    expect(ytext.toString()).not.toContain('fresh keystroke');

    // Agent-undo: revert Y.Text agent items, then re-derive fragment from Y.Text
    // WITH the detector wired — the baseline is the pre-undo Y.Text, so content
    // the undo legitimately removed is excluded from the loss verdict.
    const baselineFullMd = ytext.toString();
    const observations: DeriveLossObservation[] = [];
    um.undo();
    doc.transact(() => {
      deriveFragmentFromYtext(doc, undefined, {
        baselineFullMd,
        report: (obs) => observations.push(obs),
      });
    }, 'agent-undo');

    // The detector ran exactly once for the one derive.
    expect(observations).toHaveLength(1);
    const lost = detectPairedIntakeLoss(observations[0] as DeriveLossObservation);

    // It names the never-propagated keystroke...
    expect(lost.join('\n')).toContain('fresh keystroke');
    // ...and NOT the agent line, which the undo removed on purpose — a detector
    // that reported every removed line would be noise, not a loss signal.
    expect(lost.join('\n')).not.toContain('agent line');
    // The restore payload still carries the discarded content, so the checkpoint
    // floor built on it has something to restore.
    expect(observations[0]?.restorePayload).toContain('fresh keystroke');

    const finalFrag = serializeFrag(frag);
    // Undo intent honored: the agent line is gone from the fragment too.
    expect(finalFrag).not.toContain('agent line');
    // Non-vacuity: the rebuild produced a real document, not an empty one.
    expect(finalFrag).toContain('user paragraph');
  });
});
