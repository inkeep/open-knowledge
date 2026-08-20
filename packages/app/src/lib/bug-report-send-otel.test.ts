/**
 * Tests for the renderer bug-report send span.
 *
 * Uses a real `BasicTracerProvider` + `InMemorySpanExporter` rather than the
 * `spyOn(trace, 'getTracer')` fake the sibling telemetry tests use. The claim
 * under test is that two concurrent sends inject *different* traceparents
 * carrying their own span ids, and a fake span has no real span context to
 * derive one from — only a live SDK plus the W3C propagator can prove it.
 *
 * The concurrency case is the reason this module holds a per-operation
 * `Context` instead of reading the active one. Several bug reports upload at
 * once by design, and if the header were injected from `context.active()` an
 * interleaved flow could hand one report's traceparent to another, silently
 * grafting main's transport span onto the wrong send.
 *
 * The span name and outcome key are deliberately distinct from main's
 * (`ok.bug-report.send` / `ok.bug_report.outcome`). The two are parent and
 * child in one stitched trace, so sharing either would render as
 * `send -> send -> mint` and put two different vocabularies on one attribute
 * key, which no consumer could aggregate.
 */

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

/** `00-<32 hex trace id>-<16 hex span id>-<2 hex flags>` */
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
  // The real W3C propagator, not a stand-in: `traceparent()` is the contract
  // main parses on the other side of the IPC boundary, so the encoding under
  // test should be the one production uses.
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
    // Both open before either closes — the interleaving a background manager
    // actually produces when a reporter files a second bug mid-upload.
    const a = beginBugReportSendSpan();
    const b = beginBugReportSendSpan();

    const headerA = parseTraceparent(a.traceparent());
    const headerB = parseTraceparent(b.traceparent());

    // Distinct operations, distinct spans: main must be able to parent each
    // transport span under the send that actually started it.
    expect(headerA.spanId).not.toBe(headerB.spanId);
    expect(headerA.traceId).not.toBe(headerB.traceId);

    a.end('sent');
    b.end('failed');

    const finished = exporter.getFinishedSpans();
    const byOutcome = new Map(
      finished.map((s) => [s.attributes['ok.bug_report.renderer_outcome'], s]),
    );
    // Each header names the span that later closed with that operation's
    // outcome — the property that keeps the two traces from crossing.
    expect(byOutcome.get('sent')?.spanContext().spanId).toBe(headerA.spanId);
    expect(byOutcome.get('failed')?.spanContext().spanId).toBe(headerB.spanId);
  });

  test('the traceparent is stable across reads for one operation', () => {
    // A retry re-reads the header before re-dispatching; it must address the
    // same span rather than mint a new identity mid-operation.
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
