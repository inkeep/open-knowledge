import { context, metrics, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  type ReadableSpan,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { __resetIndexTelemetryForTests, instrumentIndexRebuild } from './index-telemetry.ts';

let exporter: InMemorySpanExporter;
let provider: BasicTracerProvider;

beforeEach(() => {
  exporter = new InMemorySpanExporter();
  provider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  trace.setGlobalTracerProvider(provider);
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  __resetIndexTelemetryForTests();
});

afterEach(async () => {
  await provider.shutdown();
  trace.disable();
  metrics.disable();
  context.disable();
  __resetIndexTelemetryForTests();
});

function requireSpan(name: string): ReadableSpan {
  const spans = exporter.getFinishedSpans().filter((s) => s.name === name);
  const head = spans[0];
  if (!head) throw new Error(`requireSpan: no span named '${name}'`);
  return head;
}

describe('instrumentIndexRebuild', () => {
  test('emits ok.index.rebuild with bounded name/mode attributes', async () => {
    const result = await instrumentIndexRebuild('tag', 'full', async () => 'done');
    expect(result).toBe('done');
    const span = requireSpan('ok.index.rebuild');
    expect(span.attributes['index.name']).toBe('tag');
    expect(span.attributes['index.mode']).toBe('full');
  });

  test('maps the result onto span attributes via resultAttrs', async () => {
    await instrumentIndexRebuild(
      'backlink',
      'reconcile',
      async () => ({ added: 3, updated: 1, deleted: 2 }),
      (diff) => ({
        'index.added': diff.added,
        'index.updated': diff.updated,
        'index.deleted': diff.deleted,
      }),
    );
    const span = requireSpan('ok.index.rebuild');
    expect(span.attributes['index.name']).toBe('backlink');
    expect(span.attributes['index.mode']).toBe('reconcile');
    expect(span.attributes['index.added']).toBe(3);
    expect(span.attributes['index.updated']).toBe(1);
    expect(span.attributes['index.deleted']).toBe(2);
  });

  test('propagates the rebuild error and still ends the span', async () => {
    await expect(
      instrumentIndexRebuild('tag', 'full', async () => {
        throw new Error('walk failed');
      }),
    ).rejects.toThrow('walk failed');
    const span = requireSpan('ok.index.rebuild');
    expect(span.status.code).not.toBe(0); // ERROR, not UNSET
  });

  test('metric record path is no-throw under the default (disabled) meter', async () => {
    // metrics.disable() in afterEach leaves the no-op global meter; the
    // counter + histogram must never be able to break a rebuild.
    await expect(instrumentIndexRebuild('tag', 'reconcile', async () => 1)).resolves.toBe(1);
  });
});
