/**
 * Behavioral contract for the binding staleness guard.
 *
 * The guard defends the client-side bridge invariant: a y-prosemirror binding
 * whose Y→PM apply half has stopped (a "wedged" binding) must never re-publish
 * its stale PM replica wholesale over newer CRDT state. The end-to-end
 * invariant is pinned by `tests/stress/prd-6955-reassertion-wedge.e2e.ts`;
 * this file pins the guard's own contract procedurally at the dom/unit tier:
 *
 *   - counter semantics: external (non-binding-origin) fragment-changing Y
 *     transactions open a backlog; one y-sync full-re-render apply heals the
 *     whole backlog (catch-up, not increment)
 *   - publication gate: while diverged, every transaction without y-sync meta
 *     (including selection-only) is filtered; y-sync applies are admitted and
 *     reopen the gate; snapshot mode suppresses gate and trigger
 *   - wedge trigger: onWedged fires once per divergence episode (a catch-up
 *     apply re-arms it), deferred (not inside the Y observer cascade),
 *     rate-capped per docName, and contained (a throwing recovery un-latches
 *     for retry instead of escaping the microtask)
 *   - no false positives: a healthy binding (every external transaction is
 *     synchronously followed by its y-sync apply in the same observer
 *     cascade) is never blocked and never reported wedged
 *
 * Third-party contract basis (vendored `@tiptap/y-tiptap` 3.0.3 dist): the
 * binding's full re-render applies carry `ySyncPluginKey` meta
 * `{ isChangeOrigin: true, ... }`; the snapshot-exit re-render carries
 * `{ snapshot: null, prevSnapshot: null }`; snapshot-enter carries non-null
 * `snapshot`/`prevSnapshot`; the binding's PM→Y write-back transacts with
 * `ySyncPluginKey` itself as the Y transaction origin; the ySyncPlugin merges
 * each meta object into its plugin state. The harness below simulates that
 * binding surface exactly — a stand-in plugin registered under the real
 * `ySyncPluginKey` plus dispatched transactions carrying the real meta shapes
 * — so the guard is driven through the same public surfaces it reads in
 * production. The wedge is simulated by simply NOT dispatching the y-sync
 * apply after an external Y transaction.
 *
 * Substrate note: this file needs raw DOM globals for a real ProseMirror
 * EditorView but no React runtime, so it does not use the `*.dom.test.tsx`
 * RTL tier. It installs jsdom in beforeAll and RESTORES the previous globals
 * in afterAll — sibling unit-tier files run in the same `bun test` process
 * and rely on the no-DOM contract (`typeof document === 'undefined'`
 * short-circuits); do not remove the restore.
 */

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

// ---------------------------------------------------------------------------
// jsdom substrate (scoped to this file — restored in afterAll)
// ---------------------------------------------------------------------------

function installDomGlobals(): () => void {
  const dom = new JSDOM('<!DOCTYPE html><html><head></head><body></body></html>', {
    url: 'http://localhost:5173',
    pretendToBeVisual: true,
  });
  const win = dom.window as unknown as Window & typeof globalThis;
  // Only the globals prosemirror-view structurally touches (element creation,
  // MutationObserver-based DOM observation, ranges, selection, rAF).
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

// ---------------------------------------------------------------------------
// Harness — real Y.Doc/XmlFragment + real EditorView + simulated binding
// ---------------------------------------------------------------------------

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
  // Seed before the view exists so setup never counts as an external bump
  // (the guard registers its fragment observer at plugin-view init).
  ydoc.transact(() => setFragmentParagraph(fragment, options.seedText ?? 'seed'));

  let viewRef: EditorView | null = null;
  const bindingHandler = (_events: unknown, transaction: Y.Transaction): void => {
    // The real binding ignores its own PM→Y write-backs (mux + origin).
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

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe('pure helpers', () => {
  test('isDiverged is true exactly when external is ahead of applied', () => {
    expect(isDiverged(0, 0)).toBe(false);
    expect(isDiverged(1, 0)).toBe(true);
    expect(isDiverged(5, 5)).toBe(false);
    expect(isDiverged(7, 3)).toBe(true);
  });

  test('isCatchUpApply recognizes the two full-re-render meta shapes and nothing else', () => {
    // _typeChanged shape
    expect(isCatchUpApply({ isChangeOrigin: true, isUndoRedoOperation: false })).toBe(true);
    // _forceRerender shape
    expect(isCatchUpApply({ isChangeOrigin: true })).toBe(true);
    // unrenderSnapshot (snapshot-exit) shape — explicit nulls
    expect(isCatchUpApply({ snapshot: null, prevSnapshot: null })).toBe(true);
    // snapshot ENTER renders historical state, not the current fragment
    expect(isCatchUpApply({ snapshot: {}, prevSnapshot: {} })).toBe(false);
    // no y-sync meta at all
    expect(isCatchUpApply(undefined)).toBe(false);
    expect(isCatchUpApply({ isChangeOrigin: false })).toBe(false);
  });

  test('rateCapAllows permits at most 3 firings per rolling 60s window', () => {
    const now = 1_000_000_000;
    expect(rateCapAllows([], now)).toBe(true);
    expect(rateCapAllows([now - 1_000, now - 2_000], now)).toBe(true);
    expect(rateCapAllows([now - 1_000, now - 2_000, now - 3_000], now)).toBe(false);
    // firings older than the window no longer count
    expect(rateCapAllows([now - 61_000, now - 62_000, now - 63_000], now)).toBe(true);
    expect(rateCapAllows([now - 61_000, now - 30_000, now - 20_000], now)).toBe(true);
    expect(rateCapAllows([now - 61_000, now - 30_000, now - 20_000, now - 10_000], now)).toBe(
      false,
    );
  });
});

// ---------------------------------------------------------------------------
// Counter semantics
// ---------------------------------------------------------------------------

describe('counter semantics', () => {
  test('a wedged external burst is reported once, deferred, with the full backlog', async () => {
    const harness = createHarness();
    harness.remoteReplace('remote one');
    harness.remoteReplace('remote two');
    harness.remoteReplace('remote three');
    // Detection must be deferred: inside the observer cascade the binding has
    // not yet had its (synchronous) chance to apply.
    expect(harness.wedgedCalls).toHaveLength(0);
    await flushDetection();
    expect(harness.wedgedCalls).toHaveLength(1);
    const detail = harness.wedgedCalls[0];
    if (!detail) throw new Error('unreachable: length asserted above');
    // Three external transactions, zero applies → backlog of exactly 3.
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
    // A single full re-render derives from the CURRENT fragment, so it heals
    // all three pending updates at once.
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

// ---------------------------------------------------------------------------
// Publication gate
// ---------------------------------------------------------------------------

describe('publication gate', () => {
  test('while diverged, every transaction without y-sync meta is blocked — including selection-only', async () => {
    const harness = createHarness({ seedText: 'long enough to move a cursor' });
    harness.remoteReplace('remote fix');
    // The gate must already be closed synchronously after the Y observer
    // cascade — the resurrection channel fires on the very next view update.
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
    // Healed before a second report could ever be warranted; the single
    // pre-heal report (from the first flush) is all there is.
    expect(harness.wedgedCalls).toHaveLength(1);
  });

  test('snapshot mode suppresses both the gate and the wedge trigger; the exit re-render realigns', async () => {
    const harness = createHarness();
    // Enter snapshot mode through the production meta shape (non-null
    // snapshot/prevSnapshot merged into the y-sync plugin state).
    harness.view.dispatch(
      harness.view.state.tr.setMeta(ySyncPluginKey, {
        snapshot: Y.snapshot(harness.ydoc),
        prevSnapshot: Y.snapshot(harness.ydoc),
      }),
    );

    harness.remoteReplace('remote while snapshotted');
    await flushDetection();
    // PM is intentionally historical here — no harm channel, no recycle.
    expect(harness.wedgedCalls).toHaveLength(0);
    expect(harness.localType()).toBe(true);

    // Exiting the snapshot re-renders from the CURRENT fragment — counters
    // realign, so the gate stays open and the trigger stays silent.
    dispatchSnapshotExitRerender(harness.view, harness.fragment);
    expect(harness.view.state.doc.textContent).toContain('remote while snapshotted');
    expect(harness.localType()).toBe(true);
    await flushDetection();
    expect(harness.wedgedCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Wedge trigger
// ---------------------------------------------------------------------------

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
    // Recovery (pool recycle) runs from a microtask — a throw there is
    // unreachable by React error boundaries, so the guard must contain it
    // and un-latch, or the editor is permanently gated with no retry.
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
    // Harm prevention never relaxes: the gate stays closed after the throw.
    expect(harness.localType()).toBe(false);
    // The failed attempt must not latch — the next external bump retries
    // (bounded by the per-docName rate cap, whose timestamp was recorded).
    harness.remoteReplace('remote two');
    await flushDetection();
    expect(harness.wedgedCalls).toHaveLength(2);
  });

  test('a healed divergence ends the episode: a later re-wedge reports again', async () => {
    const harness = createHarness();
    harness.remoteReplace('remote one');
    await flushDetection();
    expect(harness.wedgedCalls).toHaveLength(1);

    // The binding recovers on its own: one catch-up apply heals the backlog.
    dispatchYSyncRerender(harness.view, harness.fragment);
    expect(harness.localType()).toBe(true);

    // A NEW wedge episode on the same instance must be reported again —
    // otherwise a rate-capped or recovery-failed instance that later healed
    // could never trigger recovery for a subsequent wedge.
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
      // Past the cap the harm-prevention half must NOT relax.
      expect(harness.localType()).toBe(false);
      harness.destroy();
    }
    expect(fired).toEqual([true, true, true, false]);
  });
});

// ---------------------------------------------------------------------------
// Binding write-back seam (the half of the gate filterTransaction can't cover)
// ---------------------------------------------------------------------------

describe('binding write-back seam', () => {
  /** What the vendored ySyncPlugin's pluginView `update` callback does
   *  unconditionally on every view-state update:
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

    // Healthy: publication flows through to the underlying binding.
    invokeWriteBack(harness);
    expect(published).toHaveLength(1);

    // Wedged: the external update opened a backlog; even though ProseMirror
    // still runs the pluginView update (a FILTERED transaction reaches
    // view.updateState), the wrapped seam must refuse to publish the stale
    // PM doc.
    harness.remoteReplace('remote fix');
    invokeWriteBack(harness);
    expect(published).toHaveLength(1);
    await flushDetection();
    invokeWriteBack(harness);
    expect(published).toHaveLength(1);

    // Catch-up apply heals the divergence — publication resumes.
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
      // An unintegrated fragment has `.doc === null` — the guard has no
      // external-bump source.
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
      // Disarmed, not broken: typing still lands.
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

// ---------------------------------------------------------------------------
// No false positives on healthy bindings
// ---------------------------------------------------------------------------

describe('no false positives on healthy bindings', () => {
  for (const order of ['registered-before-guard', 'registered-after-guard'] as const) {
    test(`rapid external stream interleaved with local typing stays open (binding ${order})`, async () => {
      const harness = createHarness({ simulatedBinding: order });
      for (let i = 0; i < 15; i++) {
        harness.remoteReplace(`remote ${i}`);
        // The simulated binding applied synchronously in the same cascade —
        // the local keystroke must land untouched.
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
