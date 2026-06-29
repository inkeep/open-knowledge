
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


describe('Pattern D walk currency (construct→mount gap)', () => {
  test('a remote update landing between construct and mount survives into the mounted PM doc', async () => {
    const harness = createGapMountHarness(appendGapEdit);
    try {
      const editor = await harness.mountWithGapEdit();

      expectGapEditLandedBeforeMount(harness.ordering);

      const yXml = harness.fragment.toString();
      const pmText = editor.state.doc.textContent;

      expect(pmText).toContain('GAPEDIT');
      expect(pmText).toContain('hello world');
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

      expectGapEditLandedBeforeMount(harness.ordering);

      dispatchSelectionOnly(editor);
      await flushMicrotasksAndTimers();

      const yXml = harness.fragment.toString();
      expect(yXml).toContain('GAPEDIT');
      expect(yXml).toContain('hello world');
      expect(editor.state.doc.textContent).toContain('GAPEDIT');
      expect(editor.state.doc.textContent).toContain('hello world');
    } finally {
      harness.cleanup();
    }
  });

  test('a remote paragraph inserted in the construct→mount gap survives mount and the first post-mount transaction', async () => {
    const harness = createGapMountHarness((frag) => insertParagraphAt(frag, 1, 'GAPPARAGRAPH'));
    try {
      const editor = await harness.mountWithGapEdit();

      expectGapEditLandedBeforeMount(harness.ordering);

      expect(editor.state.doc.textContent).toContain('GAPPARAGRAPH');
      expect(editor.state.doc.textContent).toContain('hello world');
      expect(harness.fragment.toString()).toContain('GAPPARAGRAPH');

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
