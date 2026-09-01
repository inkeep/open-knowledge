import { context, metrics, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  type ReadableSpan,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
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
    expect(child?.parentSpanContext?.spanId).toBe(root?.spanContext().spanId);
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
    finalizeColdMountSpan('mid-idem');
    finalizeColdMountSpan('mid-idem');
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

    emitColdMountChild('mid-late', 'ok.mount-promise', {}, start + 5, start + 30);

    const roots = spansByName('ok.cold-mount');
    expect(roots.length).toBe(1);
    const lateChild = spansByName('ok.mount-promise')[0];
    expect(lateChild).toBeDefined();
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
  test('helpers complete without throwing under the no-op tracer', async () => {
    await teardownExporter();
    trace.disable();
    expect(() => {
      ensureColdMountSpan('mid-noop', {}, Date.now());
      emitColdMountChild('mid-noop', 'ok.sync-promise', {}, Date.now(), Date.now() + 1);
      finalizeColdMountSpan('mid-noop');
    }).not.toThrow();
    setupExporter();
  });
});

describe('finalizedMountIds set boundary — FIFO eviction at the 1024-entry cap', () => {
  test('FIFO-evicts the oldest mountId once the set fills, restoring late-create for it', () => {
    const FINALIZED_SET_CAP = 1024;
    const start = Date.now();

    for (let i = 0; i < FINALIZED_SET_CAP; i += 1) {
      finalizeColdMountSpan(`mid-cap-${i}`, start + i);
    }
    expect(__coldMountSpanCount()).toBe(0);

    emitColdMountChild('mid-cap-0', 'ok.mount-promise', {}, start + 2000, start + 2010);
    expect(__coldMountSpanCount()).toBe(0);

    finalizeColdMountSpan('mid-cap-overflow', start + 3000);

    emitColdMountChild('mid-cap-0', 'ok.sync-promise', {}, start + 4000, start + 4010);
    expect(__coldMountSpanCount()).toBe(1);

    emitColdMountChild('mid-cap-overflow', 'ok.mount-promise', {}, start + 5000, start + 5010);
    expect(__coldMountSpanCount()).toBe(1);

    finalizeColdMountSpan('mid-cap-0', start + 6000);
    expect(__coldMountSpanCount()).toBe(0);
  });

  test('double-finalize for the same mountId at cap does not evict a neighbor', () => {
    const FINALIZED_SET_CAP = 1024;
    const start = Date.now();

    for (let i = 0; i < FINALIZED_SET_CAP; i += 1) {
      finalizeColdMountSpan(`mid-double-${i}`, start + i);
    }

    emitColdMountChild('mid-double-0', 'ok.mount-promise', {}, start + 2000, start + 2010);
    expect(__coldMountSpanCount()).toBe(0);

    const lastMountId = `mid-double-${FINALIZED_SET_CAP - 1}`;
    finalizeColdMountSpan(lastMountId, start + 3000);

    emitColdMountChild('mid-double-0', 'ok.sync-promise', {}, start + 4000, start + 4010);
    expect(__coldMountSpanCount()).toBe(0);
  });
});

describe('OTel SDK fault isolation — emitColdMountChild and finalizeColdMountSpan', () => {
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

    expect(() => {
      emitColdMountChild('mid-fault-emit', 'ok.sync-promise', {}, Date.now(), Date.now() + 1);
    }).not.toThrow();

    trace.disable();
    setupExporter();
  });

  test('eviction path swallows synthetic span.end throw on the evicted entry', () => {
    const start = Date.now();
    const targetEntry = ensureColdMountSpan('mid-evict-victim', {}, start);
    expect(targetEntry).not.toBeNull();
    if (!targetEntry) return;
    // biome-ignore lint/suspicious/noExplicitAny: structural test shim
    (targetEntry.span as any).end = () => {
      throw new Error('synthetic OTel eviction span.end fault');
    };
    const FINALIZED_SET_CAP = 1024;
    for (let i = 0; i < FINALIZED_SET_CAP; i += 1) {
      ensureColdMountSpan(`mid-fill-${i}`, {}, start + i);
    }
    expect(() => {
      ensureColdMountSpan('mid-overflow-trigger', {}, start + 99_999);
    }).not.toThrow();
    expect(__coldMountSpanCount()).toBe(FINALIZED_SET_CAP);
  });

  test('finalizeColdMountSpan swallows synthetic span.end throw via injected entry', () => {
    const entry = ensureColdMountSpan('mid-fault-end', {}, Date.now());
    expect(entry).not.toBeNull();
    if (!entry) return;
    // biome-ignore lint/suspicious/noExplicitAny: structural test shim
    (entry.span as any).end = () => {
      throw new Error('synthetic OTel span.end fault');
    };
    expect(() => {
      finalizeColdMountSpan('mid-fault-end', Date.now());
    }).not.toThrow();
    expect(__coldMountSpanCount()).toBe(0);
  });
});
