import { context, metrics, propagation, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  type ReadableSpan,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import * as Y from 'yjs';
import { createSyncHandshakeSpanExtension } from './sync-handshake-span-extension.ts';

let exporter: InMemorySpanExporter;
let provider: BasicTracerProvider;

function setupExporter(): void {
  exporter = new InMemorySpanExporter();
  provider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  trace.setGlobalTracerProvider(provider);
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  propagation.setGlobalPropagator(new W3CTraceContextPropagator());
}

async function teardownExporter(): Promise<void> {
  await provider.shutdown();
  trace.disable();
  metrics.disable();
  context.disable();
  propagation.disable();
}

function spansByName(name: string): ReadableSpan[] {
  return exporter.getFinishedSpans().filter((s) => s.name === name);
}

// biome-ignore lint/suspicious/noExplicitAny: structural test payload
type AfterLoadPayload = any;

function makePayload(opts: {
  documentName: string;
  mountId?: string;
  traceparent?: string;
  tracestate?: string;
}): AfterLoadPayload {
  const params = new URLSearchParams();
  if (opts.mountId !== undefined) params.set('mountId', opts.mountId);
  if (opts.traceparent !== undefined) params.set('traceparent', opts.traceparent);
  if (opts.tracestate !== undefined) params.set('tracestate', opts.tracestate);
  return {
    documentName: opts.documentName,
    document: new Y.Doc(),
    requestParameters: params,
  };
}

beforeEach(() => {
  setupExporter();
});

afterEach(async () => {
  await teardownExporter();
});

const UUID_A = '11111111-2222-4333-8444-555555555555';
const UUID_B = '66666666-7777-4888-9999-aaaaaaaaaaaa';
const UUID_C = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff';

describe('sync.handshake span — basic emission', () => {
  test('emits a sync.handshake span with doc.name + mountId on afterLoadDocument', async () => {
    const extension = createSyncHandshakeSpanExtension();
    await extension.afterLoadDocument?.(makePayload({ documentName: 'README', mountId: UUID_A }));
    const spans = spansByName('sync.handshake');
    expect(spans.length).toBe(1);
    const span = spans[0];
    expect(span?.attributes['doc.name']).toBe('README');
    expect(span?.attributes['mount.id']).toBe(UUID_A);
  });

  test('emits the span with mountId omitted when requestParameters lack a mountId', async () => {
    const extension = createSyncHandshakeSpanExtension();
    await extension.afterLoadDocument?.(makePayload({ documentName: 'README' }));
    const spans = spansByName('sync.handshake');
    expect(spans.length).toBe(1);
    expect(spans[0]?.attributes['doc.name']).toBe('README');
    expect(spans[0]?.attributes['mount.id']).toBeUndefined();
  });

  test('drops mountId attribute when value does not match the UUID v4 shape', async () => {
    const extension = createSyncHandshakeSpanExtension();
    await extension.afterLoadDocument?.(
      makePayload({ documentName: 'README', mountId: 'not-a-uuid' }),
    );
    const spans = spansByName('sync.handshake');
    expect(spans.length).toBe(1);
    expect(spans[0]?.attributes['doc.name']).toBe('README');
    expect(spans[0]?.attributes['mount.id']).toBeUndefined();
  });

  const NEGATIVE_UUID_CASES: ReadonlyArray<{ label: string; value: string }> = [
    { label: 'empty string', value: '' },
    { label: 'UUID v1 (wrong version nibble)', value: '11111111-2222-1333-8444-555555555555' },
    { label: 'wrong variant nibble (c)', value: '11111111-2222-4333-c444-555555555555' },
  ];
  for (const { label, value } of NEGATIVE_UUID_CASES) {
    test(`drops mountId attribute when value is malformed: ${label}`, async () => {
      const extension = createSyncHandshakeSpanExtension();
      await extension.afterLoadDocument?.(makePayload({ documentName: 'README', mountId: value }));
      const spans = spansByName('sync.handshake');
      expect(spans.length).toBe(1);
      expect(spans[0]?.attributes['mount.id']).toBeUndefined();
    });
  }

  test('accepts uppercase UUID (pins the regex /i case-insensitive flag)', async () => {
    const extension = createSyncHandshakeSpanExtension();
    const uppercaseUuid = UUID_A.toUpperCase();
    await extension.afterLoadDocument?.(
      makePayload({ documentName: 'README', mountId: uppercaseUuid }),
    );
    const spans = spansByName('sync.handshake');
    expect(spans.length).toBe(1);
    expect(spans[0]?.attributes['mount.id']).toBe(uppercaseUuid);
  });

  test('skips system docs (__system__)', async () => {
    const extension = createSyncHandshakeSpanExtension();
    await extension.afterLoadDocument?.(
      makePayload({ documentName: '__system__', mountId: UUID_C }),
    );
    expect(spansByName('sync.handshake').length).toBe(0);
  });

  test('skips config docs (__config__/project)', async () => {
    const extension = createSyncHandshakeSpanExtension();
    await extension.afterLoadDocument?.(
      makePayload({ documentName: '__config__/project', mountId: UUID_C }),
    );
    expect(spansByName('sync.handshake').length).toBe(0);
  });

  test('emits a distinct span per afterLoadDocument call (per-cycle correlation)', async () => {
    const extension = createSyncHandshakeSpanExtension();
    await extension.afterLoadDocument?.(makePayload({ documentName: 'A', mountId: UUID_A }));
    await extension.afterLoadDocument?.(makePayload({ documentName: 'B', mountId: UUID_B }));
    const spans = spansByName('sync.handshake');
    expect(spans.length).toBe(2);
    const mountIds = spans.map((s) => s.attributes['mount.id']).sort();
    expect(mountIds).toEqual([UUID_A, UUID_B].sort());
  });
});

describe('sync.handshake span — WS traceparent extraction', () => {
  const TRACE_ID = '0af7651916cd43dd8448eb211c80319c';
  const PARENT_SPAN_ID = 'b7ad6b7169203331';
  const TRACEPARENT = `00-${TRACE_ID}-${PARENT_SPAN_ID}-01`;

  test('parents the span to the browser trace when traceparent is present', async () => {
    const extension = createSyncHandshakeSpanExtension();
    await extension.afterLoadDocument?.(
      makePayload({ documentName: 'README', mountId: UUID_A, traceparent: TRACEPARENT }),
    );
    const spans = spansByName('sync.handshake');
    expect(spans.length).toBe(1);
    const span = spans[0];
    expect(span?.spanContext().traceId).toBe(TRACE_ID);
    expect(span?.parentSpanContext?.spanId).toBe(PARENT_SPAN_ID);
  });

  test('carries tracestate through extraction alongside traceparent', async () => {
    const extension = createSyncHandshakeSpanExtension();
    await extension.afterLoadDocument?.(
      makePayload({
        documentName: 'README',
        traceparent: TRACEPARENT,
        tracestate: 'vendor=value',
      }),
    );
    const spans = spansByName('sync.handshake');
    expect(spans.length).toBe(1);
    expect(spans[0]?.spanContext().traceId).toBe(TRACE_ID);
  });

  test('starts a root span when no traceparent is supplied', async () => {
    const extension = createSyncHandshakeSpanExtension();
    await extension.afterLoadDocument?.(makePayload({ documentName: 'README' }));
    const spans = spansByName('sync.handshake');
    expect(spans.length).toBe(1);
    expect(spans[0]?.parentSpanContext).toBeUndefined();
    expect(spans[0]?.spanContext().traceId).not.toBe(TRACE_ID);
  });

  test('falls back to a root span on a malformed traceparent without throwing', async () => {
    const extension = createSyncHandshakeSpanExtension();
    await extension.afterLoadDocument?.(
      makePayload({ documentName: 'README', traceparent: 'garbage-not-a-traceparent' }),
    );
    const spans = spansByName('sync.handshake');
    expect(spans.length).toBe(1);
    expect(spans[0]?.parentSpanContext).toBeUndefined();
  });
});

describe('sync.handshake span — OTel SDK fault isolation', () => {
  test('OTel emission throw does not propagate out of afterLoadDocument', async () => {
    await teardownExporter();
    const faultyProvider = {
      getTracer() {
        return {
          startActiveSpan: () => {
            throw new Error('synthetic OTel fault');
          },
        };
      },
      // biome-ignore lint/suspicious/noExplicitAny: structural test shim
    } as any;
    trace.setGlobalTracerProvider(faultyProvider);

    const extension = createSyncHandshakeSpanExtension();
    await extension.afterLoadDocument?.(makePayload({ documentName: 'README', mountId: UUID_A }));
    trace.disable();
    setupExporter();
  });
});
