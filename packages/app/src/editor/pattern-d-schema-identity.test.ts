/**
 * Schema-instance identity contract for the Pattern D pre-warm path.
 *
 * `buildPatternDConstructorOptions` walks the Y.XmlFragment once
 * (`initProseMirrorDoc`) to derive the prebuilt `content` and the
 * `ySyncOptions.mapping` handed to y-tiptap's ySyncPlugin. ProseMirror
 * content matching is NodeType-identity-based, so every node in that pair
 * must belong to the SAME Schema instance the bound EditorView uses (or the
 * pair must be rebuilt against the editor's schema before bind). When the
 * walk runs against a different Schema instance, the binding's incremental
 * rebuild reuses still-cached foreign-schema nodes for unchanged siblings and
 * ProseMirror's replace fitter silently drops them.
 *
 * These tests pin the user-observable contract, not the mechanism:
 *
 *   After a Pattern D mount with NO fragment change in the construct→mount
 *   window, an incremental remote update must leave unchanged sibling
 *   content intact in the mounted PM doc, and the next user transaction
 *   (a selection-only click suffices) must not erase that content from the
 *   CRDT (which would propagate the loss to every peer and disk).
 *
 * No gap-timing dependence: construct and mount run back-to-back with no
 * fragment change between them, and the remote update is applied strictly
 * post-mount (the sibling walk-currency contract in
 * `pattern-d-walk-currency.test.ts` owns the construct→mount-gap shape; its
 * fix mechanism is irrelevant here because the gap never opens).
 *
 * Harness drives the REAL production spine at the dom tier: real
 * `buildPatternDConstructorOptions` (full extension list), real
 * `new Editor({ element: null, ... })` + `editor.mount(host)` (the same
 * construct/mount pair mount-promise.ts performs), real Y.Doc with the
 * remote edit applied as a provider would (`Y.applyUpdate` of an encoded
 * diff with a non-binding origin).
 *
 * Substrate note: jsdom globals are installed per-file (not the
 * `*.dom.test.tsx` RTL tier) via the shared walk-currency harness — see
 * `walk-currency-test-harness.ts` for the install/restore contract.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Editor } from '@tiptap/core';
import type * as Y from 'yjs';
import { buildPatternDConstructorOptions } from './TiptapEditor';
import {
  applyRemoteEdit,
  buildSeededPatternDProvider,
  dispatchSelectionOnly,
  fakeClipboard,
  flushMicrotasksAndTimers,
  insertParagraphAt,
  installDomGlobals,
  seedFragmentParagraph,
} from './walk-currency-test-harness';

let restoreDomGlobals: (() => void) | null = null;

beforeAll(() => {
  restoreDomGlobals = installDomGlobals();
});

afterAll(() => {
  restoreDomGlobals?.();
  restoreDomGlobals = null;
});

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface MountedPatternDHarness {
  editor: Editor;
  ydoc: Y.Doc;
  fragment: Y.XmlFragment;
  cleanup: () => void;
}

/**
 * Stand up a Pattern D editor for one doc and mount it immediately — no
 * fragment change lands between `buildPatternDConstructorOptions`'s walk and
 * the view bind, so the prebuilt content/mapping pair is current at mount
 * and the walk-currency guard has nothing to reconcile. Everything these
 * tests assert about happens strictly post-mount.
 */
async function mountPatternDEditor(
  seed: (ydoc: Y.Doc) => void = (ydoc) => seedFragmentParagraph(ydoc, 'hello world'),
): Promise<MountedPatternDHarness> {
  const {
    ydoc,
    fragment,
    provider,
    cleanup: providerCleanup,
  } = buildSeededPatternDProvider('schema-identity', seed);

  const options = buildPatternDConstructorOptions({
    provider,
    clipboard: fakeClipboard,
    ctorStart: performance.now(),
  });
  const editor = new Editor(options);
  const host = document.createElement('div');
  document.body.appendChild(host);
  editor.mount(host);
  await flushMicrotasksAndTimers();

  const cleanup = () => {
    editor.destroy();
    host.remove();
    providerCleanup();
  };
  return { editor, ydoc, fragment, cleanup };
}

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

describe('Pattern D schema-instance identity (post-mount incremental updates)', () => {
  test('an unchanged sibling paragraph survives a post-mount remote paragraph insert', async () => {
    const harness = await mountPatternDEditor();
    try {
      // Incremental remote update: a NEW paragraph the pre-warm walk never
      // saw, leaving the seeded paragraph untouched.
      applyRemoteEdit(harness.ydoc, (frag) => insertParagraphAt(frag, 1, 'second paragraph'));
      await flushMicrotasksAndTimers();

      const pmText = harness.editor.state.doc.textContent;
      // The update itself lands...
      expect(pmText).toContain('second paragraph');
      // ...and the unchanged sibling is still in the visible editor.
      expect(pmText).toContain('hello world');

      // The CRDT was never the problem at this point — both paragraphs are
      // in the fragment (pinned so a failure above is unambiguously a PM-side
      // drop, not a harness wiring issue).
      const yXml = harness.fragment.toString();
      expect(yXml).toContain('second paragraph');
      expect(yXml).toContain('hello world');
    } finally {
      harness.cleanup();
    }
  });

  test('the first post-update user transaction does not erase the unchanged paragraph from the CRDT', async () => {
    const harness = await mountPatternDEditor();
    try {
      applyRemoteEdit(harness.ydoc, (frag) => insertParagraphAt(frag, 1, 'second paragraph'));
      await flushMicrotasksAndTimers();

      // The "one click": the first post-update transaction without y-sync
      // meta. With a PM-side drop this is the resurrection channel — the
      // binding republishes its dropped-paragraph replica wholesale into Y,
      // erasing the content for every peer and disk.
      dispatchSelectionOnly(harness.editor);
      await flushMicrotasksAndTimers();

      const yXml = harness.fragment.toString();
      expect(yXml).toContain('hello world');
      expect(yXml).toContain('second paragraph');
      const pmText = harness.editor.state.doc.textContent;
      expect(pmText).toContain('hello world');
      expect(pmText).toContain('second paragraph');
    } finally {
      harness.cleanup();
    }
  });

  test('an unchanged paragraph survives a post-mount remote text edit inside a DIFFERENT walked paragraph', async () => {
    // Second incremental-update shape: the remote edit mutates text inside an
    // existing walked node rather than inserting a node the walk never saw.
    // The unchanged sibling (paragraph 0) must survive in PM and, after the
    // first user transaction, in the CRDT.
    const harness = await mountPatternDEditor((ydoc) => {
      seedFragmentParagraph(ydoc, 'hello world');
      insertParagraphAt(ydoc.getXmlFragment('default'), 1, 'closing notes');
    });
    try {
      applyRemoteEdit(harness.ydoc, (frag) => {
        const second = frag.get(1) as Y.XmlElement;
        const text = second.get(0) as Y.XmlText;
        text.insert(text.length, ' EDITED');
      });
      await flushMicrotasksAndTimers();

      const pmText = harness.editor.state.doc.textContent;
      expect(pmText).toContain('closing notes EDITED');
      expect(pmText).toContain('hello world');

      dispatchSelectionOnly(harness.editor);
      await flushMicrotasksAndTimers();

      const yXml = harness.fragment.toString();
      expect(yXml).toContain('hello world');
      expect(yXml).toContain('closing notes EDITED');
    } finally {
      harness.cleanup();
    }
  });

  test('an unchanged sibling paragraph survives a post-mount remote prepend insert', async () => {
    // Prepend (index 0) was the production shape that surfaced the bug: the
    // unchanged original paragraph shifts to index 1, exercising a different
    // fragment-child-list iteration path in y-tiptap's rebuild than the
    // index>=1 inserts above.
    const harness = await mountPatternDEditor();
    try {
      applyRemoteEdit(harness.ydoc, (frag) => insertParagraphAt(frag, 0, 'prepended paragraph'));
      await flushMicrotasksAndTimers();

      const pmText = harness.editor.state.doc.textContent;
      expect(pmText).toContain('prepended paragraph');
      expect(pmText).toContain('hello world');

      // Same disambiguation pin: both paragraphs in the fragment,
      // so a failure above is unambiguously a PM-side drop.
      const yXml = harness.fragment.toString();
      expect(yXml).toContain('prepended paragraph');
      expect(yXml).toContain('hello world');
    } finally {
      harness.cleanup();
    }
  });

  test('repeated incremental remote inserts never drop the original paragraph', async () => {
    // The blast radius is per-still-mapped-node: every incremental update
    // re-exposes whichever prebuilt entries remain. Pin that a short sequence
    // of inserts (each one item-preserving) leaves the seeded paragraph
    // intact throughout — not just after the first update.
    const harness = await mountPatternDEditor();
    try {
      for (let i = 1; i <= 3; i += 1) {
        applyRemoteEdit(harness.ydoc, (frag) =>
          insertParagraphAt(frag, frag.length, `update ${i}`),
        );
        await flushMicrotasksAndTimers();
        expect(harness.editor.state.doc.textContent).toContain('hello world');
        expect(harness.editor.state.doc.textContent).toContain(`update ${i}`);
      }

      // Stale-mapping accumulation could defer the erasure to the Nth update
      // rather than the 1st, so the resurrection channel needs pinning here
      // too: the first post-loop user transaction must not republish a
      // dropped-paragraph replica into Y.
      const yXml = harness.fragment.toString();
      expect(yXml).toContain('hello world');
      for (let i = 1; i <= 3; i += 1) {
        expect(yXml).toContain(`update ${i}`);
      }
      dispatchSelectionOnly(harness.editor);
      await flushMicrotasksAndTimers();
      const postClickYXml = harness.fragment.toString();
      expect(postClickYXml).toContain('hello world');
      for (let i = 1; i <= 3; i += 1) {
        expect(postClickYXml).toContain(`update ${i}`);
      }
    } finally {
      harness.cleanup();
    }
  });
});
