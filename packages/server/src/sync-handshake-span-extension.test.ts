/**
 * Tests for the server-side `sync.handshake` span extension.
 *
 * The extension fills a documented OTel coverage gap — before this, server-
 * factory.ts had zero withSpan calls of its own. The span is emitted at
 * afterLoadDocument time with {doc.name, mountId} attributes so per-cycle
 * Tempo queries can attribute
 * server-side handshake latency to a specific mountId.
 *
 * Production wiring uses the OTLP exporter via `initTelemetry` in
 * telemetry.ts. These assertions use InMemorySpanExporter purely as a
 * unit-test capture surface, mirroring the observer-bridge-spans.test.ts
 * pattern.
 *
 * Skips system / config docs — those bypass the markdown bridge entirely.
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

/**
 * Synthetic afterLoadDocument payload — minimum surface the extension reads.
 * Hocuspocus passes more, but the extension only needs `documentName`,
 * `document`, and `requestParameters`. Cast through unknown so the test stays
 * decoupled from upstream payload schema changes that don't affect the
 * extension's contract.
 */
// biome-ignore lint/suspicious/noExplicitAny: structural test payload
type AfterLoadPayload = any;

function makePayload(opts: { documentName: string; mountId?: string }): AfterLoadPayload {
  const params = new URLSearchParams();
  if (opts.mountId !== undefined) params.set('mountId', opts.mountId);
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

// Real UUID v4 values — match what `crypto.randomUUID()` emits and what
// the new MOUNT_ID_PATTERN admits. Hardcoded so tests are deterministic.
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
    // Cardinality guard — a free-form string from a client
    // would otherwise inflate Tempo's attribute index. The handshake
    // still completes; only the malformed attribute is omitted.
    const extension = createSyncHandshakeSpanExtension();
    await extension.afterLoadDocument?.(
      makePayload({ documentName: 'README', mountId: 'not-a-uuid' }),
    );
    const spans = spansByName('sync.handshake');
    expect(spans.length).toBe(1);
    expect(spans[0]?.attributes['doc.name']).toBe('README');
    expect(spans[0]?.attributes['mount.id']).toBeUndefined();
  });

  // Parameterized regex-shape tests — pin each invariant of the
  // MOUNT_ID_PATTERN contract so a future weakening (drop the version
  // nibble, drop the variant nibble, drop the /i flag) surfaces here.
  const NEGATIVE_UUID_CASES: ReadonlyArray<{ label: string; value: string }> = [
    { label: 'empty string', value: '' },
    // UUID v1 — version nibble is `1` (third group), should fail the `4`-pinned regex.
    { label: 'UUID v1 (wrong version nibble)', value: '11111111-2222-1333-8444-555555555555' },
    // Variant nibble `c` is outside [89ab] — should fail.
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
    // Some platforms emit uppercase hex. The regex carries `/i` for
    // exactly this case; dropping the flag would silently reject these.
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

describe('sync.handshake span — OTel SDK fault isolation', () => {
  test('OTel emission throw does not propagate out of afterLoadDocument', async () => {
    // The OTel API contract says start/end must not throw, but an
    // opt-in SDK fault must not fail the sync handshake — Hocuspocus's
    // outer try/catch would otherwise close the WebSocket with
    // ResetConnection. Simulate by wiring a tracer-provider whose
    // startActiveSpan throws.
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
    // Asserts no throw — the extension must swallow the SDK fault.
    await extension.afterLoadDocument?.(makePayload({ documentName: 'README', mountId: UUID_A }));
    // Re-setup so afterEach's teardown still runs cleanly.
    trace.disable();
    setupExporter();
  });
});
