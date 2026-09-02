import { context, metrics, propagation, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { beginBugReportSendSpan } from './bug-report-send-otel';

let exporter: InMemorySpanExporter;
let provider: BasicTracerProvider;

function parseTraceparent(header: string | undefined) {
  expect(header).toBeDefined();
  const parts = (header as string).split('-');
  expect(parts).toHaveLength(4);
  return { traceId: parts[1], spanId: parts[2] };
}

beforeEach(() => {
  exporter = new InMemorySpanExporter();
  provider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  trace.setGlobalTracerProvider(provider);
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  propagation.setGlobalPropagator(new W3CTraceContextPropagator());
});

afterEach(async () => {
  await provider.shutdown();
  trace.disable();
  context.disable();
  propagation.disable();
  metrics.disable();
});

describe('renderer bug-report send span', () => {
  test('a send records its outcome and exports one span', () => {
    const span = beginBugReportSendSpan({ 'ok.bug_report.zip_bytes': 1234 });
    span.end('sent', { 'ok.bug_report.request_seq': 1 });

    const finished = exporter.getFinishedSpans();
    expect(finished).toHaveLength(1);
    expect(finished[0].name).toBe('ok.bug-report.send.attempt');
    expect(finished[0].attributes['ok.bug_report.renderer_outcome']).toBe('sent');
    expect(finished[0].attributes['ok.bug_report.zip_bytes']).toBe(1234);
    expect(finished[0].attributes['ok.bug_report.request_seq']).toBe(1);
  });

  test('concurrent sends inject traceparents that name their own spans', () => {
    const a = beginBugReportSendSpan();
    const b = beginBugReportSendSpan();

    const headerA = parseTraceparent(a.traceparent());
    const headerB = parseTraceparent(b.traceparent());

    expect(headerA.spanId).not.toBe(headerB.spanId);
    expect(headerA.traceId).not.toBe(headerB.traceId);

    a.end('sent');
    b.end('failed');

    const finished = exporter.getFinishedSpans();
    const byOutcome = new Map(
      finished.map((s) => [s.attributes['ok.bug_report.renderer_outcome'], s]),
    );
    expect(byOutcome.get('sent')?.spanContext().spanId).toBe(headerA.spanId);
    expect(byOutcome.get('failed')?.spanContext().spanId).toBe(headerB.spanId);
  });

  test('the traceparent is stable across reads for one operation', () => {
    const span = beginBugReportSendSpan();
    expect(span.traceparent()).toBe(span.traceparent());
    span.end('joined');
  });

  test('a joined duplicate is recorded, since main never sees it', () => {
    const span = beginBugReportSendSpan();
    span.end('joined');
    expect(exporter.getFinishedSpans()[0].attributes['ok.bug_report.renderer_outcome']).toBe(
      'joined',
    );
  });

  test('end is idempotent', () => {
    const span = beginBugReportSendSpan();
    span.end('sent');
    span.end('failed');
    const finished = exporter.getFinishedSpans();
    expect(finished).toHaveLength(1);
    expect(finished[0].attributes['ok.bug_report.renderer_outcome']).toBe('sent');
  });
});
