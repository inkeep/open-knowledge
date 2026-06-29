
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { getSchema } from '@tiptap/core';
import { EditorState, Plugin, type PluginKey, Selection } from '@tiptap/pm/state';
import { EditorView } from '@tiptap/pm/view';
import { ySyncPluginKey, yXmlFragmentToProseMirrorRootNode } from '@tiptap/y-tiptap';
import { JSDOM } from 'jsdom';
import * as Y from 'yjs';
import {
  bindingStalenessGuardPlugin,
  isCatchUpApply,
  isDiverged,
  rateCapAllows,
} from './binding-staleness-guard';
import { sharedExtensions } from './extensions/shared';


function installDomGlobals(): () => void {
  const dom = new JSDOM('<!DOCTYPE html><html><head></head><body></body></html>', {
    url: 'http://localhost:5173',
    pretendToBeVisual: true,
  });
  const win = dom.window as unknown as Window & typeof globalThis;
  const installed: Record<string, unknown> = {
    window: win,
    document: win.document,
    HTMLElement: win.HTMLElement,
    Element: win.Element,
    Node: win.Node,
    Document: win.Document,
    DocumentFragment: win.DocumentFragment,
    Text: win.Text,
    Range: win.Range,
    DOMParser: win.DOMParser,
    MutationObserver: win.MutationObserver,
    Event: win.Event,
    CustomEvent: win.CustomEvent,
    KeyboardEvent: win.KeyboardEvent,
    MouseEvent: win.MouseEvent,
    InputEvent: win.InputEvent,
    CompositionEvent: win.CompositionEvent,
    FocusEvent: win.FocusEvent,
    getComputedStyle: win.getComputedStyle.bind(win),
    requestAnimationFrame: win.requestAnimationFrame.bind(win),
    cancelAnimationFrame: win.cancelAnimationFrame.bind(win),
  };
  const previousDescriptors = new Map<string, PropertyDescriptor | undefined>();
  const globalRecord = globalThis as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(installed)) {
    previousDescriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  return () => {
    for (const [key, descriptor] of previousDescriptors) {
      if (descriptor) {
        Object.defineProperty(globalThis, key, descriptor);
      } else {
        Reflect.deleteProperty(globalRecord, key);
      }
    }
    dom.window.close();
  };
}

let restoreDomGlobals: (() => void) | null = null;

beforeAll(() => {
  restoreDomGlobals = installDomGlobals();
});

afterAll(() => {
  restoreDomGlobals?.();
  restoreDomGlobals = null;
});


const schema = getSchema(sharedExtensions);

/** Stands in for a provider applying a remote peer's update (origin is the
 *  provider instance in production — anything other than `ySyncPluginKey`). */
const REMOTE_PROVIDER_ORIGIN = Object.freeze({ kind: 'remote-provider-stand-in' });

function setFragmentParagraph(fragment: Y.XmlFragment, text: string): void {
  fragment.delete(0, fragment.length);
  const paragraph = new Y.XmlElement('paragraph');
  paragraph.insert(0, [new Y.XmlText(text)]);
  fragment.insert(0, [paragraph]);
}

type YSyncStandInState = Record<string, unknown>;

/** Mirrors the vendored ySyncPlugin's state contract (meta merged into plugin
 *  state; `isChangeOrigin` true only on the transaction that carries it) so
 *  the guard reads `snapshot`/`prevSnapshot` through the production surface
 *  (`ySyncPluginKey.getState(...)`). */
function createYSyncStandIn(binding?: HarnessOptions['binding']): Plugin<YSyncStandInState> {
  return new Plugin<YSyncStandInState>({
    key: ySyncPluginKey as unknown as PluginKey<YSyncStandInState>,
    state: {
      init: () => ({
        snapshot: null,
        prevSnapshot: null,
        isChangeOrigin: false,
        ...(binding ? { binding } : {}),
      }),
      apply: (tr, pluginState) => {
        const change = tr.getMeta(ySyncPluginKey) as YSyncStandInState | undefined;
        const next: YSyncStandInState =
          change === undefined ? { ...pluginState } : { ...pluginState, ...change };
        next.isChangeOrigin = change !== undefined && !!change.isChangeOrigin;
        return next;
      },
    },
  });
}

/** Simulates the binding's `_typeChanged` apply: full re-render of the PM doc
 *  from the CURRENT fragment, tagged with the meta the vendored binding
 *  attaches. */
function dispatchYSyncRerender(view: EditorView, fragment: Y.XmlFragment): void {
  const next = yXmlFragmentToProseMirrorRootNode(fragment, view.state.schema);
  const tr = view.state.tr.replaceWith(0, view.state.doc.content.size, next.content);
  tr.setMeta(ySyncPluginKey, { isChangeOrigin: true, isUndoRedoOperation: false });
  view.dispatch(tr);
}

/** Simulates the binding's `unrenderSnapshot` apply: full re-render from the
 *  current fragment, tagged `{ snapshot: null, prevSnapshot: null }` (note:
 *  NO `isChangeOrigin`). */
function dispatchSnapshotExitRerender(view: EditorView, fragment: Y.XmlFragment): void {
  const next = yXmlFragmentToProseMirrorRootNode(fragment, view.state.schema);
  const tr = view.state.tr.replaceWith(0, view.state.doc.content.size, next.content);
  tr.setMeta(ySyncPluginKey, { snapshot: null, prevSnapshot: null });
  view.dispatch(tr);
}

/** Resolves strictly after all pending microtasks (a macrotask hop), so the
 *  guard's deferred wedge check has definitely run. */
function flushDetection(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

interface HarnessOptions {
  docName?: string;
  seedText?: string;
  /** 'none' (default) = wedged: external Y transactions are never followed by
   *  a y-sync apply. The other two attach a healthy simulated binding that
   *  synchronously dispatches the re-render apply inside the same observer
   *  cascade — registered before or after the guard's own fragment observer
   *  (the guard must be order-independent). */
  simulatedBinding?: 'none' | 'registered-before-guard' | 'registered-after-guard';
  /** Forwarded to the guard's onWedged after the harness records the call —
   *  lets tests inject a throwing recovery path. */
  onWedged?: (detail: { externalSeq: number; appliedSeq: number }) => void;
  /** When set, the y-sync stand-in exposes this object as `binding` on its
   *  plugin state (mirroring the vendored plugin, whose init state carries
   *  the ProsemirrorBinding instance), so the guard wraps its
   *  `_prosemirrorChanged` at view init. */
  binding?: { _prosemirrorChanged?: (doc: unknown) => void };
}

interface GuardHarness {
  docName: string;
  ydoc: Y.Doc;
  fragment: Y.XmlFragment;
  view: EditorView;
  wedgedCalls: Array<{ externalSeq: number; appliedSeq: number }>;
  /** Replace the fragment's content in a Y transaction with a non-binding
   *  origin (a remote-peer update arriving through the provider). */
  remoteReplace(text: string): void;
  /** Dispatch a local typing transaction (no y-sync meta); returns whether it
   *  landed (doc changed) or was filtered. */
  localType(char?: string): boolean;
  destroy(): void;
}

const activeHarnesses: GuardHarness[] = [];

afterEach(() => {
  for (const harness of activeHarnesses.splice(0)) {
    harness.destroy();
  }
});

function createHarness(options: HarnessOptions = {}): GuardHarness {
  const docName = options.docName ?? `staleness-guard-${randomUUID()}`;
  const simulatedBinding = options.simulatedBinding ?? 'none';
  const ydoc = new Y.Doc();
  const fragment = ydoc.getXmlFragment('default');
  ydoc.transact(() => setFragmentParagraph(fragment, options.seedText ?? 'seed'));

  let viewRef: EditorView | null = null;
  const bindingHandler = (_events: unknown, transaction: Y.Transaction): void => {
    if (transaction.origin === ySyncPluginKey) return;
    if (viewRef) dispatchYSyncRerender(viewRef, fragment);
  };
  if (simulatedBinding === 'registered-before-guard') {
    fragment.observeDeep(bindingHandler);
  }

  const wedgedCalls: Array<{ externalSeq: number; appliedSeq: number }> = [];
  const state = EditorState.create({
    schema,
    doc: yXmlFragmentToProseMirrorRootNode(fragment, schema),
    plugins: [
      createYSyncStandIn(options.binding),
      bindingStalenessGuardPlugin({
        fragment,
        docName,
        onWedged: (detail: { externalSeq: number; appliedSeq: number }) => {
          wedgedCalls.push(detail);
          options.onWedged?.(detail);
        },
      }),
    ],
  });
  const view = new EditorView(document.createElement('div'), { state });
  viewRef = view;

  if (simulatedBinding === 'registered-after-guard') {
    fragment.observeDeep(bindingHandler);
  }

  const harness: GuardHarness = {
    docName,
    ydoc,
    fragment,
    view,
    wedgedCalls,
    remoteReplace(text: string): void {
      ydoc.transact(() => setFragmentParagraph(fragment, text), REMOTE_PROVIDER_ORIGIN);
    },
    localType(char = 'x'): boolean {
      const before = view.state.doc.textContent;
      view.dispatch(view.state.tr.insertText(char));
      return view.state.doc.textContent !== before;
    },
    destroy(): void {
      if (simulatedBinding !== 'none') {
        fragment.unobserveDeep(bindingHandler);
      }
      view.destroy();
      ydoc.destroy();
    },
  };
  activeHarnesses.push(harness);
  return harness;
}


describe('pure helpers', () => {
  test('isDiverged is true exactly when external is ahead of applied', () => {
    expect(isDiverged(0, 0)).toBe(false);
    expect(isDiverged(1, 0)).toBe(true);
    expect(isDiverged(5, 5)).toBe(false);
    expect(isDiverged(7, 3)).toBe(true);
  });

  test('isCatchUpApply recognizes the two full-re-render meta shapes and nothing else', () => {
    expect(isCatchUpApply({ isChangeOrigin: true, isUndoRedoOperation: false })).toBe(true);
    expect(isCatchUpApply({ isChangeOrigin: true })).toBe(true);
    expect(isCatchUpApply({ snapshot: null, prevSnapshot: null })).toBe(true);
    expect(isCatchUpApply({ snapshot: {}, prevSnapshot: {} })).toBe(false);
    expect(isCatchUpApply(undefined)).toBe(false);
    expect(isCatchUpApply({ isChangeOrigin: false })).toBe(false);
  });

  test('rateCapAllows permits at most 3 firings per rolling 60s window', () => {
    const now = 1_000_000_000;
    expect(rateCapAllows([], now)).toBe(true);
    expect(rateCapAllows([now - 1_000, now - 2_000], now)).toBe(true);
    expect(rateCapAllows([now - 1_000, now - 2_000, now - 3_000], now)).toBe(false);
    expect(rateCapAllows([now - 61_000, now - 62_000, now - 63_000], now)).toBe(true);
    expect(rateCapAllows([now - 61_000, now - 30_000, now - 20_000], now)).toBe(true);
    expect(rateCapAllows([now - 61_000, now - 30_000, now - 20_000, now - 10_000], now)).toBe(
      false,
    );
  });
});


describe('counter semantics', () => {
  test('a wedged external burst is reported once, deferred, with the full backlog', async () => {
    const harness = createHarness();
    harness.remoteReplace('remote one');
    harness.remoteReplace('remote two');
    harness.remoteReplace('remote three');
    expect(harness.wedgedCalls).toHaveLength(0);
    await flushDetection();
    expect(harness.wedgedCalls).toHaveLength(1);
    const detail = harness.wedgedCalls[0];
    if (!detail) throw new Error('unreachable: length asserted above');
    expect(detail.externalSeq - detail.appliedSeq).toBe(3);
    expect(isDiverged(detail.externalSeq, detail.appliedSeq)).toBe(true);
  });

  test('ONE y-sync re-render apply heals a multi-update backlog (catch-up, not increment)', async () => {
    const harness = createHarness();
    harness.remoteReplace('remote one');
    harness.remoteReplace('remote two');
    harness.remoteReplace('remote three');
    await flushDetection();
    expect(harness.localType()).toBe(false);
    dispatchYSyncRerender(harness.view, harness.fragment);
    expect(harness.view.state.doc.textContent).toContain('remote three');
    expect(harness.localType()).toBe(true);
  });

  test("the binding's own PM→Y write-back origin does not count as external", async () => {
    const harness = createHarness();
    harness.ydoc.transact(
      () => setFragmentParagraph(harness.fragment, 'self write-back'),
      ySyncPluginKey,
    );
    await flushDetection();
    expect(harness.wedgedCalls).toHaveLength(0);
    expect(harness.localType()).toBe(true);
  });

  test('Y transactions that do not touch the fragment do not open a backlog', async () => {
    const harness = createHarness();
    const ytext = harness.ydoc.getText('source');
    harness.ydoc.transact(() => {
      ytext.insert(0, 'frontmatter edit\n');
    }, REMOTE_PROVIDER_ORIGIN);
    await flushDetection();
    expect(harness.wedgedCalls).toHaveLength(0);
    expect(harness.localType()).toBe(true);
  });
});


describe('publication gate', () => {
  test('while diverged, every transaction without y-sync meta is blocked — including selection-only', async () => {
    const harness = createHarness({ seedText: 'long enough to move a cursor' });
    harness.remoteReplace('remote fix');
    expect(harness.localType()).toBe(false);

    const selectionBefore = harness.view.state.selection;
    const target = Selection.atEnd(harness.view.state.doc);
    expect(target.eq(selectionBefore)).toBe(false);
    harness.view.dispatch(harness.view.state.tr.setSelection(target));
    expect(harness.view.state.selection.eq(selectionBefore)).toBe(true);

    await flushDetection();
    expect(harness.localType()).toBe(false);
  });

  test('y-sync applies are admitted while diverged, and the gate reopens after catch-up', async () => {
    const harness = createHarness();
    harness.remoteReplace('remote fix');
    await flushDetection();
    expect(harness.localType()).toBe(false);

    dispatchYSyncRerender(harness.view, harness.fragment);
    expect(harness.view.state.doc.textContent).toContain('remote fix');

    expect(harness.localType()).toBe(true);
    await flushDetection();
    expect(harness.wedgedCalls).toHaveLength(1);
  });

  test('snapshot mode suppresses both the gate and the wedge trigger; the exit re-render realigns', async () => {
    const harness = createHarness();
    harness.view.dispatch(
      harness.view.state.tr.setMeta(ySyncPluginKey, {
        snapshot: Y.snapshot(harness.ydoc),
        prevSnapshot: Y.snapshot(harness.ydoc),
      }),
    );

    harness.remoteReplace('remote while snapshotted');
    await flushDetection();
    expect(harness.wedgedCalls).toHaveLength(0);
    expect(harness.localType()).toBe(true);

    dispatchSnapshotExitRerender(harness.view, harness.fragment);
    expect(harness.view.state.doc.textContent).toContain('remote while snapshotted');
    expect(harness.localType()).toBe(true);
    await flushDetection();
    expect(harness.wedgedCalls).toHaveLength(0);
  });
});


describe('wedge trigger', () => {
  test('fires once per divergence episode across repeated wedged bumps; the gate keeps blocking', async () => {
    const harness = createHarness();
    harness.remoteReplace('remote one');
    await flushDetection();
    expect(harness.wedgedCalls).toHaveLength(1);

    harness.remoteReplace('remote two');
    await flushDetection();
    expect(harness.wedgedCalls).toHaveLength(1);
    expect(harness.localType()).toBe(false);
  });

  test('destroying the view unregisters the fragment observer', async () => {
    const harness = createHarness();
    harness.view.destroy();
    harness.ydoc.transact(
      () => setFragmentParagraph(harness.fragment, 'after destroy'),
      REMOTE_PROVIDER_ORIGIN,
    );
    await flushDetection();
    expect(harness.wedgedCalls).toHaveLength(0);
  });

  test('a throwing onWedged is contained and recovery re-attempts on the next external bump', async () => {
    let shouldThrow = true;
    const harness = createHarness({
      onWedged: () => {
        if (shouldThrow) {
          shouldThrow = false;
          throw new Error('simulated recycle failure');
        }
      },
    });
    harness.remoteReplace('remote one');
    await flushDetection();
    expect(harness.wedgedCalls).toHaveLength(1);
    expect(harness.localType()).toBe(false);
    harness.remoteReplace('remote two');
    await flushDetection();
    expect(harness.wedgedCalls).toHaveLength(2);
  });

  test('a healed divergence ends the episode: a later re-wedge reports again', async () => {
    const harness = createHarness();
    harness.remoteReplace('remote one');
    await flushDetection();
    expect(harness.wedgedCalls).toHaveLength(1);

    dispatchYSyncRerender(harness.view, harness.fragment);
    expect(harness.localType()).toBe(true);

    harness.remoteReplace('remote two');
    await flushDetection();
    expect(harness.wedgedCalls).toHaveLength(2);
    expect(harness.localType()).toBe(false);
  });

  test('rate-capped per docName: beyond 3 firings the gate still blocks but onWedged stays silent', async () => {
    const docName = `rate-cap-${randomUUID()}`;
    const fired: boolean[] = [];
    for (let i = 0; i < 4; i++) {
      const harness = createHarness({ docName });
      harness.remoteReplace(`remote ${i}`);
      await flushDetection();
      fired.push(harness.wedgedCalls.length === 1);
      expect(harness.localType()).toBe(false);
      harness.destroy();
    }
    expect(fired).toEqual([true, true, true, false]);
  });
});


describe('binding write-back seam', () => {
  /** What the vendored ySyncPlugin's pluginView `update` callback does
   *  unconditionally on every view-state update (y-tiptap.cjs view section):
   *  publish the current PM doc through `binding._prosemirrorChanged`. */
  function invokeWriteBack(harness: GuardHarness): void {
    const syncState = ySyncPluginKey.getState(harness.view.state) as {
      binding?: { _prosemirrorChanged?: (doc: unknown) => void };
    };
    syncState.binding?._prosemirrorChanged?.(harness.view.state.doc);
  }

  test('while diverged the seam refuses to publish; after catch-up it publishes again', async () => {
    const published: unknown[] = [];
    const harness = createHarness({
      binding: {
        _prosemirrorChanged: (doc: unknown) => {
          published.push(doc);
        },
      },
    });

    invokeWriteBack(harness);
    expect(published).toHaveLength(1);

    harness.remoteReplace('remote fix');
    invokeWriteBack(harness);
    expect(published).toHaveLength(1);
    await flushDetection();
    invokeWriteBack(harness);
    expect(published).toHaveLength(1);

    dispatchYSyncRerender(harness.view, harness.fragment);
    invokeWriteBack(harness);
    expect(published).toHaveLength(2);
  });

  test('a binding without _prosemirrorChanged disarms the write-back gate loudly, not silently', () => {
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(String(args[0]));
    };
    try {
      createHarness({ binding: {} });
    } finally {
      console.warn = originalWarn;
    }
    expect(
      warnings.some((w) => w.includes('no _prosemirrorChanged — write-back gate disarmed')),
    ).toBe(true);
  });

  test('a fragment with no Y.Doc disarms the whole guard loudly and leaves the editor usable', () => {
    const errors: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(String(args[0]));
    };
    let view: EditorView | null = null;
    try {
      const orphanFragment = new Y.XmlFragment();
      const state = EditorState.create({
        schema,
        plugins: [
          createYSyncStandIn(),
          bindingStalenessGuardPlugin({
            fragment: orphanFragment,
            docName: `orphan-${randomUUID()}`,
            onWedged: () => {},
          }),
        ],
      });
      view = new EditorView(document.createElement('div'), { state });
      const before = view.state.doc.textContent;
      view.dispatch(view.state.tr.insertText('x'));
      expect(view.state.doc.textContent).not.toBe(before);
    } finally {
      view?.destroy();
      console.error = originalError;
    }
    expect(errors.some((e) => e.includes('staleness guard disarmed'))).toBe(true);
  });
});


describe('no false positives on healthy bindings', () => {
  for (const order of ['registered-before-guard', 'registered-after-guard'] as const) {
    test(`rapid external stream interleaved with local typing stays open (binding ${order})`, async () => {
      const harness = createHarness({ simulatedBinding: order });
      for (let i = 0; i < 15; i++) {
        harness.remoteReplace(`remote ${i}`);
        expect(harness.localType()).toBe(true);
      }
      await flushDetection();
      expect(harness.wedgedCalls).toHaveLength(0);
      expect(harness.view.state.doc.textContent).toContain('remote 14');
    });
  }

  test('a single healthy remote update never reports a wedge', async () => {
    const harness = createHarness({ simulatedBinding: 'registered-after-guard' });
    harness.remoteReplace('remote healthy');
    await flushDetection();
    expect(harness.wedgedCalls).toHaveLength(0);
    expect(harness.view.state.doc.textContent).toContain('remote healthy');
    expect(harness.localType()).toBe(true);
  });
});
