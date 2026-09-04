import { DEFAULT_TELEMETRY_ATTRIBUTE_DENYLIST } from '@inkeep/open-knowledge-core/server';
import type { Attributes, Meter, Span, SpanOptions, Tracer } from '@opentelemetry/api';
import { context, metrics, propagation, SpanStatusCode, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { MeterProvider, PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import {
  BasicTracerProvider,
  BatchSpanProcessor,
  SimpleSpanProcessor,
  type SpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';
import { getLogger } from './logger.ts';
import { FileSpanExporter, ScrubbingSpanProcessor } from './telemetry-file-sink.ts';

const TRACER_NAME = 'open-knowledge-server';

let tracerProvider: BasicTracerProvider | null = null;
let meterProvider: MeterProvider | null = null;
let fileSpanExporter: FileSpanExporter | null = null;

function noopResult(): { tracer: Tracer; meter: Meter } {
  return {
    tracer: trace.getTracer(TRACER_NAME),
    meter: metrics.getMeter(TRACER_NAME),
  };
}

export interface LocalSinkOptions {
  projectDir: string;
  spansMaxBytes: number;
  attributeDenylist: readonly string[];
}

export interface InitTelemetryOptions {
  localSink?: LocalSinkOptions;
}

export function initTelemetry(opts: InitTelemetryOptions = {}): { tracer: Tracer; meter: Meter } {
  const fileSinkEnabled = opts.localSink !== undefined;
  const pushEnabled = process.env.OTEL_SDK_DISABLED === 'false';

  if (!fileSinkEnabled && !pushEnabled) {
    return noopResult();
  }

  if (tracerProvider) {
    return noopResult();
  }

  try {
    const resource = resourceFromAttributes({
      [ATTR_SERVICE_NAME]: process.env.OTEL_SERVICE_NAME || 'open-knowledge-server',
      [ATTR_SERVICE_VERSION]: process.env.OTEL_SERVICE_VERSION || '0.2.0',
    });

    const contextManager = new AsyncLocalStorageContextManager();
    context.setGlobalContextManager(contextManager);

    const spanProcessors: SpanProcessor[] = [];
    const attributeDenylist =
      opts.localSink?.attributeDenylist ?? DEFAULT_TELEMETRY_ATTRIBUTE_DENYLIST;
    spanProcessors.push(new ScrubbingSpanProcessor({ attributeDenylist }));
    if (fileSinkEnabled && opts.localSink !== undefined) {
      fileSpanExporter = new FileSpanExporter({
        projectDir: opts.localSink.projectDir,
        maxBytes: opts.localSink.spansMaxBytes,
      });
      spanProcessors.push(new SimpleSpanProcessor(fileSpanExporter));
    }
    if (pushEnabled) {
      spanProcessors.push(new BatchSpanProcessor(new OTLPTraceExporter()));
    }

    const tp = new BasicTracerProvider({ resource, spanProcessors });
    trace.setGlobalTracerProvider(tp);
    tracerProvider = tp;

    try {
      propagation.setGlobalPropagator(new W3CTraceContextPropagator());
    } catch (e) {
      const log = getLogger('telemetry');
      log.warn(
        { err: e },
        'OpenTelemetry propagator init failed — file sink active, distributed trace correlation degraded',
      );
    }

    let mp: MeterProvider | null = null;
    if (pushEnabled) {
      const metricExporter = new OTLPMetricExporter();
      mp = new MeterProvider({
        resource,
        readers: [new PeriodicExportingMetricReader({ exporter: metricExporter })],
      });
      metrics.setGlobalMeterProvider(mp);
    }
    meterProvider = mp;

    const log = getLogger('telemetry');
    log.info(
      {
        file_sink_enabled: fileSinkEnabled,
        otlp_push_enabled: pushEnabled,
        otlp_endpoint: pushEnabled
          ? process.env.OTEL_EXPORTER_OTLP_ENDPOINT || 'http://localhost:4318'
          : null,
        service_name: resource.attributes[ATTR_SERVICE_NAME],
      },
      'OpenTelemetry initialized',
    );
  } catch (e) {
    const log = getLogger('telemetry');
    if (tracerProvider !== null) {
      log.warn(
        { err: e },
        'OpenTelemetry metrics init failed — traces still active, metrics degraded',
      );
      meterProvider = null;
    } else {
      log.error({ err: e }, 'failed to initialize OpenTelemetry — falling back to no-op');
      meterProvider = null;
      fileSpanExporter = null;
    }
  }

  return noopResult();
}

const SHUTDOWN_TIMEOUT_MS = 5_000;

const shutdownHooks = new Set<() => void>();

export function onTelemetryShutdown(hook: () => void): void {
  shutdownHooks.add(hook);
}

export async function shutdownTelemetry(): Promise<void> {
  const log = getLogger('telemetry');
  for (const hook of shutdownHooks) {
    try {
      hook();
    } catch (err) {
      log.warn({ err }, 'telemetry shutdown reset hook threw; continuing teardown');
    }
  }
  if (!tracerProvider && !meterProvider) return;
  const fileFlush = fileSpanExporter
    ? fileSpanExporter.forceFlush().catch((e: unknown) => {
        log.warn({ err: e }, 'telemetry file-sink flush failed during shutdown');
      })
    : Promise.resolve();
  const shutdownPromise = fileFlush.then(() =>
    Promise.all([
      tracerProvider?.shutdown().catch((e: unknown) => {
        log.warn({ err: e }, 'tracer provider shutdown failed');
      }),
      meterProvider?.shutdown().catch((e: unknown) => {
        log.warn({ err: e }, 'meter provider shutdown failed');
      }),
    ]),
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = await Promise.race([
    shutdownPromise.then(() => {
      if (timer !== undefined) clearTimeout(timer);
      return false;
    }),
    new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(true), SHUTDOWN_TIMEOUT_MS);
      timer.unref?.();
    }),
  ]);
  if (timedOut) {
    log.warn({}, `telemetry shutdown timed out after ${SHUTDOWN_TIMEOUT_MS}ms — data may be lost`);
  }
  tracerProvider = null;
  meterProvider = null;
  fileSpanExporter = null;
  trace.disable();
  metrics.disable();
  context.disable();
}

export function getTracer(): Tracer {
  return trace.getTracer(TRACER_NAME);
}

export function getMeter(): Meter {
  return metrics.getMeter(TRACER_NAME);
}

export async function withSpan<T>(
  name: string,
  options: SpanOptions | undefined,
  fn: (span: Span) => Promise<T> | T,
): Promise<T> {
  const tracer = getTracer();
  return tracer.startActiveSpan(name, options ?? {}, async (span) => {
    try {
      const result = await fn(span);
      if (span.isRecording()) {
      }
      return result;
    } catch (err) {
      span.recordException(err as Error);
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: err instanceof Error ? err.message : String(err),
      });
      throw err;
    } finally {
      span.end();
    }
  });
}

export function withSpanSync<T>(
  name: string,
  options: SpanOptions | undefined,
  fn: (span: Span) => T,
): T {
  const tracer = getTracer();
  return tracer.startActiveSpan(name, options ?? {}, (span) => {
    try {
      const result = fn(span);
      return result;
    } catch (err) {
      span.recordException(err as Error);
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: err instanceof Error ? err.message : String(err),
      });
      throw err;
    } finally {
      span.end();
    }
  });
}

export function setActiveSpanAttributes(attrs: Attributes): void {
  const span = trace.getSpan(context.active());
  if (span) span.setAttributes(attrs);
}
