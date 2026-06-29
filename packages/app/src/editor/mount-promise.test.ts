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
    setAttribute(_key, _value) {},
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
  mountThrows: boolean;
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
      focus() {},
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
    destroy() {},
    connect() {
      return Promise.resolve();
    },
    disconnect() {},
  } as unknown as HocuspocusProvider;
}

interface MountPromiseHarness {
  docName: string;
  ydoc: Y.Doc;
  ytext: Y.Text;
  editor: Editor;
  provider: HocuspocusProvider;
  editorDom: FakeNode;
  spies: FakeTiptapSpies;
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

let documentStubInstalled = false;
function installDocumentStub(): void {
  if (typeof globalThis.document !== 'undefined') return;
  // biome-ignore lint/suspicious/noExplicitAny: minimal test-only stub for `document.createElement`
  (globalThis as any).document = {
    createElement: (_tag: string) => makeNode(),
    addEventListener: (_event: string, _handler: () => void) => {},
    removeEventListener: (_event: string, _handler: () => void) => {},
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
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  uninstallDocumentStub();
  if (
    typeof globalThis.window !== 'undefined' &&
    (globalThis.window as { __testInstalled?: boolean }).__testInstalled === true
  ) {
    // biome-ignore lint/suspicious/noExplicitAny: tearing down test-installed window stub
    delete (globalThis as any).window;
  }
});

describe('cache HIT short-circuit (V2 cache pre-populated)', () => {
  test('V2 cache HIT: resolves to the same entry without calling construct', async () => {
    const h = makeHarness('doc-hit');

    const v2container = makeNode();
    const v2entry = mountTiptapEditor({
      docName: h.docName,
      container: v2container as unknown as HTMLElement,
      factory: (el) => {
        (el as unknown as FakeNode).appendChild(h.editorDom);
        return { editor: h.editor, ydoc: h.ydoc, ytext: h.ytext, provider: h.provider };
      },
    });
    expect(__getCacheSize('tiptap')).toBe(1);

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

    const entry = await promise;
    expect(h.constructCallCount).toBe(1);
    expect(h.spies.mountCalls).toBe(1);
    expect(h.spies.destroyCalls).toBe(0);
    expect(entry.editor).toBe(h.editor);
    expect(entry.ydoc).toBe(h.ydoc);
    expect(entry.ytext).toBe(h.ytext);
    expect(entry.provider).toBe(h.provider);
    expect(__getCacheSize('tiptap')).toBe(1);
    expect(__mountPromiseSettled(h.docName)).toBe(true);
  });

  test('cache MISS: editor is mounted into a transient detached div, NOT the V2 container directly', async () => {
    const h = makeHarness('doc-transient-mount');

    await mountTiptapEditorPromise({
      docName: h.docName,
      mountId: 'test-id',
      construct: h.construct,
    });

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

    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(__mountPromiseCacheSize()).toBe(1);

    a.catch(() => {});
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

    pa.catch(() => {});
    pb.catch(() => {});
  });
});

describe('invalidate-during-construction silent teardown (D27 silent-only)', () => {
  test('invalidateMountPromise during the post-construct yield-window tears down silently — promise stays orphaned, no rejection, no mark-emit beyond invalidate', async () => {
    const h = makeHarness('doc-silent-invalidate');
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

      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(h.constructCallCount).toBe(1);

      invalidateMountPromise(h.docName);

      expect(h.spies.destroyCalls).toBe(1);
      expect(__mountPromiseCacheSize()).toBe(0);

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
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

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
    expect(h.spies.destroyCalls).toBe(1);
    expect(__getCacheSize('tiptap')).toBe(0);
  });

  test('rejected entry stays in mount-promise cache so re-entry returns same rejected thenable', async () => {
    const h = makeHarness('doc-rejected-stable');
    h.spies.mountThrows = true;

    const first = mountTiptapEditorPromise({
      docName: h.docName,
      mountId: 'test-id',
      construct: h.construct,
    });
    await first.catch(() => {});

    const second = mountTiptapEditorPromise({
      docName: h.docName,
      mountId: 'test-id',
      construct: h.construct,
    });
    expect(second).toBe(first);
    await expect(second).rejects.toThrow('synthetic mount failure');
    expect(h.constructCallCount).toBe(1);
    expect(h.spies.mountCalls).toBe(1);
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
    await first.catch(() => {});

    invalidateMountPromise(h.docName);
    expect(__mountPromiseCacheSize()).toBe(0);

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
    expect(__getCacheSize('tiptap')).toBe(0);
    const marks = getCollector()?.marks.toArray() ?? [];
    const rejectMark = marks.find((m) => m.name === 'ok/mount/reject');
    expect(rejectMark?.properties?.reason).toBe('construct-failed');
    expect(rejectMark?.properties?.message).toContain('synthetic construct failure');
  });

  test('destroy() throws after mount() throws → promise still rejects with original mount error', async () => {
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
    const h = makeHarness('doc-destroy-throws-on-abort');
    h.spies.destroyThrows = true;

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
      if (stallResolve) (stallResolve as () => void)();
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(h.spies.destroyCalls).toBe(1);
    } finally {
      scheduler.yield = origYield;
    }
  });
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
    const h = makeHarness('doc-fresh-after-invalidate');
    const first = mountTiptapEditorPromise({
      docName: h.docName,
      mountId: 'test-id',
      construct: h.construct,
    });
    const firstEntry = await first;
    expect(firstEntry.editor).toBe(h.editor);

    invalidateMountPromise(h.docName);
    __resetCacheForTests(); // Clear V2 cache too — models eviction

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
});

describe('stalled-but-pending observability (D27 LOCKED, precedent 41)', () => {
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
      promise.catch(() => {});
      await new Promise<void>((resolve) => setTimeout(resolve, 80));
      expect(__mountPromiseStalledEmitted(h.docName)).toBe(true);
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
      promise.catch(() => {});
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
      await new Promise<void>((resolve) => setTimeout(resolve, 200));
      __reapStalledOnVisible(Date.now() + 60_000);
      const collector = getCollector();
      if (collector) {
        const timeoutRejects = collector.marks
          .toArray()
          .filter((m) => m.name === 'ok/mount/reject' && m.properties?.reason === 'timeout');
        expect(timeoutRejects).toEqual([]);
      }
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
  test('every ok/mount/* mark carries the mountId from the call', async () => {
    const h = makeHarness('mountid-payload');
    const collector = getCollector();
    if (!collector) {
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
      expect(m.properties?.mountId).toBe('specific-mount-id-7');
    }
  });
});

describe('getMountAbortController (FW13 explicit-cancel surface)', () => {
  test('returns null when no entry exists', () => {
    expect(getMountAbortController('never-registered')).toBeNull();
  });

  test('returns the entry controller; .abort() in the pre-construct yield window rejects with MountAbortError, construct skipped', async () => {
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
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(h.constructCallCount).toBe(0);
    expect(h.spies.mountCalls).toBe(0);
    expect(h.spies.destroyCalls).toBe(0);
  });

  test('explicit abort during the post-construct scheduler.yield window: rejects with MountAbortError, destroys pre-mount editor exactly once, mount() never called', async () => {
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
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(h.constructCallCount).toBe(1);

      const controller = getMountAbortController(h.docName);
      expect(controller).not.toBeNull();
      controller?.abort();

      await expect(promise).rejects.toMatchObject({
        name: 'MountAbortError',
        docName: h.docName,
      });
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
  test('returns false when no entry exists', () => {
    expect(mountPromiseHasResolved('never-mounted')).toBe(false);
  });

  test('returns false while a mount is pending (constructed but not yet awaited)', () => {
    const h = makeHarness('pending-doc');
    const promise = mountTiptapEditorPromise({
      docName: h.docName,
      mountId: 'test-id',
      construct: h.construct,
    });
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
      expect(calls.count).toBe(2);
      expect(h.constructCallCount).toBe(1);
      expect(h.spies.mountCalls).toBe(1);
      expect(entry.editor).toBe(h.editor);
    });
  });

  test('V2 cache HIT short-circuit does NOT invoke scheduler.yield', async () => {
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
      expect(calls.count).toBe(0);
      expect(h.constructCallCount).toBe(0);
      expect(h.spies.mountCalls).toBe(0);
    });
  });

  test('construct() failure rejects after the pre-construct yield-point — the post-construct yield is skipped', async () => {
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
  test('pre-construct scheduler.yield throwing → consumer promise rejects, construct skipped, no editor leak', async () => {
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
      expect(h.spies.destroyCalls).toBe(1);
    } finally {
      scheduler.yield = original;
    }
  });

  test('V2 HIT path throwing → consumer promise rejects (does not hang)', async () => {
    const h = makeHarness('doc-hit-throws');

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

    const promise = mountTiptapEditorPromise({
      docName: h.docName,
      mountId: 'test-id',
      construct: h.construct,
    });
    await expect(promise).rejects.toBeDefined();
  });

  test('invalidate followed by V2 HIT path throwing → backstop emits post-settle-throw mark; consumer promise stays orphaned (silent-teardown contract)', async () => {
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
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(consumerRejected).toBe(false);
    const marks = getCollector()?.marks.toArray() ?? [];
    const postSettleMark = marks.find((m) => m.name === 'ok/mount/post-settle-throw');
    expect(postSettleMark).toBeDefined();
  });

  test('post-settle escape: body throw after invalidate emits ok/mount/post-settle-throw mark', async () => {
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
    promise.catch(() => {});
    invalidateMountPromise(h.docName);
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
  beforeEach(() => {
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
    const h = makeHarness('invalidate-finalizes');
    emitColdMountChild(
      'invalidate-finalizes-mid',
      'ok.provider-pool.open',
      {},
      Date.now(),
      Date.now() + 1,
    );
    expect(__coldMountSpanCount()).toBe(1);

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
