/**
 * Unit tests for mount-promise: module-level promise cache for the Pattern D
 * (Suspense + `use(promise)`) TipTap mount-split. Mirrors precedent #18(d)
 * sync-promise.test.ts shape.
 *
 * Tests use the same fake-DOM + fake-Editor harness as editor-cache.test.ts
 * (Bun test env has no DOM globals; we install a minimal `globalThis.document`
 * stub before the suites that exercise the cache-MISS path).
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { HocuspocusProvider } from '@hocuspocus/provider';
import type { Editor } from '@tiptap/core';
import * as Y from 'yjs';
import { getCollector, getHistogramSnapshot } from '../lib/perf/collector';
import { validatePerfMarkName } from '../lib/perf/mark';
import {
  __coldMountSpanCount,
  __resetColdMountSpans,
  emitColdMountChild,
} from '../lib/perf/otel-spans';
import { __getCacheSize, __resetCacheForTests, mountTiptapEditor } from './editor-cache';
import {
  __mountPromiseCacheSize,
  __mountPromiseSettled,
  __mountPromiseStalledEmitted,
  __mountPromiseVisibilityHandlerInstalled,
  __reapStalledOnVisible,
  __resetMountPromiseCache,
  getMountAbortController,
  invalidateMountPromise,
  MountAbortError,
  mountPromiseHasResolved,
  mountTiptapEditorPromise,
  subscribeMountStalled,
} from './mount-promise';

// ---------------------------------------------------------------------------
// Minimal HTMLElement / Editor / Provider fakes (mirrors editor-cache.test.ts)
// ---------------------------------------------------------------------------

interface FakeNode {
  parentElement: FakeNode | null;
  scrollTop: number;
  children: FakeNode[];
  appendChild(child: FakeNode): FakeNode;
  removeChild(child: FakeNode): FakeNode;
  setAttribute(key: string, value: string): void;
  style: Record<string, string>;
}

function makeNode(): FakeNode {
  const node: FakeNode = {
    parentElement: null,
    scrollTop: 0,
    children: [],
    style: {},
    setAttribute(_key, _value) {
      /* no-op */
    },
    appendChild(child) {
      if (child.parentElement) child.parentElement.removeChild(child);
      node.children.push(child);
      child.parentElement = node;
      return child;
    },
    removeChild(child) {
      const idx = node.children.indexOf(child);
      if (idx !== -1) node.children.splice(idx, 1);
      child.parentElement = null;
      return child;
    },
  };
  return node;
}

interface FakeTiptapSpies {
  destroyCalls: number;
  mountCalls: number;
  /** When true, the next `mount()` call throws to exercise the mount-failure error path. */
  mountThrows: boolean;
  /**
   * When true, every `destroy()` call throws to exercise the
   * destroy-on-pre-mount-throw resilience path. The destroy throw must not
   * prevent the promise from settling — destroyPreMountEditor swallows it
   * and emits an `ok/mount/destroy-failed` telemetry mark so a TipTap
   * regression in pre-mount-destroy idempotency is observable in traces.
   */
  destroyThrows: boolean;
}

function makeFakeTiptap(dom: FakeNode): {
  editor: Editor;
  spies: FakeTiptapSpies;
} {
  const spies: FakeTiptapSpies = {
    destroyCalls: 0,
    mountCalls: 0,
    mountThrows: false,
    destroyThrows: false,
  };
  const editor = {
    editorView: {
      dom,
      scrollDOM: dom,
    },
    commands: {
      focus() {
        /* no-op */
      },
    },
    mount(target: FakeNode) {
      spies.mountCalls++;
      if (spies.mountThrows) {
        throw new Error('synthetic mount failure');
      }
      target.appendChild(dom);
    },
    destroy() {
      spies.destroyCalls++;
      if (spies.destroyThrows) {
        throw new Error('synthetic destroy failure');
      }
    },
    isDestroyed: false,
  } as unknown as Editor;
  return { editor, spies };
}

function makeFakeProvider(ydoc: Y.Doc): HocuspocusProvider {
  return {
    document: ydoc,
    destroy() {
      /* no-op */
    },
    connect() {
      return Promise.resolve();
    },
    disconnect() {
      /* no-op */
    },
  } as unknown as HocuspocusProvider;
}

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

interface MountPromiseHarness {
  docName: string;
  ydoc: Y.Doc;
  ytext: Y.Text;
  editor: Editor;
  provider: HocuspocusProvider;
  editorDom: FakeNode;
  spies: FakeTiptapSpies;
  /** Counts how many times `construct()` was called by mount-promise. */
  constructCallCount: number;
  construct: () => {
    editor: Editor;
    ydoc: Y.Doc;
    ytext: Y.Text;
    provider: HocuspocusProvider;
  };
}

function makeHarness(docName: string): MountPromiseHarness {
  const ydoc = new Y.Doc();
  const ytext = ydoc.getText('source');
  const editorDom = makeNode();
  const { editor, spies } = makeFakeTiptap(editorDom);
  const provider = makeFakeProvider(ydoc);
  let constructCallCount = 0;
  const harness: MountPromiseHarness = {
    docName,
    ydoc,
    ytext,
    editor,
    provider,
    editorDom,
    spies,
    constructCallCount: 0,
    construct: () => {
      constructCallCount++;
      harness.constructCallCount = constructCallCount;
      return { editor, ydoc, ytext, provider };
    },
  };
  return harness;
}

/**
 * Install a minimal `globalThis.document` so mount-promise's transient-div
 * creation works in Bun's no-DOM test env. Idempotent + non-clobbering: leaves
 * an existing real `document` (e.g., happy-dom) untouched.
 */
let documentStubInstalled = false;
function installDocumentStub(): void {
  if (typeof globalThis.document !== 'undefined') return;
  // biome-ignore lint/suspicious/noExplicitAny: minimal test-only stub for `document.createElement`
  (globalThis as any).document = {
    createElement: (_tag: string) => makeNode(),
    // Stub addEventListener/removeEventListener so mount-promise's
    // visibility-restore reaper installs successfully under Bun's no-DOM
    // env. The reaper itself is driven by the explicit
    // `__reapStalledOnVisible(now)` test export; the listener is only
    // load-bearing for browser scenarios. Stubbing here keeps the
    // install/uninstall lifecycle observable in unit tests via
    // `__mountPromiseVisibilityHandlerInstalled()`.
    addEventListener: (_event: string, _handler: () => void) => {
      /* no-op */
    },
    removeEventListener: (_event: string, _handler: () => void) => {
      /* no-op */
    },
  };
  documentStubInstalled = true;
}

function uninstallDocumentStub(): void {
  if (!documentStubInstalled) return;
  // biome-ignore lint/suspicious/noExplicitAny: tearing down the test-only stub installed above
  delete (globalThis as any).document;
  documentStubInstalled = false;
}

beforeEach(() => {
  __resetMountPromiseCache();
  __resetCacheForTests();
  installDocumentStub();
});

afterEach(async () => {
  __resetMountPromiseCache();
  __resetCacheForTests();
  // Drain pending macrotasks so any body suspended at `await scheduler.yield()`
  // resumes (and takes the abort path now that __resetMountPromiseCache has
  // aborted its controller) BEFORE the next test starts. Without this, the
  // body's abort-rejection fires inside the next test's window — Bun's runner
  // attributes the unhandled rejection to whichever test is currently
  // executing, producing spurious cross-test failure attributions. The
  // setTimeout(0) cycle pumps both setTimeout and MessageChannel queues which
  // is what the polyfill's yield uses under Bun.
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  uninstallDocumentStub();
  // Delete the test-installed window stub so subsequent test files (e.g.,
  // clipboard handlers) see Bun's expected `typeof window === 'undefined'`
  // env. Marker `__testInstalled` distinguishes our stub from a real
  // happy-dom-style window if one is ever introduced.
  if (
    typeof globalThis.window !== 'undefined' &&
    (globalThis.window as { __testInstalled?: boolean }).__testInstalled === true
  ) {
    // biome-ignore lint/suspicious/noExplicitAny: tearing down test-installed window stub
    delete (globalThis as any).window;
  }
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('cache HIT short-circuit (V2 cache pre-populated)', () => {
  test('V2 cache HIT: resolves to the same entry without calling construct', async () => {
    const h = makeHarness('doc-hit');

    // Pre-populate V2 cache via the existing sync API.
    const v2container = makeNode();
    const v2entry = mountTiptapEditor({
      docName: h.docName,
      container: v2container as unknown as HTMLElement,
      factory: (el) => {
        // Mount fake DOM into container (mirrors real factory behavior).
        (el as unknown as FakeNode).appendChild(h.editorDom);
        return { editor: h.editor, ydoc: h.ydoc, ytext: h.ytext, provider: h.provider };
      },
    });
    expect(__getCacheSize('tiptap')).toBe(1);

    // Now exercise mount-promise — should HIT V2 cache and return same entry.
    const promise = mountTiptapEditorPromise({
      docName: h.docName,
      mountId: 'test-id',
      construct: h.construct,
    });

    const got = await promise;
    expect(got).toBe(v2entry);
    expect(h.constructCallCount).toBe(0); // construct NEVER called on HIT
    expect(h.spies.mountCalls).toBe(0); // mount() NEVER called on HIT
    expect(h.spies.destroyCalls).toBe(0);
    expect(__mountPromiseCacheSize()).toBe(1);
    expect(__mountPromiseSettled(h.docName)).toBe(true);
  });
});

describe('cache MISS: yield → construct → yield → mount sequence', () => {
  test('cache MISS: runs construct, yields, then calls editor.mount(transient)', async () => {
    const h = makeHarness('doc-miss');

    const promise = mountTiptapEditorPromise({
      docName: h.docName,
      mountId: 'test-id',
      construct: h.construct,
    });

    // Before await — construct has NOT run yet; the body first yields
    // (pre-construct yield for sibling-subtree paint), then calls construct().
    // Don't assert ordering pre-await; assert at completion.
    const entry = await promise;
    expect(h.constructCallCount).toBe(1);
    expect(h.spies.mountCalls).toBe(1);
    expect(h.spies.destroyCalls).toBe(0);
    expect(entry.editor).toBe(h.editor);
    expect(entry.ydoc).toBe(h.ydoc);
    expect(entry.ytext).toBe(h.ytext);
    expect(entry.provider).toBe(h.provider);
    // V2 cache stores the entry so subsequent navigations hit cache reparent path.
    expect(__getCacheSize('tiptap')).toBe(1);
    // mount-promise cache stores a settled sentinel.
    expect(__mountPromiseSettled(h.docName)).toBe(true);
  });

  test('cache MISS: editor is mounted into a transient detached div, NOT the V2 container directly', async () => {
    // Verifies the invariant: editor.mount(transientDiv) is called with a
    // fresh detached div owned by mount-promise, not by V2 cache. This keeps
    // the precedent #18(b) hybrid render tree unbroken — EditorContent reparents
    // view.dom into its React-managed ref on first render.
    const h = makeHarness('doc-transient-mount');

    await mountTiptapEditorPromise({
      docName: h.docName,
      mountId: 'test-id',
      construct: h.construct,
    });

    // The fake editor DOM was appended to whatever `mount(target)` received.
    // Verify it has a parent — the transient div that mount-promise created.
    expect(h.editorDom.parentElement).not.toBeNull();
  });
});

describe('concurrent-call promise reference stability', () => {
  test('repeated calls with same docName during pending construction return the same promise reference', () => {
    const h = makeHarness('doc-concurrent');

    const a = mountTiptapEditorPromise({
      docName: h.docName,
      mountId: 'test-id',
      construct: h.construct,
    });
    const b = mountTiptapEditorPromise({
      docName: h.docName,
      mountId: 'test-id',
      construct: h.construct,
    });
    const c = mountTiptapEditorPromise({
      docName: h.docName,
      mountId: 'test-id',
      construct: h.construct,
    });

    // Stable reference is what makes React 19's `use()` short-circuit on
    // subsequent renders + StrictMode double-invoke without re-suspending.
    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(__mountPromiseCacheSize()).toBe(1);

    // The body is suspended at `await scheduler.yield()`. afterEach will
    // abort it, the body resumes on a macrotask and rejects with
    // MountAbortError — surface that rejection so the unhandled-rejection
    // warning doesn't bleed into the next test.
    a.catch(() => {
      /* abort rejection — expected */
    });
  });

  test('repeated calls after resolution return the same resolved promise', async () => {
    const h = makeHarness('doc-resolved-stable');

    const first = mountTiptapEditorPromise({
      docName: h.docName,
      mountId: 'test-id',
      construct: h.construct,
    });
    const entry = await first;

    const second = mountTiptapEditorPromise({
      docName: h.docName,
      mountId: 'test-id',
      construct: h.construct,
    });
    expect(second).toBe(first);
    await expect(second).resolves.toBe(entry);
    // Construction runs exactly once across the two calls.
    expect(h.constructCallCount).toBe(1);
    expect(h.spies.mountCalls).toBe(1);
  });

  test('different docNames produce different promises', () => {
    const ha = makeHarness('doc-a');
    const hb = makeHarness('doc-b');

    const pa = mountTiptapEditorPromise({
      docName: ha.docName,
      mountId: 'test-id',
      construct: ha.construct,
    });
    const pb = mountTiptapEditorPromise({
      docName: hb.docName,
      mountId: 'test-id',
      construct: hb.construct,
    });

    expect(pa).not.toBe(pb);
    expect(__mountPromiseCacheSize()).toBe(2);

    // Bodies suspended at `await scheduler.yield()`; afterEach aborts both.
    // Surface the eventual abort rejections so they don't leak as unhandled
    // rejections into the next test.
    pa.catch(() => {
      /* abort rejection — expected */
    });
    pb.catch(() => {
      /* abort rejection — expected */
    });
  });
});

describe('invalidate-during-construction silent teardown (D27 silent-only)', () => {
  test('invalidateMountPromise during the post-construct yield-window tears down silently — promise stays orphaned, no rejection, no mark-emit beyond invalidate', async () => {
    const h = makeHarness('doc-silent-invalidate');
    // Stub scheduler.yield so the pre-construct yield resolves immediately
    // (construct runs) and the post-construct yield stalls — pins the body
    // in the post-construct yield-window so invalidate fires with a
    // populated preMountEditor.
    const origYield = scheduler.yield.bind(scheduler);
    let stallResolve: (() => void) | null = null;
    let yieldCallCount = 0;
    scheduler.yield = (() => {
      yieldCallCount++;
      if (yieldCallCount === 1) return Promise.resolve();
      return new Promise<void>((res) => {
        stallResolve = res;
      });
    }) as typeof scheduler.yield;

    try {
      const promise = mountTiptapEditorPromise({
        docName: h.docName,
        mountId: 'test-id',
        construct: h.construct,
      });
      let consumerRejected = false;
      promise.catch(() => {
        consumerRejected = true;
      });

      // Drain microtasks so the body resumes from the pre-construct yield,
      // runs construct() (sets preMountEditor), and suspends at the post-
      // construct yield (stalled by the stub).
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(h.constructCallCount).toBe(1);

      // Invalidate during the post-construct yield-window. Cache entry is
      // removed, pre-mount editor is destroyed by invalidate itself (NOT
      // the body's abort path), and the consumer promise is left orphaned.
      invalidateMountPromise(h.docName);

      expect(h.spies.destroyCalls).toBe(1);
      expect(__mountPromiseCacheSize()).toBe(0);

      // Release the stalled yield so the body resumes and short-circuits at
      // the post-construct abort check. Drain again to catch the settled
      // state. Re-assert destroyCalls === 1 (symmetric with the companion
      // explicit-abort test): if entry.preMountEditor were not cleared on
      // the invalidate path, the body's post-construct abort branch would
      // run a second destroy.
      if (stallResolve) (stallResolve as () => void)();
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(consumerRejected).toBe(false);
      expect(h.spies.mountCalls).toBe(0);
      expect(h.spies.destroyCalls).toBe(1);
    } finally {
      scheduler.yield = origYield;
    }
  });

  test('invalidateMountPromise during the pre-construct yield-window tears down silently — construct is skipped entirely, no editor to destroy', async () => {
    // Pre-construct invalidate is the rapid-nav-away case where the user
    // navigates away before construct() even begins. The body short-circuits
    // at the pre-construct abort check — no editor is ever built, no destroy
    // is needed, no rejection surfaces.
    const h = makeHarness('doc-silent-invalidate-pre-construct');

    const promise = mountTiptapEditorPromise({
      docName: h.docName,
      mountId: 'test-id',
      construct: h.construct,
    });
    let consumerRejected = false;
    promise.catch(() => {
      consumerRejected = true;
    });

    // Synchronous invalidate — body has scheduled its first await but not
    // yet resumed; preMountEditor is still null.
    invalidateMountPromise(h.docName);
    expect(__mountPromiseCacheSize()).toBe(0);

    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(consumerRejected).toBe(false);
    expect(h.constructCallCount).toBe(0);
    expect(h.spies.destroyCalls).toBe(0);
    expect(h.spies.mountCalls).toBe(0);
  });

  test('after silent invalidate, next call returns a fresh promise (re-mount succeeds)', async () => {
    const h = makeHarness('doc-reinvalidate');

    const orphaned = mountTiptapEditorPromise({
      docName: h.docName,
      mountId: 'test-id',
      construct: h.construct,
    });
    orphaned.catch(() => {
      /* silent invalidate leaves it orphaned, but install a no-op handler
       * so any rare body-side throw doesn't surface as an unhandled
       * rejection in the next test's window */
    });
    invalidateMountPromise(h.docName);
    // Drain macrotasks so the body's abort path completes; do NOT await
    // the orphaned promise (silent invalidate never settles it).
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    // Build a fresh harness so the destroyed editor isn't reused
    const h2 = makeHarness(h.docName);
    const fresh = mountTiptapEditorPromise({
      docName: h2.docName,
      mountId: 'test-id',
      construct: h2.construct,
    });
    expect(fresh).not.toBe(orphaned);
    const entry = await fresh;
    expect(entry.editor).toBe(h2.editor);
    expect(h2.spies.mountCalls).toBe(1);
  });
});

describe('mount-failure error path', () => {
  test('editor.mount throws → editor.destroy() called, promise rejects with the original error', async () => {
    const h = makeHarness('doc-mount-fail');
    h.spies.mountThrows = true;

    const promise = mountTiptapEditorPromise({
      docName: h.docName,
      mountId: 'test-id',
      construct: h.construct,
    });

    await expect(promise).rejects.toThrow('synthetic mount failure');
    expect(h.constructCallCount).toBe(1);
    expect(h.spies.mountCalls).toBe(1);
    // Pre-mount editor.destroy() must run on the mount-failure cleanup path.
    expect(h.spies.destroyCalls).toBe(1);
    // V2 cache must NOT contain the entry — the registration step never ran.
    expect(__getCacheSize('tiptap')).toBe(0);
  });

  test('rejected entry stays in mount-promise cache so re-entry returns same rejected thenable', async () => {
    // Models the React re-render after rejection: TiptapEditor's `use()`
    // sees the same rejected promise on every re-render and re-throws to
    // DocumentErrorBoundary without creating a fresh in-flight construction.
    const h = makeHarness('doc-rejected-stable');
    h.spies.mountThrows = true;

    const first = mountTiptapEditorPromise({
      docName: h.docName,
      mountId: 'test-id',
      construct: h.construct,
    });
    await first.catch(() => {
      /* settle */
    });

    const second = mountTiptapEditorPromise({
      docName: h.docName,
      mountId: 'test-id',
      construct: h.construct,
    });
    expect(second).toBe(first);
    await expect(second).rejects.toThrow('synthetic mount failure');
    // construct + mount ran exactly once across the two calls.
    expect(h.constructCallCount).toBe(1);
    expect(h.spies.mountCalls).toBe(1);
    // Cache holds the settled-rejected entry.
    expect(__mountPromiseSettled(h.docName)).toBe(true);
  });

  test('after rejection + invalidate, next call re-attempts construction', async () => {
    const h = makeHarness('doc-recover-after-fail');
    h.spies.mountThrows = true;

    const first = mountTiptapEditorPromise({
      docName: h.docName,
      mountId: 'test-id',
      construct: h.construct,
    });
    await first.catch(() => {
      /* settle */
    });

    // Invalidate clears the rejected entry — equivalent to user clicking
    // "Try again" in DocumentErrorBoundary which recycles the cache.
    invalidateMountPromise(h.docName);
    expect(__mountPromiseCacheSize()).toBe(0);

    // Fresh harness with mount that succeeds — should now construct + mount.
    const h2 = makeHarness(h.docName);
    const second = mountTiptapEditorPromise({
      docName: h2.docName,
      mountId: 'test-id',
      construct: h2.construct,
    });
    const entry = await second;
    expect(entry.editor).toBe(h2.editor);
    expect(h2.constructCallCount).toBe(1);
    expect(h2.spies.mountCalls).toBe(1);
  });

  test('construct() throws → promise rejects with the original error, no mount call', async () => {
    getCollector()?.reset();
    const constructError = new Error('synthetic construct failure');
    const promise = mountTiptapEditorPromise({
      docName: 'doc-construct-fail',
      mountId: 'test-id',
      construct: () => {
        throw constructError;
      },
    });
    await expect(promise).rejects.toBe(constructError);
    // No editor existed to destroy — destroyCalls is N/A here, but the
    // V2 cache should be empty (registration never reached).
    expect(__getCacheSize('tiptap')).toBe(0);
    // The reject mark carries the underlying failure message — same
    // observability contract the post-settle-throw backstop pins — so a
    // construct-time crash (e.g. the pre-warm fragment walk throwing on a
    // corrupt remote-authored doc) is diagnosable from traces, not only via
    // the error boundary.
    const marks = getCollector()?.marks.toArray() ?? [];
    const rejectMark = marks.find((m) => m.name === 'ok/mount/reject');
    expect(rejectMark?.properties?.reason).toBe('construct-failed');
    expect(rejectMark?.properties?.message).toContain('synthetic construct failure');
  });

  test('destroy() throws after mount() throws → promise still rejects with original mount error', async () => {
    // Resilience pin for `destroyPreMountEditor`: a TipTap regression in
    // pre-mount-destroy idempotency must not break the mount-failure path —
    // the consumer's `use()` still needs to re-throw the ORIGINAL mount
    // failure (not the destroy failure), so DocumentErrorBoundary surfaces
    // the right diagnosis. The destroy throw is observable via the
    // `ok/mount/destroy-failed` telemetry mark, not by changing the
    // rejection shape.
    const h = makeHarness('doc-destroy-throws-after-mount-fail');
    h.spies.mountThrows = true;
    h.spies.destroyThrows = true;

    const promise = mountTiptapEditorPromise({
      docName: h.docName,
      mountId: 'test-id',
      construct: h.construct,
    });

    await expect(promise).rejects.toThrow('synthetic mount failure');
    expect(h.spies.mountCalls).toBe(1);
    expect(h.spies.destroyCalls).toBe(1);
    expect(__getCacheSize('tiptap')).toBe(0);
  });

  test('destroy() throws on explicit-abort path → promise still rejects with MountAbortError', async () => {
    // Resilience pin for the explicit-cancel path (controller.abort()):
    // a pre-mount destroy throw must not promote into a different rejection
    // shape. The cancel-affordance caller still gets a clean MountAbortError
    // so DocumentErrorBoundary's errorCopy can branch on "user cancelled"
    // vs "real failure" without inspecting the destroy throw.
    //
    // Distinct from invalidate (silent), explicit abort DOES reject.
    const h = makeHarness('doc-destroy-throws-on-abort');
    h.spies.destroyThrows = true;

    // Stub scheduler.yield so the pre-construct yield resolves immediately
    // and the post-construct yield stalls — pins the body in the post-
    // construct yield-window so abort fires with a populated preMountEditor.
    const origYield = scheduler.yield.bind(scheduler);
    let stallResolve: (() => void) | null = null;
    let yieldCallCount = 0;
    scheduler.yield = (() => {
      yieldCallCount++;
      if (yieldCallCount === 1) return Promise.resolve();
      return new Promise<void>((res) => {
        stallResolve = res;
      });
    }) as typeof scheduler.yield;

    try {
      const promise = mountTiptapEditorPromise({
        docName: h.docName,
        mountId: 'test-id',
        construct: h.construct,
      });
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(h.constructCallCount).toBe(1);

      const controller = getMountAbortController(h.docName);
      expect(controller).not.toBeNull();
      controller?.abort();

      await expect(promise).rejects.toMatchObject({
        name: 'MountAbortError',
        docName: h.docName,
      });
      // The abort listener invoked destroyPreMountEditor synchronously,
      // cleared entry.preMountEditor = null, and the body's post-yield
      // branch sees null and skips its own destroy — destroy ran exactly
      // once. A double-destroy regression (e.g. if the listener stopped
      // clearing preMountEditor) would fail toBe(1) here.
      if (stallResolve) (stallResolve as () => void)();
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(h.spies.destroyCalls).toBe(1);
    } finally {
      scheduler.yield = origYield;
    }
  });

  // Note on v2-register-failed path coverage: the structural surface of the
  // v2-register-failed catch (mount-promise.ts post-mount) is identical to the
  // mount-failed and abort catches above — same destroyPreMountEditor() helper
  // call, same rejectFn shape, same telemetry mark. The dedicated test for
  // this path requires forcing mountTiptapEditor to throw on its MISS-path
  // registration step, which would need a runtime monkey-patch on a frozen
  // ESM export — fragile and ESM-strict-mode hostile. Coverage is provided
  // structurally by:
  //   1. The destroyPreMountEditor + rejectFn behavior shared with the
  //      mount-failed test pins the recovery shape.
  //   2. The unhandled-throw backstop tests below pin that any throw
  //      (including hypothetical future v2-register-failed if it escapes
  //      the inner try/catch) settles the consumer promise.
  //   3. The v2-register-failed catch's only divergence — destroying a
  //      FULLY mounted editor — uses the same destroyPreMountEditor helper
  //      whose UndoManager-cleanup contract is pinned by the mount-failed
  //      destroy resilience test. A regression in V2 cache
  //      registration that throws would surface there.
});

describe('invalidateMountPromise', () => {
  test('is a safe no-op when no entry exists for docName', () => {
    expect(() => invalidateMountPromise('never-created')).not.toThrow();
    expect(__mountPromiseCacheSize()).toBe(0);
  });

  test('removes a settled (resolved) entry on invalidate', async () => {
    const h = makeHarness('doc-invalidate-resolved');
    const promise = mountTiptapEditorPromise({
      docName: h.docName,
      mountId: 'test-id',
      construct: h.construct,
    });
    await promise;
    expect(__mountPromiseCacheSize()).toBe(1);

    invalidateMountPromise(h.docName);
    expect(__mountPromiseCacheSize()).toBe(0);
  });

  test('after invalidating a resolved entry, next call re-runs construct (V2 cache miss path)', async () => {
    // After the V2 cache is also cleared (via reset between tests), a fresh
    // mount-promise call must re-run construct + mount because both caches
    // are empty.
    const h = makeHarness('doc-fresh-after-invalidate');
    const first = mountTiptapEditorPromise({
      docName: h.docName,
      mountId: 'test-id',
      construct: h.construct,
    });
    const firstEntry = await first;
    expect(firstEntry.editor).toBe(h.editor);

    // Reset both caches to simulate "navigated away long enough to evict".
    invalidateMountPromise(h.docName);
    __resetCacheForTests(); // Clear V2 cache too — models eviction

    // Re-attempt — should re-construct.
    const h2 = makeHarness(h.docName);
    const second = mountTiptapEditorPromise({
      docName: h2.docName,
      mountId: 'test-id',
      construct: h2.construct,
    });
    const secondEntry = await second;
    expect(secondEntry.editor).toBe(h2.editor);
    expect(h2.constructCallCount).toBe(1);
  });
});

describe('error class shape', () => {
  test('MountAbortError extends Error and carries docName', () => {
    const err = new MountAbortError('some-doc');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(MountAbortError);
    expect(err.name).toBe('MountAbortError');
    expect(err.docName).toBe('some-doc');
    expect(err.message).toContain('some-doc');
  });

  // MountTimeoutError + MOUNT_TIMEOUT_MS were retired in the perf-substrate
  // consolidation (precedent 41) — the 30s auto-reject watchdog
  // produced false-negative cancellations on slow IDB hydrate / network
  // partition. Cooperative cancellation via `controller.abort()`
  // is the only settle-on-stall path.
});

describe('stalled-but-pending observability (D27 LOCKED, precedent 41)', () => {
  // The substrate emits `ok/mount/stalled` ONCE per entry at
  // MOUNT_STALLED_THRESHOLD_MS (10s default; tests override to 50ms via
  // window.__okPerfOverrides). The promise STAYS pending — slow loads are
  // not auto-failures.

  beforeEach(() => {
    if (typeof globalThis.window === 'undefined') {
      // biome-ignore lint/suspicious/noExplicitAny: minimal test-only window stub
      (globalThis as any).window = {
        __okPerfOverrides: { MOUNT_STALLED_THRESHOLD_MS: 50 },
        addEventListener: () => {},
        removeEventListener: () => {},
        __testInstalled: true,
      };
    } else {
      window.__okPerfOverrides = { MOUNT_STALLED_THRESHOLD_MS: 50 };
    }
  });

  afterEach(() => {
    if (typeof globalThis.window !== 'undefined' && window.__okPerfOverrides) {
      delete window.__okPerfOverrides.MOUNT_STALLED_THRESHOLD_MS;
    }
  });

  test('emits ok/mount/stalled once at threshold; promise remains pending', async () => {
    const h = makeHarness('doc-stalled-once');
    const origYield = scheduler.yield.bind(scheduler);
    let stallResolve: (() => void) | null = null;
    scheduler.yield = (() =>
      new Promise<void>((res) => {
        stallResolve = res;
      })) as typeof scheduler.yield;
    try {
      const promise = mountTiptapEditorPromise({
        docName: h.docName,
        mountId: 'test-id',
        construct: h.construct,
      });
      promise.catch(() => {
        /* swallow eventual abort from afterEach */
      });
      // Wait past the 50ms threshold.
      await new Promise<void>((resolve) => setTimeout(resolve, 80));
      expect(__mountPromiseStalledEmitted(h.docName)).toBe(true);
      // Promise is still pending — no auto-rejection.
      expect(__mountPromiseSettled(h.docName)).toBe(false);
      expect(__mountPromiseCacheSize()).toBe(1);
    } finally {
      scheduler.yield = origYield;
      if (stallResolve) (stallResolve as () => void)();
    }
  });

  test('visibility-restore reaper emits stalled mark when threshold elapsed during background', async () => {
    const h = makeHarness('doc-stalled-reaper');
    const origYield = scheduler.yield.bind(scheduler);
    let stallResolve: (() => void) | null = null;
    scheduler.yield = (() =>
      new Promise<void>((res) => {
        stallResolve = res;
      })) as typeof scheduler.yield;
    try {
      const promise = mountTiptapEditorPromise({
        docName: h.docName,
        mountId: 'test-id',
        construct: h.construct,
      });
      promise.catch(() => {
        /* swallow eventual abort */
      });
      // Reaper runs synchronously with a future "now" past the threshold.
      // Simulates: tab backgrounded BEFORE timer fired, threshold elapsed
      // during background, tab restores → visibilitychange handler fires.
      __reapStalledOnVisible(Date.now() + 10_000);
      expect(__mountPromiseStalledEmitted(h.docName)).toBe(true);
      expect(__mountPromiseSettled(h.docName)).toBe(false);
    } finally {
      scheduler.yield = origYield;
      if (stallResolve) (stallResolve as () => void)();
    }
  });

  test('stalled mark is idempotent — timer-fire then reaper does not double-emit', async () => {
    const h = makeHarness('doc-stalled-idempotent');
    const origYield = scheduler.yield.bind(scheduler);
    let stallResolve: (() => void) | null = null;
    scheduler.yield = (() =>
      new Promise<void>((res) => {
        stallResolve = res;
      })) as typeof scheduler.yield;
    try {
      const promise = mountTiptapEditorPromise({
        docName: h.docName,
        mountId: 'test-id',
        construct: h.construct,
      });
      promise.catch(() => {});
      await new Promise<void>((resolve) => setTimeout(resolve, 80));
      expect(__mountPromiseStalledEmitted(h.docName)).toBe(true);
      const collector = getCollector();
      const beforeCount = collector
        ? collector.marks.toArray().filter((m) => m.name === 'ok/mount/stalled').length
        : 0;
      // Reaper called again after timer already fired — idempotent guard
      // prevents a second emission.
      __reapStalledOnVisible(Date.now() + 10_000);
      const afterCount = collector
        ? collector.marks.toArray().filter((m) => m.name === 'ok/mount/stalled').length
        : 0;
      expect(afterCount).toBe(beforeCount);
    } finally {
      scheduler.yield = origYield;
      if (stallResolve) (stallResolve as () => void)();
    }
  });
});

describe('D27 no-timer-reject regression guard', () => {
  // Permanently regress the "auto-reject after timer" architectural mistake.
  // Under no scenario should a stalled mount produce an `ok/mount/reject`
  // mark with reason 'timeout'. The mark namespace is GONE from the substrate.

  test('no ok/mount/reject mark with reason "timeout" ever fires', async () => {
    const h = makeHarness('d27-no-timer-reject');
    const origYield = scheduler.yield.bind(scheduler);
    let stallResolve: (() => void) | null = null;
    scheduler.yield = (() =>
      new Promise<void>((res) => {
        stallResolve = res;
      })) as typeof scheduler.yield;
    if (typeof globalThis.window === 'undefined') {
      // biome-ignore lint/suspicious/noExplicitAny: minimal test-only window stub
      (globalThis as any).window = {
        __okPerfOverrides: { MOUNT_STALLED_THRESHOLD_MS: 30 },
        addEventListener: () => {},
        removeEventListener: () => {},
        __testInstalled: true,
      };
    } else {
      window.__okPerfOverrides = { MOUNT_STALLED_THRESHOLD_MS: 30 };
    }
    try {
      const promise = mountTiptapEditorPromise({
        docName: h.docName,
        mountId: 'test-id',
        construct: h.construct,
      });
      promise.catch(() => {});
      // Generous wait — 200ms is well past 30ms threshold AND past any
      // reasonable derived legacy-watchdog interval.
      await new Promise<void>((resolve) => setTimeout(resolve, 200));
      // Reaper too — every reasonable code path that COULD have produced a
      // timer-driven rejection.
      __reapStalledOnVisible(Date.now() + 60_000);
      const collector = getCollector();
      if (collector) {
        const timeoutRejects = collector.marks
          .toArray()
          .filter((m) => m.name === 'ok/mount/reject' && m.properties?.reason === 'timeout');
        expect(timeoutRejects).toEqual([]);
      }
      // Promise STILL pending — confirms the spec contract.
      expect(__mountPromiseSettled(h.docName)).toBe(false);
    } finally {
      scheduler.yield = origYield;
      if (stallResolve) (stallResolve as () => void)();
      if (typeof globalThis.window !== 'undefined' && window.__okPerfOverrides) {
        delete window.__okPerfOverrides.MOUNT_STALLED_THRESHOLD_MS;
      }
    }
  });
});

describe('mountId payload (US-006 / FR5 / AC13 — cross-namespace correlation)', () => {
  // Every mark emitted by the substrate must carry mountId so cache, mount,
  // sync, cold, and typing namespaces join deterministically.

  test('every ok/mount/* mark carries the mountId from the call', async () => {
    const h = makeHarness('mountid-payload');
    const collector = getCollector();
    if (!collector) {
      // Collector inactive in this build — skip without failing.
      return;
    }
    const beforeMarks = collector.marks.toArray().length;
    await mountTiptapEditorPromise({
      docName: h.docName,
      mountId: 'specific-mount-id-7',
      construct: h.construct,
    });
    const newMarks = collector.marks.toArray().slice(beforeMarks);
    const mountMarks = newMarks.filter((m) => m.name.startsWith('ok/mount/'));
    expect(mountMarks.length).toBeGreaterThan(0);
    for (const m of mountMarks) {
      // The mark payload's caller-supplied fields land in `properties` per
      // the PerfMark schema; mountId is one of them.
      expect(m.properties?.mountId).toBe('specific-mount-id-7');
    }
  });
});

describe('getMountAbortController (FW13 explicit-cancel surface)', () => {
  test('returns null when no entry exists', () => {
    expect(getMountAbortController('never-registered')).toBeNull();
  });

  test('returns the entry controller; .abort() in the pre-construct yield window rejects with MountAbortError, construct skipped', async () => {
    // Synchronous abort fires before the body has resumed from the pre-
    // construct yield. The body short-circuits at the pre-construct abort
    // check, never paying the construct() cost. This is the key performance
    // invariant — pin the construct/destroy counts so a
    // future regression of the pre-construct abort guard would fail loudly.
    const h = makeHarness('explicit-abort');
    const promise = mountTiptapEditorPromise({
      docName: h.docName,
      mountId: 'test-id',
      construct: h.construct,
    });
    const controller = getMountAbortController(h.docName);
    expect(controller).not.toBeNull();
    controller?.abort();
    await expect(promise).rejects.toMatchObject({
      name: 'MountAbortError',
      docName: h.docName,
    });
    // Pre-construct abort: construct must NOT have been called. Drain
    // macrotasks first so the body resumes from the (resolved) pre-construct
    // yield and takes the abort short-circuit before assertions land.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(h.constructCallCount).toBe(0);
    expect(h.spies.mountCalls).toBe(0);
    expect(h.spies.destroyCalls).toBe(0);
  });

  test('explicit abort during the post-construct scheduler.yield window: rejects with MountAbortError, destroys pre-mount editor exactly once, mount() never called', async () => {
    // The canonical cancel-button race: the user clicks Cancel while
    // the editor is constructed but not yet mounted. construct() has run
    // (preMountEditor is set on the entry), but the body is suspended at
    // the post-construct `await scheduler.yield()`. This test pins the
    // tightest interaction in the module — the abort listener's
    // preMountEditor cleanup vs the body's post-yield abort check race
    // must produce exactly one destroy() call (no double-destroy of an
    // already-cleaned editor) and the post-yield branch must short-circuit
    // before mount().
    //
    // The body has two `await scheduler.yield()` points: one before construct
    // (pre-construct yield, for sibling-subtree paint) and one after (the
    // canonical construct→mount split). The stub lets the first resolve so
    // construct runs, and stalls on the second so we can fire abort against
    // a populated preMountEditor entry.
    const h = makeHarness('explicit-abort-during-yield');
    const origYield = scheduler.yield.bind(scheduler);
    let stallResolve: (() => void) | null = null;
    let yieldCallCount = 0;
    scheduler.yield = (() => {
      yieldCallCount++;
      if (yieldCallCount === 1) {
        return Promise.resolve();
      }
      return new Promise<void>((res) => {
        stallResolve = res;
      });
    }) as typeof scheduler.yield;

    try {
      const promise = mountTiptapEditorPromise({
        docName: h.docName,
        mountId: 'test-id',
        construct: h.construct,
      });
      // Drain microtasks so the body resumes from the pre-construct yield,
      // runs construct() (sets preMountEditor), and suspends at the post-
      // construct yield. The second yield never resolves under the stub.
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(h.constructCallCount).toBe(1);

      // Now fire the explicit-abort path WHILE the body is suspended.
      const controller = getMountAbortController(h.docName);
      expect(controller).not.toBeNull();
      controller?.abort();

      await expect(promise).rejects.toMatchObject({
        name: 'MountAbortError',
        docName: h.docName,
      });
      // Pin the load-bearing assertions for the race:
      //   - destroy() ran exactly once (the abort listener's cleanup; the
      //     body's post-yield branch sees entry.preMountEditor=null after
      //     the listener cleared it and skips its own destroy)
      //   - mount() was NEVER called (post-yield abort check short-circuited)
      // Release the stalled yield so the body can resume + take the abort
      // short-circuit path; drain again so the assertion catches the
      // settled state.
      if (stallResolve) (stallResolve as () => void)();
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(h.spies.destroyCalls).toBe(1);
      expect(h.spies.mountCalls).toBe(0);
    } finally {
      scheduler.yield = origYield;
    }
  });
});

describe('subscribeMountStalled (FW13 affordance contract)', () => {
  beforeEach(() => {
    if (typeof globalThis.window === 'undefined') {
      // biome-ignore lint/suspicious/noExplicitAny: minimal test-only window stub
      (globalThis as any).window = {
        __okPerfOverrides: { MOUNT_STALLED_THRESHOLD_MS: 50 },
        addEventListener: () => {},
        removeEventListener: () => {},
        __testInstalled: true,
      };
    } else {
      window.__okPerfOverrides = { MOUNT_STALLED_THRESHOLD_MS: 50 };
    }
  });

  afterEach(() => {
    if (typeof globalThis.window !== 'undefined' && window.__okPerfOverrides) {
      delete window.__okPerfOverrides.MOUNT_STALLED_THRESHOLD_MS;
    }
  });

  test('callback fires for new stalled emissions; unsubscribe stops further fires', async () => {
    const h = makeHarness('subscribe-fan-out');
    const origYield = scheduler.yield.bind(scheduler);
    let stallResolve: (() => void) | null = null;
    scheduler.yield = (() =>
      new Promise<void>((res) => {
        stallResolve = res;
      })) as typeof scheduler.yield;
    const events: { docName: string; mountId: string }[] = [];
    const unsubscribe = subscribeMountStalled((docName, mountId) => {
      events.push({ docName, mountId });
    });
    try {
      const promise = mountTiptapEditorPromise({
        docName: h.docName,
        mountId: 'sub-mount-id',
        construct: h.construct,
      });
      promise.catch(() => {});
      await new Promise<void>((resolve) => setTimeout(resolve, 80));
      expect(events).toEqual([{ docName: h.docName, mountId: 'sub-mount-id' }]);
      unsubscribe();
    } finally {
      scheduler.yield = origYield;
      if (stallResolve) (stallResolve as () => void)();
    }
  });

  test('late subscriber receives replay of existing stalled-but-pending entries', async () => {
    const h = makeHarness('subscribe-replay');
    const origYield = scheduler.yield.bind(scheduler);
    let stallResolve: (() => void) | null = null;
    scheduler.yield = (() =>
      new Promise<void>((res) => {
        stallResolve = res;
      })) as typeof scheduler.yield;
    try {
      const promise = mountTiptapEditorPromise({
        docName: h.docName,
        mountId: 'replay-mount-id',
        construct: h.construct,
      });
      promise.catch(() => {});
      await new Promise<void>((resolve) => setTimeout(resolve, 80));
      expect(__mountPromiseStalledEmitted(h.docName)).toBe(true);
      // Subscribe AFTER the stall fired — must receive the replay.
      const events: { docName: string; mountId: string }[] = [];
      const unsubscribe = subscribeMountStalled((docName, mountId) => {
        events.push({ docName, mountId });
      });
      expect(events).toEqual([{ docName: h.docName, mountId: 'replay-mount-id' }]);
      unsubscribe();
    } finally {
      scheduler.yield = origYield;
      if (stallResolve) (stallResolve as () => void)();
    }
  });
});

describe('visibility handler lifecycle (idempotent install/uninstall)', () => {
  test('handler installs when cache becomes non-empty and uninstalls when cache empties', async () => {
    expect(__mountPromiseVisibilityHandlerInstalled()).toBe(false);
    const h = makeHarness('vis-lifecycle');
    await mountTiptapEditorPromise({
      docName: h.docName,
      mountId: 'test-id',
      construct: h.construct,
    });
    expect(__mountPromiseVisibilityHandlerInstalled()).toBe(true);
    invalidateMountPromise(h.docName);
    expect(__mountPromiseVisibilityHandlerInstalled()).toBe(false);
  });
});

describe('mountPromiseHasResolved (warm-reopen overlay gate)', () => {
  // EditorArea's deferred-value skeleton overlay reads this helper to skip
  // the overlay when both promises have resolved entries. Distinct from the
  // test-only `__mountPromiseSettled` because rejected entries are settled
  // but their consumers will throw to error boundary, not short-circuit.

  test('returns false when no entry exists', () => {
    expect(mountPromiseHasResolved('never-mounted')).toBe(false);
  });

  test('returns false while a mount is pending (constructed but not yet awaited)', () => {
    // Inside the construct→yield window the entry exists but resolved=false.
    const h = makeHarness('pending-doc');
    const promise = mountTiptapEditorPromise({
      docName: h.docName,
      mountId: 'test-id',
      construct: h.construct,
    });
    // Swallow the rejection that fires when afterEach() calls
    // __resetMountPromiseCache and aborts the in-flight body. The test
    // doesn't await the promise so the MountAbortError would otherwise
    // surface as an unhandled rejection across test boundaries.
    promise.catch(() => {});
    expect(mountPromiseHasResolved(h.docName)).toBe(false);
  });

  test('returns true after a successful V2 cache MISS resolve', async () => {
    const h = makeHarness('resolved-miss-doc');
    await mountTiptapEditorPromise({
      docName: h.docName,
      mountId: 'test-id',
      construct: h.construct,
    });
    expect(mountPromiseHasResolved(h.docName)).toBe(true);
  });

  test('returns true after a V2 cache HIT short-circuit resolve', async () => {
    // Pre-seed V2 so the next mountTiptapEditorPromise hits the HIT branch.
    const h = makeHarness('resolved-hit-doc');
    await mountTiptapEditorPromise({
      docName: h.docName,
      mountId: 'test-id',
      construct: h.construct,
    });
    invalidateMountPromise(h.docName); // Clear mount-promise cache only; V2 stays.
    expect(mountPromiseHasResolved(h.docName)).toBe(false);

    const h2 = makeHarness(h.docName);
    await mountTiptapEditorPromise({
      docName: h2.docName,
      mountId: 'test-id',
      construct: h2.construct,
    });
    expect(mountPromiseHasResolved(h.docName)).toBe(true);
  });

  test('returns false on rejected mount (settled but not resolved)', async () => {
    const h = makeHarness('rejected-doc');
    h.editor.mount = () => {
      throw new Error('mount-failed');
    };
    let rejected = false;
    try {
      await mountTiptapEditorPromise({
        docName: h.docName,
        mountId: 'test-id',
        construct: h.construct,
      });
    } catch {
      rejected = true;
    }
    expect(rejected).toBe(true);
    // Entry is settled (settled=true) but NOT resolved.
    expect(__mountPromiseSettled(h.docName)).toBe(true);
    expect(mountPromiseHasResolved(h.docName)).toBe(false);
  });

  test('returns false after invalidate (entry removed)', async () => {
    const h = makeHarness('invalidated-doc');
    await mountTiptapEditorPromise({
      docName: h.docName,
      mountId: 'test-id',
      construct: h.construct,
    });
    expect(mountPromiseHasResolved(h.docName)).toBe(true);
    invalidateMountPromise(h.docName);
    expect(mountPromiseHasResolved(h.docName)).toBe(false);
  });
});

describe('scheduler.yield wiring', () => {
  // Spy helper: replace `scheduler.yield` with a counting passthrough that
  // delegates to the real implementation so the body's normal flow continues.
  // afterEach restores the original. Mirrors editor-cache.test.ts's spy idiom.
  function withYieldSpy<T>(fn: (calls: { count: number }) => Promise<T>): Promise<T> {
    const calls = { count: 0 };
    const original = scheduler.yield.bind(scheduler);
    scheduler.yield = ((): Promise<void> => {
      calls.count++;
      return original();
    }) as typeof scheduler.yield;
    return fn(calls).finally(() => {
      scheduler.yield = original;
    });
  }

  test('cache MISS path invokes scheduler.yield exactly twice — once before construct, once between construct and mount', async () => {
    const h = makeHarness('doc-yield-twice');
    await withYieldSpy(async (calls) => {
      const entry = await mountTiptapEditorPromise({
        docName: h.docName,
        mountId: 'test-id',
        construct: h.construct,
      });
      // Two yields: pre-construct (for sibling-subtree paint) + post-
      // construct (for the construct→mount task split).
      expect(calls.count).toBe(2);
      expect(h.constructCallCount).toBe(1);
      expect(h.spies.mountCalls).toBe(1);
      expect(entry.editor).toBe(h.editor);
    });
  });

  test('V2 cache HIT short-circuit does NOT invoke scheduler.yield', async () => {
    // Pre-populate V2 cache so the mount-promise body takes the HIT path.
    const h = makeHarness('doc-yield-skipped-on-hit');
    const v2container = makeNode();
    mountTiptapEditor({
      docName: h.docName,
      container: v2container as unknown as HTMLElement,
      factory: (el) => {
        (el as unknown as FakeNode).appendChild(h.editorDom);
        return { editor: h.editor, ydoc: h.ydoc, ytext: h.ytext, provider: h.provider };
      },
    });

    await withYieldSpy(async (calls) => {
      await mountTiptapEditorPromise({
        docName: h.docName,
        mountId: 'test-id',
        construct: h.construct,
      });
      // HIT path skips construct + yield + mount entirely.
      expect(calls.count).toBe(0);
      expect(h.constructCallCount).toBe(0);
      expect(h.spies.mountCalls).toBe(0);
    });
  });

  test('construct() failure rejects after the pre-construct yield-point — the post-construct yield is skipped', async () => {
    // Sequence is yield → construct → yield → mount. A synchronous construct
    // failure happens AFTER the pre-construct yield (which is for paint, not
    // for the mount split) and BEFORE the post-construct yield. So exactly
    // one yield fires before the rejection settles.
    await withYieldSpy(async (calls) => {
      const constructError = new Error('synthetic construct failure');
      const promise = mountTiptapEditorPromise({
        docName: 'doc-construct-fail-pre-yield',
        mountId: 'test-id',
        construct: () => {
          throw constructError;
        },
      });
      await expect(promise).rejects.toBe(constructError);
      expect(calls.count).toBe(1);
    });
  });

  test('invalidateMountPromise during the pre-construct yield-window tears down silently — body short-circuits at abort check, no rejection, construct skipped', async () => {
    // Cache-driven invalidate must not produce a user-visible rejection —
    // the body short-circuits at the abort check when it resumes from the
    // pre-construct scheduler.yield. With invalidate firing synchronously
    // after the promise creation, construct never runs (no editor exists
    // to clean up) and the consumer promise stays orphaned.
    const h = makeHarness('doc-yield-silent');

    await withYieldSpy(async (calls) => {
      const promise = mountTiptapEditorPromise({
        docName: h.docName,
        mountId: 'test-id',
        construct: h.construct,
      });
      let consumerRejected = false;
      promise.catch(() => {
        consumerRejected = true;
      });

      invalidateMountPromise(h.docName);
      // Drain so the body resumes from the pre-construct scheduler.yield
      // and short-circuits at the abort check.
      await new Promise<void>((resolve) => setTimeout(resolve, 0));

      expect(consumerRejected).toBe(false);
      expect(calls.count).toBe(1); // pre-construct yield fired
      expect(h.constructCallCount).toBe(0); // construct skipped — aborted first
      expect(h.spies.mountCalls).toBe(0);
      expect(h.spies.destroyCalls).toBe(0); // no editor existed to destroy
    });
  });
});

describe('unhandled-throw backstop — body must reject, never hang', () => {
  // The body runs as a fire-and-forget IIFE (`void runMountBody(...)`). Any
  // throw OUTSIDE the body's own try/catch sites would otherwise leave the
  // outer promise pending forever, infinite-suspending React's `use(promise)`.
  // These tests pin the backstop: every runtime path that lands the body
  // outside its inner try/catch sites still settles the consumer promise.

  test('pre-construct scheduler.yield throwing → consumer promise rejects, construct skipped, no editor leak', async () => {
    // The pre-construct `await scheduler.yield()` is outside any try/catch
    // in runMountBody. If it rejects (e.g., a clobbered globalThis.scheduler
    // in some edge runtime) the body returns a rejected promise that the
    // `void` discards, leaving the consumer promise pending forever. The
    // backstop must settle the consumer promise. No editor exists yet at
    // this point — construct hasn't run — so there's nothing to destroy.
    const h = makeHarness('doc-pre-construct-yield-throws');

    const original = scheduler.yield.bind(scheduler);
    const yieldError = new Error('synthetic scheduler.yield failure');
    scheduler.yield = ((): Promise<void> => {
      return Promise.reject(yieldError);
    }) as typeof scheduler.yield;

    try {
      const promise = mountTiptapEditorPromise({
        docName: h.docName,
        mountId: 'test-id',
        construct: h.construct,
      });
      await expect(promise).rejects.toBeDefined();
      expect(h.constructCallCount).toBe(0);
      expect(h.spies.mountCalls).toBe(0);
      expect(h.spies.destroyCalls).toBe(0);
    } finally {
      scheduler.yield = original;
    }
  });

  test('post-construct scheduler.yield throwing → consumer promise rejects AND pre-mount editor is destroyed', async () => {
    // The post-construct `await scheduler.yield()` is the canonical leak-risk
    // point: construct() has built the editor (~30 MB graph including the
    // UndoManager `restore` closure) and the body
    // is about to mount. If this yield rejects, the backstop must both
    // settle the consumer promise AND destroy the constructed editor.
    const h = makeHarness('doc-post-construct-yield-throws');

    const original = scheduler.yield.bind(scheduler);
    const yieldError = new Error('synthetic scheduler.yield failure');
    let yieldCallCount = 0;
    scheduler.yield = ((): Promise<void> => {
      yieldCallCount++;
      if (yieldCallCount === 1) return Promise.resolve();
      return Promise.reject(yieldError);
    }) as typeof scheduler.yield;

    try {
      const promise = mountTiptapEditorPromise({
        docName: h.docName,
        mountId: 'test-id',
        construct: h.construct,
      });
      await expect(promise).rejects.toBeDefined();
      expect(h.constructCallCount).toBe(1);
      expect(h.spies.mountCalls).toBe(0);
      // The pre-mount editor MUST be destroyed by the backstop so the
      // UndoManager-restore closure cleanup (precedent #18(c)) runs and the
      // editor graph becomes GC-eligible.
      expect(h.spies.destroyCalls).toBe(1);
    } finally {
      scheduler.yield = original;
    }
  });

  test('V2 HIT path throwing → consumer promise rejects (does not hang)', async () => {
    // The V2 cache HIT short-circuit calls `mountTiptapEditor` outside any
    // try/catch in runMountBody. If the HIT-path reparent throws (e.g., DOM
    // operation on a destroyed view), the body would crash without calling
    // rejectFn — leaving the consumer promise pending forever.
    const h = makeHarness('doc-hit-throws');

    // Pre-populate V2 cache so mount-promise takes the HIT path.
    const v2container = makeNode();
    mountTiptapEditor({
      docName: h.docName,
      container: v2container as unknown as HTMLElement,
      factory: (el) => {
        (el as unknown as FakeNode).appendChild(h.editorDom);
        return { editor: h.editor, ydoc: h.ydoc, ytext: h.ytext, provider: h.provider };
      },
    });

    // Sabotage the editor's DOM so the HIT-path reparent (which moves
    // view.dom across DOM nodes) throws on appendChild. The failure should
    // surface as a rejection, not a hang.
    const sabotaged = h.editorDom as unknown as { parentElement: { removeChild: () => never } };
    sabotaged.parentElement = {
      removeChild: () => {
        throw new Error('synthetic HIT-path DOM failure');
      },
    };

    const promise = mountTiptapEditorPromise({
      docName: h.docName,
      mountId: 'test-id',
      construct: h.construct,
    });
    // Without the backstop: hangs forever, test times out.
    await expect(promise).rejects.toBeDefined();
  });

  test('invalidate followed by V2 HIT path throwing → backstop emits post-settle-throw mark; consumer promise stays orphaned (silent-teardown contract)', async () => {
    // The race that EXITS via the backstop's post-settle branch under
    // silent invalidate: invalidateMountPromise sets entry.settled=true
    // synchronously. If the body then runs the V2 HIT path and
    // mountTiptapEditor throws (no try/catch on the HIT path), the
    // backstop catches the throw, sees settled=true, and emits
    // `ok/mount/post-settle-throw` so the dropped error is observable.
    // The consumer promise is left orphaned (cache-driven invalidate
    // never produces a user-visible error UI).
    const h = makeHarness('doc-hit-throws-after-invalidate');

    const v2container = makeNode();
    mountTiptapEditor({
      docName: h.docName,
      container: v2container as unknown as HTMLElement,
      factory: (el) => {
        (el as unknown as FakeNode).appendChild(h.editorDom);
        return { editor: h.editor, ydoc: h.ydoc, ytext: h.ytext, provider: h.provider };
      },
    });

    const sabotaged = h.editorDom as unknown as { parentElement: { removeChild: () => never } };
    sabotaged.parentElement = {
      removeChild: () => {
        throw new Error('synthetic HIT-path DOM failure');
      },
    };

    getCollector()?.reset();

    const promise = mountTiptapEditorPromise({
      docName: h.docName,
      mountId: 'test-id',
      construct: h.construct,
    });
    let consumerRejected = false;
    promise.catch(() => {
      consumerRejected = true;
    });

    invalidateMountPromise(h.docName);
    // Drain macrotasks so the body's HIT-path crash + backstop both run.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(consumerRejected).toBe(false);
    const marks = getCollector()?.marks.toArray() ?? [];
    const postSettleMark = marks.find((m) => m.name === 'ok/mount/post-settle-throw');
    expect(postSettleMark).toBeDefined();
  });

  test('post-settle escape: body throw after invalidate emits ok/mount/post-settle-throw mark', async () => {
    // Companion to the test above. The consumer-facing contract there is
    // "promise rejects with MountAbortError." This test pins the engineer-
    // facing contract: when the body throws AFTER invalidate has already
    // settled the consumer promise, the actual `err` must NOT vanish. Without
    // a mark, an engineer debugging "why did rapid-nav cleanup fail" sees
    // `ok/mount/invalidate` followed by silence — the post-settle escape is
    // exactly the protection target the docstring names. The mark closes the
    // observability gap so a TipTap regression that starts throwing on
    // reparent is visible in traces.
    const h = makeHarness('doc-post-settle-mark');

    const v2container = makeNode();
    mountTiptapEditor({
      docName: h.docName,
      container: v2container as unknown as HTMLElement,
      factory: (el) => {
        (el as unknown as FakeNode).appendChild(h.editorDom);
        return { editor: h.editor, ydoc: h.ydoc, ytext: h.ytext, provider: h.provider };
      },
    });

    const sabotaged = h.editorDom as unknown as { parentElement: { removeChild: () => never } };
    sabotaged.parentElement = {
      removeChild: () => {
        throw new Error('synthetic HIT-path DOM failure for post-settle mark test');
      },
    };

    getCollector()?.reset();

    const promise = mountTiptapEditorPromise({
      docName: h.docName,
      mountId: 'test-id',
      construct: h.construct,
    });
    promise.catch(() => {
      /* swallow — under silent invalidate the consumer never settles */
    });
    invalidateMountPromise(h.docName);
    // Pump macrotasks so the body's HIT-path crash + backstop both run.
    // No await on the consumer promise — silent invalidate leaves it orphaned.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    const marks = getCollector()?.marks.toArray() ?? [];
    const postSettleMark = marks.find((m) => m.name === 'ok/mount/post-settle-throw');
    expect(postSettleMark).toBeDefined();
    expect(postSettleMark?.properties?.docName).toBe(h.docName);
    expect(postSettleMark?.properties?.message).toContain('synthetic HIT-path DOM failure');
  });
});

describe('ok/mount/resolve-elapsed-ms histogram (cap-graduation sweep substrate)', () => {
  // The mark.histogram consumer at the mount-promise resolve site feeds the
  // distribution the convention-cap-graduation sweep drains via
  // getHistogramSnapshot. Bucket name is kebab-case (the mark-name regex
  // rejects dots in the third segment); the paired DevTools mark — emitted
  // by mark.histogram itself — carries {docName, mountId, durationMs}.
  //
  // The existing `mark('ok/mount/resolve', ...)` emission is preserved
  // alongside; this test pins that both fire.

  beforeEach(() => {
    // Reset the collector inside this describe so histogram counts isolate
    // per test (mirrors the sync-promise.test.ts histogram describe block).
    // Without this, the count assertion below passes only because no prior
    // test in the file happened to emit to this bucket — a future
    // mount-promise-resolving test added above would silently break the
    // count expectation.
    getCollector()?.reset();
  });

  test('histogram bucket name passes validatePerfMarkName', () => {
    expect(validatePerfMarkName('ok/mount/resolve-elapsed-ms')).toBe(true);
  });

  test('cache MISS resolve increments the histogram with the measured elapsedMs', async () => {
    const h = makeHarness('doc-hist-miss');
    await mountTiptapEditorPromise({
      docName: h.docName,
      mountId: 'hist-mid',
      construct: h.construct,
    });
    const snap = getHistogramSnapshot('ok/mount/resolve-elapsed-ms');
    expect(snap).toBeDefined();
    expect(snap?.count).toBe(1);
    expect(snap?.max).toBeGreaterThanOrEqual(0);
    expect(snap?.max).toBeLessThan(10_000);
  });

  test('paired mark carries docName, mountId, durationMs', async () => {
    const collector = getCollector();
    if (!collector) return;
    const beforeMarks = collector.marks.toArray().length;
    const h = makeHarness('doc-hist-pair');
    await mountTiptapEditorPromise({
      docName: h.docName,
      mountId: 'hist-pair-mid',
      construct: h.construct,
    });
    const newMarks = collector.marks.toArray().slice(beforeMarks);
    const histMarks = newMarks.filter(
      (m) => m.name === 'ok/mount/resolve-elapsed-ms' && m.properties?.docName === 'doc-hist-pair',
    );
    expect(histMarks.length).toBe(1);
    const props = histMarks[0]?.properties;
    expect(props?.docName).toBe('doc-hist-pair');
    expect(props?.mountId).toBe('hist-pair-mid');
    expect(typeof props?.durationMs).toBe('number');
  });

  test('existing ok/mount/resolve mark is preserved alongside the histogram', async () => {
    const collector = getCollector();
    if (!collector) return;
    const beforeMarks = collector.marks.toArray().length;
    const h = makeHarness('doc-hist-coexist');
    await mountTiptapEditorPromise({
      docName: h.docName,
      mountId: 'coexist-mid',
      construct: h.construct,
    });
    const newMarks = collector.marks.toArray().slice(beforeMarks);
    const resolveMarks = newMarks.filter(
      (m) => m.name === 'ok/mount/resolve' && m.properties?.docName === 'doc-hist-coexist',
    );
    expect(resolveMarks.length).toBe(1);
  });

  test('V2 cache HIT path does NOT increment the histogram (resolve site is MISS-only)', async () => {
    // V2 HIT short-circuits before the MISS resolve site that calls
    // mark.histogram. The V2 cache layer already emits `ok/cache/hit`; a
    // second histogram emission here would over-count fast warm-reopens
    // against cold-mount latency in the sweep distribution.
    const h = makeHarness('doc-hist-hit');
    const v2container = makeNode();
    mountTiptapEditor({
      docName: h.docName,
      container: v2container as unknown as HTMLElement,
      factory: (el) => {
        (el as unknown as FakeNode).appendChild(h.editorDom);
        return { editor: h.editor, ydoc: h.ydoc, ytext: h.ytext, provider: h.provider };
      },
    });
    // Reset histograms so any prior MISS-path emission from earlier tests
    // doesn't pollute the count.
    getCollector()?.reset();
    await mountTiptapEditorPromise({
      docName: h.docName,
      mountId: 'hit-mid',
      construct: h.construct,
    });
    const snap = getHistogramSnapshot('ok/mount/resolve-elapsed-ms');
    expect(snap).toBeUndefined();
  });
});

describe('cold-mount span finalization on reject paths', () => {
  // Symmetric with sync-promise: every mount-promise reject path must finalize
  // the cold-mount root so the lazily-created entry from a sibling emit (pool
  // open, sync-promise) doesn't leak. Pre-emit mirrors what provider-pool's
  // pool.open() does on a cache MISS.

  beforeEach(() => {
    __resetColdMountSpans();
  });

  afterEach(() => {
    __resetColdMountSpans();
  });

  test('controller.abort() (explicit cancel) finalizes the cold-mount span', async () => {
    const h = makeHarness('reject-abort');
    emitColdMountChild('reject-abort-mid', 'ok.provider-pool.open', {}, Date.now(), Date.now() + 1);
    expect(__coldMountSpanCount()).toBe(1);

    const promise = mountTiptapEditorPromise({
      docName: h.docName,
      mountId: 'reject-abort-mid',
      construct: h.construct,
    });
    const controller = getMountAbortController(h.docName);
    controller?.abort();
    await expect(promise).rejects.toBeInstanceOf(MountAbortError);
    expect(__coldMountSpanCount()).toBe(0);
  });

  test('construct() throws → finalizes the cold-mount span', async () => {
    emitColdMountChild(
      'reject-construct-mid',
      'ok.provider-pool.open',
      {},
      Date.now(),
      Date.now() + 1,
    );
    expect(__coldMountSpanCount()).toBe(1);

    const promise = mountTiptapEditorPromise({
      docName: 'reject-construct',
      mountId: 'reject-construct-mid',
      construct: () => {
        throw new Error('synthetic construct failure');
      },
    });
    await expect(promise).rejects.toThrow('synthetic construct failure');
    expect(__coldMountSpanCount()).toBe(0);
  });

  test('editor.mount() throws → finalizes the cold-mount span', async () => {
    const h = makeHarness('reject-mount-fail');
    h.spies.mountThrows = true;
    emitColdMountChild(
      'reject-mount-fail-mid',
      'ok.provider-pool.open',
      {},
      Date.now(),
      Date.now() + 1,
    );
    expect(__coldMountSpanCount()).toBe(1);

    const promise = mountTiptapEditorPromise({
      docName: h.docName,
      mountId: 'reject-mount-fail-mid',
      construct: h.construct,
    });
    await expect(promise).rejects.toThrow('synthetic mount failure');
    expect(__coldMountSpanCount()).toBe(0);
  });

  test('invalidateMountPromise (silent teardown) finalizes the cold-mount span', async () => {
    // Asymmetric with the explicit-abort listener: invalidateMountPromise
    // sets entry.settled=true BEFORE entry.controller.abort() so the
    // abort-listener short-circuits on the settled guard and never reaches
    // finalizeColdMountSpan. If a sibling surface (ProviderPool.open,
    // sync-promise) lazily created the cold-mount root before invalidate
    // fired, that span would stay un-ended without invalidate's own
    // finalize. Pin the invariant: invalidate's teardown MUST be
    // observationally symmetric with the explicit-abort path.
    const h = makeHarness('invalidate-finalizes');
    emitColdMountChild(
      'invalidate-finalizes-mid',
      'ok.provider-pool.open',
      {},
      Date.now(),
      Date.now() + 1,
    );
    expect(__coldMountSpanCount()).toBe(1);

    // Kick off mount but don't await — invalidate is the teardown trigger
    // here. The promise orphans (resolves never, rejects never) per
    // invalidateMountPromise's silent contract — we are pinning the OTel
    // side-effect, not the promise.
    void mountTiptapEditorPromise({
      docName: h.docName,
      mountId: 'invalidate-finalizes-mid',
      construct: h.construct,
    });

    invalidateMountPromise(h.docName);
    expect(__coldMountSpanCount()).toBe(0);
  });
});

describe('rename invariant: toDocName mount is a fresh cold-mount (no orphaned Y.Doc)', () => {
  test('after fromDocName teardown, mountTiptapEditorPromise(toDocName) constructs a fresh editor bound to the new provider Y.Doc', async () => {
    const fromDocName = 'rename-from-doc';
    const toDocName = 'rename-to-doc';
    const hFrom = makeHarness(fromDocName);

    await mountTiptapEditorPromise({
      docName: fromDocName,
      mountId: 'mount-id-from',
      construct: hFrom.construct,
    });
    expect(mountPromiseHasResolved(fromDocName)).toBe(true);

    invalidateMountPromise(fromDocName);
    expect(mountPromiseHasResolved(fromDocName)).toBe(false);

    const hTo = makeHarness(toDocName);
    const toEntry = await mountTiptapEditorPromise({
      docName: toDocName,
      mountId: 'mount-id-to',
      construct: hTo.construct,
    });

    expect(hTo.constructCallCount).toBe(1);
    expect(toEntry.editor).toBe(hTo.editor);
    expect(toEntry.ydoc).toBe(hTo.ydoc);
    expect(toEntry.provider).toBe(hTo.provider);
  });
});
