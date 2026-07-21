/**
 * Tests for the MCP tool-dispatch telemetry wrapper.
 *
 * The wrapper sits at the registration spine (createLoggedServer) so every
 * tool gets a `mcp.tool.<name>` span, a duration histogram point, and error
 * counting — including the HTTP MCP endpoint, which registers without a
 * logger and would otherwise be the one uninstrumented telemetry-live path.
 *
 * Production wiring uses the OTLP exporter via `initTelemetry`; these
 * assertions use InMemory exporters purely as a unit-test capture surface,
 * mirroring the sync-handshake-span-extension.test.ts pattern.
 */
import { context, metrics, SpanStatusCode, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import {
  AggregationTemporality,
  type DataPoint,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
} from '@opentelemetry/sdk-metrics';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  type ReadableSpan,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { shutdownTelemetry } from '../telemetry.ts';
import { createLoggedServer } from './tool-logging.ts';
import { wrapToolHandlerForTelemetry } from './tool-telemetry.ts';

const DURATION_METRIC = 'ok.mcp.tool.duration';
const ERRORS_METRIC = 'ok.mcp.tool.errors';

let spanExporter: InMemorySpanExporter;
let tracerProvider: BasicTracerProvider;
let metricExporter: InMemoryMetricExporter;
let metricReader: PeriodicExportingMetricReader;
let meterProvider: MeterProvider;

beforeEach(async () => {
  // Drop instrument caches bound to any previous test's provider.
  await shutdownTelemetry();
  spanExporter = new InMemorySpanExporter();
  tracerProvider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(spanExporter)],
  });
  trace.setGlobalTracerProvider(tracerProvider);
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  metricExporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
  metricReader = new PeriodicExportingMetricReader({
    exporter: metricExporter,
    exportIntervalMillis: 60_000,
  });
  meterProvider = new MeterProvider({ readers: [metricReader] });
  metrics.setGlobalMeterProvider(meterProvider);
});

afterEach(async () => {
  await tracerProvider.shutdown();
  await meterProvider.shutdown();
  trace.disable();
  metrics.disable();
  context.disable();
  await shutdownTelemetry();
});

function spansByName(name: string): ReadableSpan[] {
  return spanExporter.getFinishedSpans().filter((s) => s.name === name);
}

async function collectPoints(
  metricName: string,
): Promise<Array<{ value: unknown; attributes: Record<string, unknown> }>> {
  await metricReader.forceFlush();
  const out: Array<{ value: unknown; attributes: Record<string, unknown> }> = [];
  for (const rm of metricExporter.getMetrics()) {
    for (const sm of rm.scopeMetrics) {
      for (const metric of sm.metrics) {
        if (metric.descriptor.name !== metricName) continue;
        for (const dp of metric.dataPoints as Array<DataPoint<unknown>>) {
          out.push({ value: dp.value, attributes: dp.attributes });
        }
      }
    }
  }
  return out;
}

describe('wrapToolHandlerForTelemetry', () => {
  test('emits an mcp.tool.<name> span with a bounded tool-name attribute', async () => {
    const wrapped = wrapToolHandlerForTelemetry('write', async () => ({ content: [] }));
    await wrapped({ docName: 'notes/test' });
    const spans = spansByName('mcp.tool.write');
    expect(spans.length).toBe(1);
    expect(spans[0]?.attributes['mcp.tool.name']).toBe('write');
    expect(spans[0]?.status.code).not.toBe(SpanStatusCode.ERROR);
  });

  test('records a duration histogram point labeled by tool', async () => {
    const wrapped = wrapToolHandlerForTelemetry('search', async () => ({ content: [] }));
    await wrapped({ query: 'q' });
    const points = await collectPoints(DURATION_METRIC);
    expect(points.length).toBe(1);
    expect(points[0]?.attributes.tool).toBe('search');
    const histogramValue = points[0]?.value as { count: number };
    expect(histogramValue.count).toBe(1);
  });

  test('passes the result through unchanged and preserves invocation args', async () => {
    const seen: unknown[] = [];
    const result = { content: [{ type: 'text', text: 'ok' }] };
    const wrapped = wrapToolHandlerForTelemetry('exec', async (...args: unknown[]) => {
      seen.push(...args);
      return result;
    });
    const extra = { requestId: 'req-1' };
    await expect(wrapped({ command: 'ls' }, extra)).resolves.toBe(result);
    expect(seen).toEqual([{ command: 'ls' }, extra]);
  });

  test('counts an isError result as error_result and marks the span ERROR', async () => {
    const wrapped = wrapToolHandlerForTelemetry('edit', async () => ({
      isError: true,
      content: [{ type: 'text', text: 'no such doc' }],
    }));
    const result = (await wrapped({ docName: 'missing' })) as { isError: boolean };
    // The error result still flows back to the MCP client unchanged.
    expect(result.isError).toBe(true);

    const spans = spansByName('mcp.tool.edit');
    expect(spans[0]?.status.code).toBe(SpanStatusCode.ERROR);
    const errorPoints = await collectPoints(ERRORS_METRIC);
    expect(errorPoints.length).toBe(1);
    expect(errorPoints[0]?.attributes).toMatchObject({ tool: 'edit', kind: 'error_result' });
    expect(errorPoints[0]?.value).toBe(1);
  });

  test('counts a thrown error as exception, marks the span ERROR, and rethrows', async () => {
    const wrapped = wrapToolHandlerForTelemetry('move', async () => {
      throw new Error('boom');
    });
    await expect(wrapped({ from: 'a', to: 'b' })).rejects.toThrow('boom');

    const spans = spansByName('mcp.tool.move');
    expect(spans.length).toBe(1);
    expect(spans[0]?.status.code).toBe(SpanStatusCode.ERROR);
    const errorPoints = await collectPoints(ERRORS_METRIC);
    expect(errorPoints[0]?.attributes).toMatchObject({ tool: 'move', kind: 'exception' });
    // Duration still records on the throw path.
    const durationPoints = await collectPoints(DURATION_METRIC);
    expect(durationPoints[0]?.attributes.tool).toBe('move');
  });

  test('is a safe no-op passthrough when no OTel SDK is registered', async () => {
    trace.disable();
    metrics.disable();
    await shutdownTelemetry();
    const wrapped = wrapToolHandlerForTelemetry('write', async () => 'plain-result');
    await expect(wrapped({})).resolves.toBe('plain-result');
  });
});

describe('createLoggedServer telemetry wrapping', () => {
  test('wraps registerTool handlers even when no logger is supplied', async () => {
    // The HTTP MCP endpoint registers without a logger — the previous
    // logger-gated early return would have left it uninstrumented.
    let capturedHandler: ((...args: unknown[]) => unknown) | undefined;
    const fakeServer = {
      tool: () => 'legacy-registered',
      registerTool: (_name: string, _config: unknown, handler: (...args: unknown[]) => unknown) => {
        capturedHandler = handler;
        return 'registered-tool';
      },
    };

    const wrapped = createLoggedServer(fakeServer as never, {});
    const originalHandler = async () => ({ content: [] });
    (
      wrapped as unknown as {
        registerTool: (name: string, config: unknown, cb: unknown) => unknown;
      }
    ).registerTool('history', { description: 'desc' }, originalHandler);

    expect(capturedHandler).toBeDefined();
    expect(capturedHandler).not.toBe(originalHandler);
    await capturedHandler?.({ docName: 'notes/test' });
    expect(spansByName('mcp.tool.history').length).toBe(1);
  });

  test('wraps legacy tool() handlers without a logger', async () => {
    let capturedHandler: ((...args: unknown[]) => unknown) | undefined;
    const fakeServer = {
      tool: (...args: unknown[]) => {
        capturedHandler = args.at(-1) as (...args: unknown[]) => unknown;
        return 'registered';
      },
    };

    const wrapped = createLoggedServer(fakeServer as never, {});
    const originalHandler = async () => ({ content: [] });
    (wrapped as unknown as { tool: (...args: unknown[]) => unknown }).tool(
      'palette',
      'desc',
      {},
      originalHandler,
    );

    expect(capturedHandler).not.toBe(originalHandler);
    await capturedHandler?.({});
    expect(spansByName('mcp.tool.palette').length).toBe(1);
  });
});
