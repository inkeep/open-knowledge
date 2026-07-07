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
// The local file-sink exporter, held separately from the provider so
// shutdownTelemetry can drain its append chain on a dedicated, awaited promise
// BEFORE the provider-wide fan-out. That fan-out (MultiSpanProcessor.shutdown)
// is `Promise.all(...).then(resolve, reject)`, which rejects the instant the
// OTLP push processor does — a fast ECONNREFUSED when the collector is
// unreachable — pre-empting this pipeline's still-in-flight disk write and
// dropping the spans `ok diagnose bundle` exists to harvest.
let fileSpanExporter: FileSpanExporter | null = null;

function noopResult(): { tracer: Tracer; meter: Meter } {
  return {
    tracer: trace.getTracer(TRACER_NAME),
    meter: metrics.getMeter(TRACER_NAME),
  };
}

/**
 * Local-disk file sink configuration. When passed to {@link initTelemetry},
 * a `ScrubbingSpanProcessor` → `SimpleSpanProcessor(FileSpanExporter)` chain
 * is registered on the same tracer provider as the OTLP push pipeline (when
 * the env gate also enables it), so spans land both on disk and on the
 * collector when both are turned on.
 *
 * Resolution from the project's `.ok/config.yml` (`telemetry.localSink.*`)
 * is the caller's responsibility — see `boot.ts`'s pre-bootServer config
 * read for the canonical site. Omit `localSink` entirely to skip the file
 * pipeline (the default, matching the current zero-overhead-when-disabled
 * behaviour).
 */
export interface LocalSinkOptions {
  /** Project root (where `.ok/` lives); spans land at `<projectDir>/.ok/local/telemetry/spans-current.jsonl`. */
  projectDir: string;
  /** Rotation threshold for `spans-current.jsonl` (resolved `telemetry.localSink.spans.maxBytes`). */
  spansMaxBytes: number;
  /** Credential denylist for `ScrubbingSpanProcessor` (resolved `telemetry.localSink.attributeDenylist`). */
  attributeDenylist: readonly string[];
}

export interface InitTelemetryOptions {
  /**
   * When set, registers the file pipeline (`ScrubbingSpanProcessor` →
   * `SimpleSpanProcessor(FileSpanExporter)`) on the tracer provider,
   * regardless of `OTEL_SDK_DISABLED`. Omit to skip the file sink.
   */
  localSink?: LocalSinkOptions;
}

/**
 * Initialize OpenTelemetry tracing and metrics. Two pipelines compose on
 * a single `BasicTracerProvider`:
 *
 * - **File sink (config-gated):** active when `opts.localSink` is provided.
 *   Writes OTLP/JSON Lines to disk for `ok diagnose bundle` to harvest;
 *   independent of any collector. Default-on in the resolved config.
 * - **OTLP push (env-gated):** active when `OTEL_SDK_DISABLED === 'false'`.
 *   Pushes traces + metrics to an OTLP/HTTP collector (default
 *   `http://localhost:4318`; override via `OTEL_EXPORTER_OTLP_ENDPOINT`).
 *
 * When neither pipeline is enabled, returns no-op tracer + meter from the
 * OTel API — zero overhead. The `ScrubbingSpanProcessor` runs first in the
 * processor chain so credential-shaped attribute values never reach any
 * downstream exporter — registration order matters because the BSP queues
 * the same `ReadableSpan` reference both processors see.
 *
 * Metrics push only fires under the OTLP-push gate (no metrics file sink:
 * JSONL form of aggregated time-series has low marginal signal for
 * bug-report debugging).
 *
 * Idempotent — calling twice returns the same providers.
 *
 * Failure modes branch on which subsystem threw:
 *   - **TracerProvider construction or registration fails** → falls back to
 *     no-op tracer + meter (telemetry never crashes the server).
 *   - **Propagator setup fails** (rare; `setGlobalPropagator` is a setter) →
 *     traces remain active and land on disk; distributed-trace correlation
 *     degrades (the no-op propagator ignores incoming `traceparent` headers).
 *   - **MeterProvider construction fails** → traces remain active; metrics
 *     degrade independently (no OTLP metric push).
 */
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

    // Context manager — Bun supports AsyncLocalStorage
    const contextManager = new AsyncLocalStorageContextManager();
    context.setGlobalContextManager(contextManager);

    // Compose span processors in registration order. ScrubbingSpanProcessor
    // MUST come first: BasicTracerProvider dispatches processors in order, and
    // each downstream BSP queues the same ReadableSpan reference for later
    // flush, so a scrubbed-then-queued span is what every exporter eventually
    // serializes. The scrubber runs whenever ANY pipeline is active — toggling
    // the file sink off must not silently re-enable credential leaks to the
    // OTLP collector. When the operator hasn't supplied a denylist (push-only
    // installs that never went through resolveLocalSinkConfig), fall back to
    // the schema's shared default so the enforcement contract holds.
    const spanProcessors: SpanProcessor[] = [];
    const attributeDenylist =
      opts.localSink?.attributeDenylist ?? DEFAULT_TELEMETRY_ATTRIBUTE_DENYLIST;
    spanProcessors.push(new ScrubbingSpanProcessor({ attributeDenylist }));
    if (fileSinkEnabled && opts.localSink !== undefined) {
      // SimpleSpanProcessor (not Batch) for the LOCAL file sink: a local
      // append needs no batching, and BatchSpanProcessor's 5s scheduledDelay
      // left freshly-ended spans queued on the timer, racing
      // shutdownTelemetry's SHUTDOWN_TIMEOUT_MS (5s) — under CI load the flush
      // lost that race and spans never reached disk (silent data loss for
      // `ok diagnose bundle`). Exporting on
      // span end keeps the appender drain at shutdown near-instant. Batch
      // stays for the OTLP push exporter below (network, where batching pays).
      // The exporter is also captured in `fileSpanExporter` so shutdown can
      // drain it ahead of the OTLP-coupled provider fan-out (see its comment).
      fileSpanExporter = new FileSpanExporter({
        projectDir: opts.localSink.projectDir,
        maxBytes: opts.localSink.spansMaxBytes,
      });
      spanProcessors.push(new SimpleSpanProcessor(fileSpanExporter));
    }
    if (pushEnabled) {
      spanProcessors.push(new BatchSpanProcessor(new OTLPTraceExporter()));
    }

    // Traces — sdk-trace-base (not sdk-trace-node) for Bun compatibility.
    // Commit the tracer provider to the module slot AS SOON AS it is
    // globally registered. Metrics and propagator setup can both fail
    // independently and the catch below must not tear down a live,
    // recording TracerProvider — the file sink is the load-bearing
    // surface for bug-report bundles, so traces have to survive
    // metrics misconfiguration AND propagator init failure.
    const tp = new BasicTracerProvider({ resource, spanProcessors });
    trace.setGlobalTracerProvider(tp);
    tracerProvider = tp;

    // Register the W3C trace-context propagator so `propagation.extract()`
    // can parse incoming `traceparent` headers (browser → server span
    // chaining). `setGlobalTracerProvider` alone leaves the no-op propagator
    // in place — `propagation.extract()` would return the active context
    // unchanged, and every server-side HTTP span would become a root span
    // disconnected from the browser trace. sdk-trace-node's `register()`
    // does this automatically; sdk-trace-base/BasicTracerProvider does not.
    // Wrap in its own try/catch so a propagator throw lands a precise
    // diagnostic (instead of the outer catch's metrics-failure warn) and
    // leaves the TracerProvider + file sink alive — distributed-trace
    // correlation degrades but on-disk span capture continues.
    try {
      propagation.setGlobalPropagator(new W3CTraceContextPropagator());
    } catch (e) {
      const log = getLogger('telemetry');
      log.warn(
        { err: e },
        'OpenTelemetry propagator init failed — file sink active, distributed trace correlation degraded',
      );
    }

    // Metrics — only when the OTLP push gate is on. The file sink covers
    // spans + logs only; metrics stay collector-bound or off.
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
      // TracerProvider was committed to the global API before the throw —
      // metrics setup failed independently. Keep the tracer + its file
      // sink live so shutdownTelemetry can drain pending spans on exit,
      // and so any in-flight withSpan() continues to land on disk.
      log.warn(
        { err: e },
        'OpenTelemetry metrics init failed — traces still active, metrics degraded',
      );
      meterProvider = null;
    } else {
      // Throw came before TracerProvider assignment — nothing to keep
      // alive; fall back to the no-op tracer too. Drop the captured file
      // exporter so a later shutdown's no-provider early-return doesn't
      // strand it (no live provider means no spans were recorded anyway).
      log.error({ err: e }, 'failed to initialize OpenTelemetry — falling back to no-op');
      meterProvider = null;
      fileSpanExporter = null;
    }
  }

  return noopResult();
}

const SHUTDOWN_TIMEOUT_MS = 5_000;

/**
 * Hooks run during `shutdownTelemetry` so modules that registered global
 * instruments (e.g. the server-memory observable gauge) can drop their cached
 * handles when the provider is torn down. Without this, a module-level cached
 * instrument outlives the provider that backed it: the next `initTelemetry`
 * builds a fresh provider, but the stale cached instrument's idempotency guard
 * makes re-registration a no-op, so its callback never binds to the live meter.
 * Registered via `onTelemetryShutdown` so
 * telemetry.ts need not import those modules (which would be circular — they
 * import `getMeter` from here).
 */
const shutdownHooks = new Set<() => void>();

/** Register a reset hook invoked on every `shutdownTelemetry`. Idempotent per fn. */
export function onTelemetryShutdown(hook: () => void): void {
  shutdownHooks.add(hook);
}

/** Graceful shutdown — flush pending spans and metrics. Idempotent. */
export async function shutdownTelemetry(): Promise<void> {
  const log = getLogger('telemetry');
  // Reset hooks fire even when no provider is live: a module may have cached an
  // instrument against the API no-op meter (OTel disabled), and that cache must
  // still clear so a later real init re-registers cleanly.
  for (const hook of shutdownHooks) {
    try {
      hook();
    } catch (err) {
      // A misbehaving reset hook must not block provider teardown below — but
      // swallowing it silently would make a future hook regression invisible
      // in operator logs, so warn before continuing.
      log.warn({ err }, 'telemetry shutdown reset hook threw; continuing teardown');
    }
  }
  if (!tracerProvider && !meterProvider) return;
  // Drain the local file sink FIRST, then shut the providers down. The
  // provider fan-out (MultiSpanProcessor.shutdown) is
  // `Promise.all(...).then(resolve, reject)`, so the OTLP push processor's
  // fast ECONNREFUSED rejection (unreachable collector) short-circuits the
  // whole shutdown before the file processor's still-in-flight append
  // settles — the residual flake and silent
  // `ok diagnose bundle` data loss that the SimpleSpanProcessor swap narrowed
  // but did not close. Sequencing the drain ahead of the fan-out makes
  // on-disk capture independent of the push pipeline's fate; the whole chain
  // still rides the SHUTDOWN_TIMEOUT_MS race below, so a pathological fs stall
  // can't deadlock teardown.
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

/** Get the tracer instance (no-op if SDK not registered). */
export function getTracer(): Tracer {
  return trace.getTracer(TRACER_NAME);
}

/** Get the meter instance (no-op if SDK not registered). */
export function getMeter(): Meter {
  return metrics.getMeter(TRACER_NAME);
}

/**
 * Run `fn` inside a new span. Automatically records exceptions, sets status,
 * and ends the span when `fn` resolves or rejects.
 *
 * The span is activated in the current context so any child work (awaits,
 * nested `withSpan` calls, `getTracer().startSpan(...)`) inherits it as parent.
 */
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
        // Leave status unset (implicitly OK) — callers can override.
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

/**
 * Synchronous variant of `withSpan` for non-async code paths.
 */
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

/**
 * Safely add attributes to the currently active span without a reference.
 * No-op if no active span.
 */
export function setActiveSpanAttributes(attrs: Attributes): void {
  const span = trace.getSpan(context.active());
  if (span) span.setAttributes(attrs);
}
