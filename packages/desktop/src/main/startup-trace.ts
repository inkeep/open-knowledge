/**
 * Plan A: the Electron main process owns the `ok.app-startup` OTel root span.
 *
 * Electron main has no OTel SDK by default (`withSpan` there is a no-op). To
 * make main the launch trace's root we call the server package's
 * `initTelemetry()` once at `app.whenReady()`, open a manual `ok.app-startup`
 * root span, and expose:
 *   - {@link injectTraceparent} — the root context's W3C `traceparent`, passed
 *     to the spawned server (`OK_STARTUP_TRACEPARENT`) and the renderer
 *     (`--ok-startup-traceparent=`) so both join this trace.
 *   - {@link childSpan} — main-process phase children with explicit start/end
 *     timestamps (the phases are recorded after the fact from the waterfall).
 *   - {@link endRoot} — end the root at window-shown.
 *
 * Fault isolation is total: `initTelemetry()` running under Electron's main
 * process is unproven, so any throw is swallowed and the module marks OTel
 * unavailable (Plan B degrade — the waterfall log path is independent and keeps
 * working). When `OTEL_SDK_DISABLED !== 'false'` the SDK stays off and every
 * method here is a cheap no-op over the OTel API's NoopTracer.
 */

import { getTracer, initTelemetry } from '@inkeep/open-knowledge-server';
import { type Context, context, propagation, type Span, trace } from '@opentelemetry/api';
import { getLogger } from './desktop-logger.ts';

let rootSpan: Span | undefined;
let rootContext: Context | undefined;
/** True once `beginRoot` successfully stood up the SDK + root span (Plan A live). */
let active = false;

/**
 * Initialize the OTel SDK in main (once) and open the `ok.app-startup` root
 * span. No-op when `OTEL_SDK_DISABLED !== 'false'` or already begun. Returns
 * whether Plan A is live (the SDK initialized and a recording root exists);
 * `false` means degrade to Plan B (waterfall log only, no main spans).
 */
export function beginRoot(): boolean {
  if (active) return true;
  if (process.env.OTEL_SDK_DISABLED !== 'false') return false;
  try {
    // Push-only init (no localSink): gated internally by OTEL_SDK_DISABLED,
    // which we already checked. Idempotent on repeat process-wide calls.
    initTelemetry();
    const span = getTracer().startSpan('ok.app-startup');
    if (!span.isRecording()) {
      // SDK didn't actually register a real provider (e.g. init swallowed a
      // failure) — treat as Plan B so we don't carry a phantom non-recording
      // root that produces a bare, unjoined traceparent.
      span.end();
      return false;
    }
    rootSpan = span;
    rootContext = trace.setSpan(context.active(), span);
    active = true;
    return true;
  } catch (err) {
    getLogger('startup-trace').warn(
      { err: err instanceof Error ? err.message : String(err) },
      'OTel root init failed in main — degrading to waterfall-log-only (Plan B)',
    );
    rootSpan = undefined;
    rootContext = undefined;
    active = false;
    return false;
  }
}

/** Whether the main-process OTel root is live (Plan A). */
export function isStartupTraceActive(): boolean {
  return active;
}

/**
 * W3C `traceparent` for the root context, or `undefined` when Plan A is not
 * live. Passed to the server (env) and renderer (argv) so they parent into the
 * launch trace.
 */
export function injectTraceparent(): string | undefined {
  if (!active || !rootContext) return undefined;
  try {
    const carrier: Record<string, string> = {};
    propagation.inject(rootContext, carrier);
    return carrier.traceparent;
  } catch {
    return undefined;
  }
}

/**
 * Emit a main-process phase as a child of the root with explicit timestamps.
 * No-op when Plan A is not live. Swallows SDK faults.
 */
export function childSpan(
  name: string,
  // Bounded attributes only (numbers/booleans) — never free-form strings, per
  // the cardinality STOP rule the launch trace shares with the timeline log.
  attributes: Record<string, number | boolean>,
  startMs: number,
  endMs: number,
): void {
  if (!active || !rootContext) return;
  try {
    const span = getTracer().startSpan(name, { startTime: startMs }, rootContext);
    span.setAttributes(attributes);
    span.end(endMs);
  } catch {
    // SDK fault must not escape into the launch path.
  }
}

/** End the root span (at window-shown). Idempotent. */
export function endRoot(endMs: number = Date.now()): void {
  if (!rootSpan) return;
  try {
    rootSpan.end(endMs);
  } catch {
    // ignore SDK fault on end
  }
  rootSpan = undefined;
  rootContext = undefined;
  active = false;
}

/** Test-only: reset module state between cases. */
export function __resetStartupTraceForTest(): void {
  rootSpan = undefined;
  rootContext = undefined;
  active = false;
}
