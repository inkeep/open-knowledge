/**
 * Procedural surfaces of the walk-currency extension. The user-observable
 * walk-currency contract itself (gap edit survives into the mounted PM doc;
 * no CRDT erasure on the first post-mount transaction) is pinned by
 * `pattern-d-walk-currency.test.ts`; this file pins the surfaces around it:
 *
 *  - disarm branch: a missing ySync binding (or a binding without
 *    `_forceRerender`) at view init fails open-but-loud — console.warn, no
 *    throw, editor stays usable (mirrors the staleness guard's disarm
 *    precedent)
 *  - never-mounted cleanup: mount-promise abort/invalidate destroys the
 *    pre-mount editor, and `onDestroy` unhooks the fragment observer even
 *    though the plugin view never initialized
 *  - non-stale fast path: a quiet construct→mount gap triggers no
 *    `_forceRerender` — the prebuilt mapping (same instance, same entries)
 *    survives into the mounted binding, preserving the pre-warm contract
 *  - wiring arms: the extension is present in the extension list exactly
 *    when a `prebuiltMapping` is supplied
 *
 * Substrate note: jsdom globals are installed per-file (not the
 * `*.dom.test.tsx` RTL tier) via the shared walk-currency harness — see
 * `walk-currency-test-harness.ts` for the install/restore contract.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { HocuspocusProvider } from '@hocuspocus/provider';
import { Editor, Extension, getSchema } from '@tiptap/core';
import { Plugin, type PluginKey } from '@tiptap/pm/state';
import { initProseMirrorDoc, ySyncPluginKey } from '@tiptap/y-tiptap';
import { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';
import { __resetCacheForTests, evictTiptapEditor } from './editor-cache';
import { sharedExtensions } from './extensions/shared';
import {
  __resetMountPromiseCache,
  invalidateMountPromise,
  mountTiptapEditorPromise,
} from './mount-promise';
import { buildExtensionList, buildPatternDConstructorOptions } from './TiptapEditor';
import { walkCurrencyExtension } from './walk-currency-extension';
import {
  appendToFirstParagraph,
  fakeClipboard,
  flushMicrotasksAndTimers,
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

afterEach(() => {
  __resetMountPromiseCache();
  __resetCacheForTests();
});

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

function makeProvider(docName: string): {
  ydoc: Y.Doc;
  fragment: Y.XmlFragment;
  awareness: Awareness;
  provider: HocuspocusProvider;
  cleanup: () => void;
} {
  const ydoc = new Y.Doc();
  seedFragmentParagraph(ydoc, 'hello world');
  const fragment = ydoc.getXmlFragment('default');
  const awareness = new Awareness(ydoc);
  const provider = {
    document: ydoc,
    configuration: { name: docName },
    awareness,
  } as unknown as HocuspocusProvider;
  return {
    ydoc,
    fragment,
    awareness,
    provider,
    cleanup: () => {
      awareness.destroy();
      ydoc.destroy();
    },
  };
}

/** yjs stores deep observers as a filterable handler list; its length is the
 *  only observable signal that a never-mounted editor's observer was
 *  unhooked (the dirty flag is closure-private and nothing consumes it after
 *  destroy). Internal to yjs — re-verify on a yjs bump. */
function deepObserverCount(fragment: Y.XmlFragment): number {
  return (fragment as unknown as { _dEH: { l: unknown[] } })._dEH.l.length;
}

/** Mirrors the vendored ySyncPlugin's state contract enough for the disarm
 *  arms: a plugin registered under the real `ySyncPluginKey` whose state
 *  carries (or omits) a binding — the same surface the extension reads via
 *  `ySyncPluginKey.getState(...)` in production. */
function createYSyncStandIn(binding?: Record<string, unknown>): Plugin {
  return new Plugin({
    key: ySyncPluginKey as unknown as PluginKey,
    state: {
      init: () => ({
        snapshot: null,
        prevSnapshot: null,
        isChangeOrigin: false,
        ...(binding ? { binding } : {}),
      }),
      apply: (_tr, pluginState) => pluginState,
    },
  });
}

/** Capture console.warn lines for the duration of `fn`. */
function captureWarnings<T>(fn: () => T): { result: T; warnings: string[] } {
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(String(args[0]));
  };
  try {
    return { result: fn(), warnings };
  } finally {
    console.warn = originalWarn;
  }
}

// ---------------------------------------------------------------------------
// Disarm branch (vendored-seam drift)
// ---------------------------------------------------------------------------

describe('disarm branch', () => {
  /** Build a stale editor whose ySync state is supplied by a stand-in (no
   *  real Collaboration — its real binding would occupy the seam under
   *  test), then mount it. */
  function mountStaleWithStandIn(docName: string, binding?: Record<string, unknown>): Editor {
    const ydoc = new Y.Doc();
    seedFragmentParagraph(ydoc, 'hello world');
    const fragment = ydoc.getXmlFragment('default');
    const editor = new Editor({
      element: null,
      extensions: [
        ...sharedExtensions,
        Extension.create({
          name: 'ySyncStandIn',
          addProseMirrorPlugins() {
            return [createYSyncStandIn(binding)];
          },
        }),
        walkCurrencyExtension({ fragment, docName }),
      ],
    });
    // Fragment change in the construct→mount gap → the extension's view init
    // takes the stale path and hits the (broken) seam.
    ydoc.transact(() => appendToFirstParagraph(fragment, ' GAPEDIT'));
    editor.mount(document.createElement('div'));
    return editor;
  }

  test('a missing ySync binding disarms loudly, not silently, and leaves the editor usable', () => {
    const docName = `disarm-no-binding-${randomUUID()}`;
    const { result: editor, warnings } = captureWarnings(() => mountStaleWithStandIn(docName));
    try {
      expect(
        warnings.some((w) => w.includes('no ySync binding') && w.includes('stale pre-warm')),
      ).toBe(true);
      // Disarmed, not broken: typing still lands.
      const before = editor.state.doc.textContent;
      editor.view.dispatch(editor.state.tr.insertText('x', 1));
      expect(editor.state.doc.textContent).not.toBe(before);
    } finally {
      editor.destroy();
    }
  });

  test('a binding without _forceRerender disarms loudly, not silently, and leaves the editor usable', () => {
    const docName = `disarm-no-rerender-${randomUUID()}`;
    const { result: editor, warnings } = captureWarnings(() => mountStaleWithStandIn(docName, {}));
    try {
      expect(
        warnings.some((w) => w.includes('no _forceRerender') && w.includes('stale pre-warm')),
      ).toBe(true);
      const before = editor.state.doc.textContent;
      editor.view.dispatch(editor.state.tr.insertText('x', 1));
      expect(editor.state.doc.textContent).not.toBe(before);
    } finally {
      editor.destroy();
    }
  });
});

// ---------------------------------------------------------------------------
// Never-mounted cleanup (mount-promise abort/invalidate)
// ---------------------------------------------------------------------------

describe('never-mounted cleanup', () => {
  test('invalidating the mount during the yield window destroys the pre-mount editor and unhooks the observer', async () => {
    const docName = `never-mounted-${randomUUID()}`;
    const { fragment, provider, cleanup } = makeProvider(docName);
    try {
      const baseline = deepObserverCount(fragment);
      let constructedEditor: Editor | null = null;

      const construct = () => {
        const ctorStart = performance.now();
        const editor = new Editor(
          buildPatternDConstructorOptions({ provider, clipboard: fakeClipboard, ctorStart }),
        );
        constructedEditor = editor;
        // Lands in the post-construct yield window — before editor.mount() —
        // the same window the gap-edit harness uses. invalidateMountPromise
        // routes through destroyPreMountEditor → editor.destroy() pre-mount.
        queueMicrotask(() => {
          invalidateMountPromise(docName);
        });
        return {
          editor,
          ydoc: provider.document,
          ytext: provider.document.getText('source'),
          provider,
        };
      };

      // The promise is intentionally orphaned by invalidate — do not await it.
      void mountTiptapEditorPromise({
        docName,
        mountId: randomUUID(),
        construct,
        sizeStats: { viewCount: 0, bytes: provider.document.getText('source').length },
      });
      await flushMicrotasksAndTimers();

      const editor = constructedEditor as unknown as Editor | null;
      expect(editor).not.toBeNull();
      expect((editor as Editor).isDestroyed).toBe(true);
      // onDestroy fired for the never-mounted editor: the construct-time
      // observeDeep registration is gone again.
      expect(deepObserverCount(fragment)).toBe(baseline);

      // A post-destroy fragment edit must not re-engage anything — observer
      // count stays at baseline and nothing throws.
      provider.document.transact(() => appendToFirstParagraph(fragment, ' AFTER-DESTROY'));
      await flushMicrotasksAndTimers();
      expect(deepObserverCount(fragment)).toBe(baseline);
    } finally {
      cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Non-stale fast path (pre-warm contract preserved)
// ---------------------------------------------------------------------------

describe('non-stale fast path', () => {
  test('a quiet construct→mount gap triggers no rerender and the prebuilt mapping survives into the binding', async () => {
    const docName = `quiet-gap-${randomUUID()}`;
    const { fragment, provider, cleanup } = makeProvider(docName);
    try {
      let prebuiltMapping: Map<unknown, unknown> | null = null;
      let prebuiltParagraphNode: unknown = null;
      const yParagraph = fragment.get(0);
      const rerenderTransactions: unknown[] = [];

      const construct = () => {
        const ctorStart = performance.now();
        const opts = buildPatternDConstructorOptions({
          provider,
          clipboard: fakeClipboard,
          ctorStart,
        });
        const collaboration = opts.extensions?.find((ext) => ext.name === 'collaboration') as
          | { options?: { ySyncOptions?: { mapping?: Map<unknown, unknown> } } }
          | undefined;
        const editor = new Editor(opts);
        prebuiltMapping = collaboration?.options?.ySyncOptions?.mapping ?? null;
        prebuiltParagraphNode = prebuiltMapping?.get(yParagraph) ?? null;
        editor.on('transaction', ({ transaction }) => {
          const meta = transaction.getMeta(ySyncPluginKey) as
            | { isChangeOrigin?: boolean }
            | undefined;
          if (meta?.isChangeOrigin === true) rerenderTransactions.push(meta);
        });
        return {
          editor,
          ydoc: provider.document,
          ytext: provider.document.getText('source'),
          provider,
        };
      };

      const entry = await mountTiptapEditorPromise({
        docName,
        mountId: randomUUID(),
        construct,
        sizeStats: { viewCount: 0, bytes: provider.document.getText('source').length },
      });
      await flushMicrotasksAndTimers();

      // Pre-warm contract intact: no invalidating rerender was dispatched...
      expect(rerenderTransactions).toHaveLength(0);
      // ...and the binding consumed the walk's own mapping — same instance,
      // prebuilt entries intact (a _forceRerender would have cleared and
      // repopulated it with new PM node instances).
      const syncState = ySyncPluginKey.getState(entry.editor.state) as {
        binding?: { mapping?: Map<unknown, unknown> };
      };
      expect(prebuiltMapping).not.toBeNull();
      expect(prebuiltParagraphNode).not.toBeNull();
      expect(syncState.binding?.mapping).toBe(prebuiltMapping as unknown as Map<unknown, unknown>);
      expect((prebuiltMapping as unknown as Map<unknown, unknown>).get(yParagraph)).toBe(
        prebuiltParagraphNode,
      );
      expect(entry.editor.state.doc.textContent).toContain('hello world');
    } finally {
      evictTiptapEditor(docName);
      cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Wiring arms (shape tier — mirrors TiptapEditor.test.tsx)
// ---------------------------------------------------------------------------

describe('wiring arms', () => {
  test('no prebuiltMapping → walk-currency extension absent from the extension list', () => {
    const { provider, cleanup } = makeProvider(`wiring-negative-${randomUUID()}`);
    try {
      const extensions = buildExtensionList({
        provider,
        clipboard: fakeClipboard,
        ctorStart: 0,
      });
      expect(extensions.some((ext) => ext.name === 'walkCurrency')).toBe(false);
    } finally {
      cleanup();
    }
  });

  test('prebuiltMapping supplied → walk-currency extension present (and in the Pattern D options)', () => {
    const { fragment, provider, cleanup } = makeProvider(`wiring-positive-${randomUUID()}`);
    try {
      const baseExtensions = buildExtensionList({
        provider,
        clipboard: fakeClipboard,
        ctorStart: 0,
      });
      const { mapping } = initProseMirrorDoc(fragment, getSchema(baseExtensions));
      const extensions = buildExtensionList({
        provider,
        clipboard: fakeClipboard,
        ctorStart: 0,
        prebuiltMapping: mapping,
      });
      expect(extensions.some((ext) => ext.name === 'walkCurrency')).toBe(true);

      // The production Pattern D path always supplies the mapping, so the
      // constructor options must always carry the enforcement.
      const opts = buildPatternDConstructorOptions({
        provider,
        clipboard: fakeClipboard,
        ctorStart: 0,
      });
      expect(opts.extensions?.some((ext) => ext.name === 'walkCurrency')).toBe(true);
    } finally {
      cleanup();
    }
  });
});
