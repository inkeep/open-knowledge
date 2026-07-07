/**
 * Tests for the frontend OTel span helper module.
 *
 * Verifies the 4-span tree shape (root cold-mount + 3 descendants per
 * mountId), the lazy-creation pattern (first child triggers root
 * creation), and finalize idempotency (first call ends the root,
 * subsequent calls are no-ops).
 *
 * Uses InMemorySpanExporter purely for assertions — production wiring
 * runs via the lazy-loaded sdk-trace-web in telemetry-impl.ts.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { context, metrics, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  type ReadableSpan,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import {
  __coldMountSpanCount,
  __resetColdMountSpans,
  emitColdMountChild,
  ensureColdMountSpan,
  finalizeColdMountSpan,
} from './otel-spans';

let exporter: InMemorySpanExporter;
let provider: BasicTracerProvider;

function setupExporter(): void {
  exporter = new InMemorySpanExporter();
  provider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  trace.setGlobalTracerProvider(provider);
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
}

async function teardownExporter(): Promise<void> {
  await provider.shutdown();
  trace.disable();
  metrics.disable();
  context.disable();
}

function spansByName(name: string): ReadableSpan[] {
  return exporter.getFinishedSpans().filter((s) => s.name === name);
}

beforeEach(() => {
  setupExporter();
});

afterEach(async () => {
  __resetColdMountSpans();
  await teardownExporter();
});

describe('ensureColdMountSpan', () => {
  test('creates a cold-mount span on first call', () => {
    ensureColdMountSpan('mid-1', { 'doc.name': 'A' }, Date.now());
    expect(__coldMountSpanCount()).toBe(1);
  });

  test('idempotent on the same mountId — does not create a second span', () => {
    const first = ensureColdMountSpan('mid-2', {}, Date.now());
    const second = ensureColdMountSpan('mid-2', {}, Date.now() + 1000);
    expect(first).toBe(second);
    expect(__coldMountSpanCount()).toBe(1);
  });

  test('distinct mountIds get distinct spans', () => {
    ensureColdMountSpan('mid-a', {}, Date.now());
    ensureColdMountSpan('mid-b', {}, Date.now());
    expect(__coldMountSpanCount()).toBe(2);
  });
});

describe('emitColdMountChild', () => {
  test('lazily creates the cold-mount root on first child emission', () => {
    const start = Date.now();
    emitColdMountChild('mid-lazy', 'ok.provider-pool.open', {}, start, start + 5);
    expect(__coldMountSpanCount()).toBe(1);
  });

  test('emits the child span with the cold-mount root as parent', () => {
    const start = Date.now();
    emitColdMountChild('mid-tree', 'ok.provider-pool.open', { 'doc.name': 'X' }, start, start + 5);
    finalizeColdMountSpan('mid-tree', start + 10);

    const childSpans = spansByName('ok.provider-pool.open');
    const rootSpans = spansByName('ok.cold-mount');
    expect(childSpans.length).toBe(1);
    expect(rootSpans.length).toBe(1);

    const child = childSpans[0];
    const root = rootSpans[0];
    expect(child?.attributes['mount.id']).toBe('mid-tree');
    expect(root?.attributes['mount.id']).toBe('mid-tree');
    // parent_span_id link — Tempo renders the tree using this field.
    expect(child?.parentSpanContext?.spanId).toBe(root?.spanContext().spanId);
    // Both spans share the same trace.
    expect(child?.spanContext().traceId).toBe(root?.spanContext().traceId);
  });

  test('all three child spans descend from one cold-mount root', () => {
    const start = Date.now();
    emitColdMountChild('mid-3', 'ok.provider-pool.open', {}, start, start + 5);
    emitColdMountChild('mid-3', 'ok.mount-promise', {}, start + 2, start + 20);
    emitColdMountChild('mid-3', 'ok.sync-promise', {}, start + 2, start + 40);
    finalizeColdMountSpan('mid-3', start + 40);

    const root = spansByName('ok.cold-mount')[0];
    const children = ['ok.provider-pool.open', 'ok.mount-promise', 'ok.sync-promise'].map(
      (n) => spansByName(n)[0],
    );
    expect(root).toBeDefined();
    for (const child of children) {
      expect(child).toBeDefined();
      expect(child?.parentSpanContext?.spanId).toBe(root?.spanContext().spanId);
      expect(child?.spanContext().traceId).toBe(root?.spanContext().traceId);
      expect(child?.attributes['mount.id']).toBe('mid-3');
    }
  });

  test('child span attributes flow through alongside mountId', () => {
    const start = Date.now();
    emitColdMountChild(
      'mid-attrs',
      'ok.sync-promise',
      { 'doc.name': 'Q', elapsed_ms: 42 },
      start,
      start + 42,
    );
    finalizeColdMountSpan('mid-attrs');
    const span = spansByName('ok.sync-promise')[0];
    expect(span?.attributes['doc.name']).toBe('Q');
    expect(span?.attributes.elapsed_ms).toBe(42);
    expect(span?.attributes['mount.id']).toBe('mid-attrs');
  });

  test('first child seeds the lazy-created root with its own attributes (doc.name propagates)', () => {
    // Without attribute propagation, the root carries only `mount.id` and
    // Tempo's search UI shows a bare root. Passing the first child's
    // attributes to the root makes the trace tree's top-level row carry
    // useful context (e.g. `doc.name`) for filtering and debugging.
    const start = Date.now();
    emitColdMountChild(
      'mid-root-attr',
      'ok.provider-pool.open',
      { 'doc.name': 'README' },
      start,
      start + 5,
    );
    finalizeColdMountSpan('mid-root-attr', start + 10);
    const root = spansByName('ok.cold-mount')[0];
    expect(root?.attributes['mount.id']).toBe('mid-root-attr');
    expect(root?.attributes['doc.name']).toBe('README');
  });

  test('second child does NOT overwrite the root attributes (idempotent on existing root)', () => {
    // First child seeds the root with `doc.name = "first"`. A subsequent
    // child carrying `doc.name = "second"` must not mutate the root — the
    // root's identity is established at first emission, not amended.
    const start = Date.now();
    emitColdMountChild(
      'mid-stable-root',
      'ok.provider-pool.open',
      { 'doc.name': 'first', elapsed_ms: 1 },
      start,
      start + 5,
    );
    emitColdMountChild(
      'mid-stable-root',
      'ok.mount-promise',
      { 'doc.name': 'second', elapsed_ms: 99 },
      start + 6,
      start + 20,
    );
    finalizeColdMountSpan('mid-stable-root', start + 30);
    const root = spansByName('ok.cold-mount')[0];
    expect(root?.attributes['doc.name']).toBe('first');
    // The root's elapsed_ms must reflect the first child's seed value.
    expect(root?.attributes.elapsed_ms).toBe(1);
  });
});

describe('finalizeColdMountSpan', () => {
  test('first call ends the root and removes the registry entry', () => {
    const start = Date.now();
    emitColdMountChild('mid-fin', 'ok.sync-promise', {}, start, start + 5);
    expect(__coldMountSpanCount()).toBe(1);
    finalizeColdMountSpan('mid-fin');
    expect(__coldMountSpanCount()).toBe(0);
    expect(spansByName('ok.cold-mount').length).toBe(1);
  });

  test('subsequent calls are no-ops (idempotent finalize)', () => {
    const start = Date.now();
    emitColdMountChild('mid-idem', 'ok.sync-promise', {}, start, start + 5);
    finalizeColdMountSpan('mid-idem');
    finalizeColdMountSpan('mid-idem'); // second call — no-op
    finalizeColdMountSpan('mid-idem'); // third call — no-op
    expect(spansByName('ok.cold-mount').length).toBe(1);
  });

  test('finalizing an unknown mountId is a no-op (does not throw)', () => {
    expect(() => finalizeColdMountSpan('no-such-mountid')).not.toThrow();
    expect(spansByName('ok.cold-mount').length).toBe(0);
  });
});

describe('late children after finalize', () => {
  test('a child emitted after finalize does NOT lazy-create a second cold-mount root', () => {
    const start = Date.now();
    emitColdMountChild('mid-late', 'ok.sync-promise', {}, start, start + 10);
    finalizeColdMountSpan('mid-late', start + 10);
    expect(__coldMountSpanCount()).toBe(0);

    // Mount-promise resolving 20 ms later — emit STILL needs to land for
    // the sweep's mountId-keyed Tempo join, but it must NOT re-open a
    // second cold-mount root (Tempo would otherwise render two roots for
    // one cycle).
    emitColdMountChild('mid-late', 'ok.mount-promise', {}, start + 5, start + 30);

    const roots = spansByName('ok.cold-mount');
    expect(roots.length).toBe(1);
    const lateChild = spansByName('ok.mount-promise')[0];
    expect(lateChild).toBeDefined();
    // Late child is parent-less but still attribute-tagged with mountId
    // — the sweep's filter by mountId still finds it. Parent-span context
    // is absent (no root open at emit time).
    expect(lateChild?.attributes['mount.id']).toBe('mid-late');
  });

  test('finalize is idempotent even with no prior children', () => {
    expect(() => {
      finalizeColdMountSpan('mid-pristine');
      finalizeColdMountSpan('mid-pristine');
    }).not.toThrow();
    expect(spansByName('ok.cold-mount').length).toBe(0);
  });
});

describe('no-op behavior when OTel SDK is not registered', () => {
  // When no SDK provider is registered, trace.getTracer() returns a no-op
  // tracer whose startSpan returns a no-op span. The helper module makes
  // no assumptions about which kind of tracer it gets — both code paths
  // share the same source, so the no-op case must not throw.
  test('helpers complete without throwing under the no-op tracer', async () => {
    await teardownExporter();
    trace.disable(); // ensure no provider is active
    expect(() => {
      ensureColdMountSpan('mid-noop', {}, Date.now());
      emitColdMountChild('mid-noop', 'ok.sync-promise', {}, Date.now(), Date.now() + 1);
      finalizeColdMountSpan('mid-noop');
    }).not.toThrow();
    // Re-setup so afterEach's teardown still runs cleanly.
    setupExporter();
  });
});

describe('finalizedMountIds set boundary — FIFO eviction at the 1024-entry cap', () => {
  // Pins the bounded-set behavior so a long-running tab cannot grow the
  // `finalizedMountIds` set unboundedly. Tests through the public-interface
  // outcome: after eviction, a late child for the evicted mountId IS
  // allowed to lazy-create a fresh cold-mount root again (suppression
  // dropped). Before eviction, the same emission must NOT lazy-create.
  test('FIFO-evicts the oldest mountId once the set fills, restoring late-create for it', () => {
    const FINALIZED_SET_CAP = 1024;
    const start = Date.now();

    // Step 1 — finalize FINALIZED_SET_CAP distinct mountIds. Each call
    // adds an entry; no eviction yet (size grows from 0 to CAP). Live
    // span count stays at 0 because finalize ends + removes the entry.
    for (let i = 0; i < FINALIZED_SET_CAP; i += 1) {
      finalizeColdMountSpan(`mid-cap-${i}`, start + i);
    }
    expect(__coldMountSpanCount()).toBe(0);

    // Step 2 — late child for the first-inserted mountId. Still in the
    // finalized set → ensureColdMountSpan returns null → child emits
    // without a root → live span count stays 0.
    emitColdMountChild('mid-cap-0', 'ok.mount-promise', {}, start + 2000, start + 2010);
    expect(__coldMountSpanCount()).toBe(0);

    // Step 3 — finalize ONE more distinct mountId. Size is at CAP, so
    // this triggers eviction of the oldest entry (`mid-cap-0`) BEFORE
    // adding the new mountId.
    finalizeColdMountSpan('mid-cap-overflow', start + 3000);

    // Step 4 — late child for `mid-cap-0`. Now evicted from the set →
    // suppression dropped → emitColdMountChild lazy-creates a fresh
    // cold-mount root for this mountId. Live span count becomes 1.
    emitColdMountChild('mid-cap-0', 'ok.sync-promise', {}, start + 4000, start + 4010);
    expect(__coldMountSpanCount()).toBe(1);

    // Step 5 — late child for the newly-added `mid-cap-overflow` is
    // still suppressed (most recent insertion, definitely still in the
    // set) → no new root is created, live count unchanged.
    emitColdMountChild('mid-cap-overflow', 'ok.mount-promise', {}, start + 5000, start + 5010);
    expect(__coldMountSpanCount()).toBe(1);

    // Cleanup — finalize the lazy-created root so the afterEach reset
    // doesn't have to chase it.
    finalizeColdMountSpan('mid-cap-0', start + 6000);
    expect(__coldMountSpanCount()).toBe(0);
  });

  test('double-finalize for the same mountId at cap does not evict a neighbor', () => {
    // Per-cycle invariant: both sync-promise and mount-promise call
    // finalizeColdMountSpan(mountId) per cold-mount cycle ("whichever
    // resolves last actually closes the root; the other becomes a
    // no-op"). Without an absence-guard on the eviction-and-add path,
    // the second call at cap evicts a different mountId before .add()
    // no-ops on the already-present id — halving the effective
    // suppression window.
    const FINALIZED_SET_CAP = 1024;
    const start = Date.now();

    // Fill the set to exactly CAP entries.
    for (let i = 0; i < FINALIZED_SET_CAP; i += 1) {
      finalizeColdMountSpan(`mid-double-${i}`, start + i);
    }

    // First-inserted mountId is still suppressed (set is full but no
    // eviction has happened yet).
    emitColdMountChild('mid-double-0', 'ok.mount-promise', {}, start + 2000, start + 2010);
    expect(__coldMountSpanCount()).toBe(0);

    // Double-finalize the LAST-inserted mountId (already in the set).
    // Without the absence-guard, this evicts `mid-double-0` and then
    // .add() no-ops. With the guard, it's a no-op on the set entirely.
    const lastMountId = `mid-double-${FINALIZED_SET_CAP - 1}`;
    finalizeColdMountSpan(lastMountId, start + 3000);

    // mid-double-0 must still be suppressed — proves no neighbor was
    // wrongly evicted. A late child for it must NOT lazy-create a
    // fresh root.
    emitColdMountChild('mid-double-0', 'ok.sync-promise', {}, start + 4000, start + 4010);
    expect(__coldMountSpanCount()).toBe(0);
  });
});

describe('OTel SDK fault isolation — emitColdMountChild and finalizeColdMountSpan', () => {
  // Mirror of the server-side sync-handshake-span-extension fault test.
  // The OTel API contract says startSpan/end must not throw, but an
  // opt-in SDK fault (BatchSpanProcessor flush-while-shutdown race,
  // misconfigured tracer-provider) would otherwise escape the helper
  // and propagate through synchronous EventEmitter listeners into the
  // WebSocket message-receive path. Caller-site reordering (resolve()
  // BEFORE OTel) protects React's `use(promise)` consumer; this wrap
  // protects the surrounding event-loop path.
  test('emitColdMountChild swallows synthetic startSpan throw', async () => {
    await teardownExporter();
    const faultyProvider = {
      getTracer() {
        return {
          startSpan: () => {
            throw new Error('synthetic OTel startSpan fault');
          },
        };
      },
      // biome-ignore lint/suspicious/noExplicitAny: structural test shim
    } as any;
    trace.setGlobalTracerProvider(faultyProvider);

    // Asserts no throw — the helper must swallow the SDK fault. A
    // future refactor that removes the try/catch wrap would surface
    // here as an uncaught throw.
    expect(() => {
      emitColdMountChild('mid-fault-emit', 'ok.sync-promise', {}, Date.now(), Date.now() + 1);
    }).not.toThrow();

    // Re-setup so afterEach's teardown still runs cleanly.
    trace.disable();
    setupExporter();
  });

  test('eviction path swallows synthetic span.end throw on the evicted entry', () => {
    // The FIFO eviction in ensureColdMountSpan calls span.end() on the
    // displaced entry. If the OTel SDK's span.end throws, the helper
    // must not propagate the throw out of the call site (ensureColdMountSpan
    // is exported; a future caller without its own try/catch would
    // otherwise inherit the gap). The Map entry must also be deleted
    // BEFORE the end call so a thrown end leaves the Map consistent.
    const start = Date.now();
    const targetEntry = ensureColdMountSpan('mid-evict-victim', {}, start);
    expect(targetEntry).not.toBeNull();
    if (!targetEntry) return;
    // biome-ignore lint/suspicious/noExplicitAny: structural test shim
    (targetEntry.span as any).end = () => {
      throw new Error('synthetic OTel eviction span.end fault');
    };
    // Saturate the Map past CAP. The first-inserted entry (mid-evict-victim)
    // is the eviction target. Use distinct mountIds so each call advances
    // the FIFO. Pre-cap the underlying cap to keep test runtime small —
    // we test the production cap by filling to its declared bound and
    // pushing one past, observing the eviction outcome.
    const FINALIZED_SET_CAP = 1024;
    for (let i = 0; i < FINALIZED_SET_CAP; i += 1) {
      ensureColdMountSpan(`mid-fill-${i}`, {}, start + i);
    }
    // One more insertion triggers eviction of mid-evict-victim. The
    // faulty span.end MUST NOT propagate; the Map MUST stay bounded at
    // exactly the cap (delete-before-end ensures the victim is gone
    // even on throw).
    expect(() => {
      ensureColdMountSpan('mid-overflow-trigger', {}, start + 99_999);
    }).not.toThrow();
    // The Map size is exactly the cap: 1024 fills + 1 victim evicted +
    // 1 overflow trigger added = 1024 (the cap holds).
    expect(__coldMountSpanCount()).toBe(FINALIZED_SET_CAP);
  });

  test('finalizeColdMountSpan swallows synthetic span.end throw via injected entry', () => {
    // The try/catch wrap at finalizeColdMountSpan's entry.span.end() call
    // is the production fault-isolation site — if the OTel SDK's span.end
    // throws (BatchSpanProcessor flush race, exporter fault), it must not
    // propagate out of the call site. The clean way to exercise this path
    // is via the public ensureColdMountSpan return value: it exposes the
    // ColdMountEntry whose `.span` we can override before the finalize
    // call. No internal exports needed — the entry surface is the test
    // injection point.
    const entry = ensureColdMountSpan('mid-fault-end', {}, Date.now());
    expect(entry).not.toBeNull();
    if (!entry) return; // narrow + fail-safe; the assert above covers
    // Override span.end on the captured entry. The cast is the only
    // structural concession — Span's interface declares `end` as
    // non-mutating, but the type system can't model "test-only mutation
    // of a structural-typed object's method." This mirrors the same
    // shape used by sync-handshake-span-extension.test.ts's faulty
    // tracer-provider test (also `as any` annotated).
    // biome-ignore lint/suspicious/noExplicitAny: structural test shim
    (entry.span as any).end = () => {
      throw new Error('synthetic OTel span.end fault');
    };
    expect(() => {
      finalizeColdMountSpan('mid-fault-end', Date.now());
    }).not.toThrow();
    // The Map entry is still cleaned up despite the throw — the
    // delete-from-Map step runs before .end(), so the try/catch
    // doesn't strand the entry.
    expect(__coldMountSpanCount()).toBe(0);
  });
});
