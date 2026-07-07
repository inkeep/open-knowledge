/**
 * Walk-currency contract for the Pattern D pre-warm path.
 *
 * `buildPatternDConstructorOptions` derives `content` + `ySyncOptions.mapping`
 * from one `initProseMirrorDoc` walk of the Y.XmlFragment, and supplying a
 * mapping makes y-tiptap's ySyncPlugin skip its on-mount `_forceRerender()`
 * (vendored `@tiptap/y-tiptap` 3.0.3, y-tiptap.cjs). The binding's Y
 * observer only registers at EditorView creation (`editor.mount(...)` in
 * mount-promise.ts), so the pair carries a client-owed precondition:
 *
 *   A prebuiltMapping/content pair may only be handed to ySyncPlugin if the
 *   fragment has not changed since the walk that produced them — otherwise
 *   the pair must be invalidated or reconciled at mount.
 *
 * These tests pin the user-observable contract, not a mechanism: a remote Y
 * update landing in the construct→mount gap (the post-construct
 * `scheduler.yield()` window, where provider WebSocket messages process)
 * must survive into the mounted PM doc, and the first post-mount
 * non-y-sync transaction (a selection-only click suffices) must not
 * republish a stale PM replica over the CRDT — erasing the remote edit for
 * every peer and disk. The gap edit is covered in both shapes: a text
 * append into a walked node AND a structural insert of a paragraph the
 * walk never saw (the prebuilt mapping has no entry for it).
 *
 * Harness drives the REAL production spine end-to-end at the dom tier:
 * real `buildPatternDConstructorOptions` (full extension list incl. the
 * binding-staleness guard), real `new Editor({ element: null, ... })`, real
 * `mountTiptapEditorPromise` construct→yield→mount window, real Y.Doc with
 * the remote edit applied as a provider would (`Y.applyUpdate` of an encoded
 * diff with a non-binding origin). The gap edit is queued as a microtask at
 * the end of `construct()` so it deterministically lands after construct
 * returns and before `editor.mount()` — the same window production opens
 * with `await scheduler.yield()`.
 *
 * Schema-instance independence: the gap edits touch only pre-existing node
 * types (paragraph), and no post-mount remote updates are applied. Any
 * mechanism restoring walk currency re-derives the changed nodes via the
 * view's own schema, so these assertions hold regardless of whether the
 * sibling pre-warm schema-identity defect is fixed first.
 *
 * Substrate note: jsdom globals are installed per-file (not the
 * `*.dom.test.tsx` RTL tier) via the shared walk-currency harness — see
 * `walk-currency-test-harness.ts` for the install/restore contract.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { HocuspocusProvider } from '@hocuspocus/provider';
import { Editor } from '@tiptap/core';
import type { Awareness } from 'y-protocols/awareness';
import type * as Y from 'yjs';
import { __resetCacheForTests, evictTiptapEditor } from './editor-cache';
import { __resetMountPromiseCache, mountTiptapEditorPromise } from './mount-promise';
import { buildPatternDConstructorOptions } from './TiptapEditor';
import {
  appendToFirstParagraph,
  applyRemoteEdit,
  buildSeededPatternDProvider,
  createGapOrderingRecorder,
  dispatchSelectionOnly,
  fakeClipboard,
  flushMicrotasksAndTimers,
  type GapOrderingRecorder,
  insertParagraphAt,
  installDomGlobals,
  viewCreationSignalExtension,
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

interface GapMountHarness {
  docName: string;
  ydoc: Y.Doc;
  fragment: Y.XmlFragment;
  awareness: Awareness;
  provider: HocuspocusProvider;
  /** Resolves with the mounted editor; the gap edit lands in the
   *  construct→mount window of this very mount cycle. */
  mountWithGapEdit: () => Promise<Editor>;
  /** Ordinals proving the gap edit landed BEFORE the EditorView was created
   *  (i.e. truly inside the construct→mount gap, not post-mount). */
  ordering: GapOrderingRecorder;
  cleanup: () => void;
}

/**
 * Stand up the full production mount spine for one doc and arrange for a
 * remote edit (`gapEdit`, applied to the seeded single-paragraph fragment)
 * to land in the construct→mount gap.
 *
 * The construct closure mirrors `TiptapEditor`'s exactly (options via
 * `buildPatternDConstructorOptions`, bundle shape per
 * `ConstructedTiptapBundle`). The gap edit is queued as a microtask at the
 * end of construct(): runMountBody's post-construct `await scheduler.yield()`
 * suspends on a macrotask, so the microtask — and with it the remote edit —
 * applies after construct() has returned and before `editor.mount()` runs.
 */
function createGapMountHarness(gapEdit: (fragment: Y.XmlFragment) => void): GapMountHarness {
  const {
    docName,
    ydoc,
    fragment,
    awareness,
    provider,
    cleanup: providerCleanup,
  } = buildSeededPatternDProvider('walk-currency');

  const ordering = createGapOrderingRecorder();

  const construct = () => {
    const ctorStart = performance.now();
    const options = buildPatternDConstructorOptions({
      provider,
      clipboard: fakeClipboard,
      ctorStart,
    });
    // Append a test-only plugin whose view() hook stamps the view-created
    // ordinal at EditorView construction (inside editor.mount()), so the
    // gap-edit-before-mount ordering can be asserted explicitly. Appending
    // an extension to the real options is the same seam the sibling
    // walk-currency-extension.test.ts inspects — production code is untouched.
    options.extensions = [...(options.extensions ?? []), viewCreationSignalExtension(ordering)];
    const editor = new Editor(options);
    queueMicrotask(() => {
      applyRemoteEdit(ydoc, gapEdit);
      ordering.recordGapEdit();
    });
    return {
      editor,
      ydoc,
      ytext: ydoc.getText('source'),
      provider,
    };
  };

  const mountWithGapEdit = async (): Promise<Editor> => {
    const entry = await mountTiptapEditorPromise({
      docName,
      mountId: randomUUID(),
      construct,
      sizeStats: { viewCount: 0, bytes: ydoc.getText('source').length },
    });
    await flushMicrotasksAndTimers();
    return entry.editor;
  };

  const cleanup = () => {
    evictTiptapEditor(docName);
    providerCleanup();
  };

  return { docName, ydoc, fragment, awareness, provider, mountWithGapEdit, ordering, cleanup };
}

/**
 * Assert the gap edit landed in the real construct→mount gap — applied AFTER
 * construct() returned and BEFORE the EditorView was created. Without this,
 * the behavioral assertions below would still pass if the edit landed
 * post-mount (the binding's own observer would handle it), making the suite a
 * vacuous green that never exercises the walk-currency guard. Guards against a
 * `scheduler.yield()` regression that resolves on the microtask queue.
 */
function expectGapEditLandedBeforeMount(ordering: GapOrderingRecorder): void {
  expect(ordering.gapEditOrdinal).not.toBeNull();
  expect(ordering.viewCreatedOrdinal).not.toBeNull();
  expect(ordering.gapEditOrdinal).toBeLessThan(ordering.viewCreatedOrdinal as number);
}

const appendGapEdit = (frag: Y.XmlFragment): void => appendToFirstParagraph(frag, ' GAPEDIT');

afterEach(() => {
  __resetMountPromiseCache();
  __resetCacheForTests();
});

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

describe('Pattern D walk currency (construct→mount gap)', () => {
  test('a remote update landing between construct and mount survives into the mounted PM doc', async () => {
    const harness = createGapMountHarness(appendGapEdit);
    try {
      const editor = await harness.mountWithGapEdit();

      // Guard: the gap edit must have landed in the construct→mount gap — if
      // it ever lands post-mount, the assertions below pass vacuously.
      expectGapEditLandedBeforeMount(harness.ordering);

      // Sanity: the gap edit actually landed in the CRDT before/independent
      // of mount (harness wiring, not the contract under test).
      const yXml = harness.fragment.toString();
      const pmText = editor.state.doc.textContent;

      // Contract: the mounted PM doc reflects the fragment as of view-bind
      // time — the gap update is present alongside the seeded content...
      expect(pmText).toContain('GAPEDIT');
      expect(pmText).toContain('hello world');
      // ...and mounting did not republish a stale replica over the CRDT
      // (the mount-time-resurrection shape of the same violation).
      expect(yXml).toContain('GAPEDIT');
      expect(yXml).toContain('hello world');
    } finally {
      harness.cleanup();
    }
  });

  test('a post-mount selection-only transaction does not erase the gap update from the CRDT', async () => {
    const harness = createGapMountHarness(appendGapEdit);
    try {
      const editor = await harness.mountWithGapEdit();

      // Guard: the gap edit must have landed in the construct→mount gap — if
      // it ever lands post-mount, the assertions below pass vacuously.
      expectGapEditLandedBeforeMount(harness.ordering);

      // The "one click": the first post-mount transaction without y-sync
      // meta. With a stale binding this is the resurrection channel — the
      // binding republishes its PM replica wholesale into Y.
      dispatchSelectionOnly(editor);
      await flushMicrotasksAndTimers();

      const yXml = harness.fragment.toString();
      expect(yXml).toContain('GAPEDIT');
      expect(yXml).toContain('hello world');
      // And the editor itself still shows the merged content.
      expect(editor.state.doc.textContent).toContain('GAPEDIT');
      expect(editor.state.doc.textContent).toContain('hello world');
    } finally {
      harness.cleanup();
    }
  });

  test('a remote paragraph inserted in the construct→mount gap survives mount and the first post-mount transaction', async () => {
    // Structural shape of the same contract: the gap edit adds a node the
    // pre-warm walk never saw (no prebuilt-mapping entry exists for it),
    // rather than mutating a walked node's text.
    const harness = createGapMountHarness((frag) => insertParagraphAt(frag, 1, 'GAPPARAGRAPH'));
    try {
      const editor = await harness.mountWithGapEdit();

      // Guard: the gap edit must have landed in the construct→mount gap — if
      // it ever lands post-mount, the assertions below pass vacuously.
      expectGapEditLandedBeforeMount(harness.ordering);

      expect(editor.state.doc.textContent).toContain('GAPPARAGRAPH');
      expect(editor.state.doc.textContent).toContain('hello world');
      expect(harness.fragment.toString()).toContain('GAPPARAGRAPH');

      // The "one click" resurrection channel must not erase the inserted
      // paragraph from the CRDT either.
      dispatchSelectionOnly(editor);
      await flushMicrotasksAndTimers();

      const yXml = harness.fragment.toString();
      expect(yXml).toContain('GAPPARAGRAPH');
      expect(yXml).toContain('hello world');
      expect(editor.state.doc.textContent).toContain('GAPPARAGRAPH');
      expect(editor.state.doc.textContent).toContain('hello world');
    } finally {
      harness.cleanup();
    }
  });
});
