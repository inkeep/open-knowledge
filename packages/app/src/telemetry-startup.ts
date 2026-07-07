/**
 * Renderer side of the cross-process startup trace (Plan A).
 *
 * The Electron main process owns the `ok.app-startup` root span and passes its
 * W3C `traceparent` to the renderer on the bridge config
 * (`window.okDesktop.config.startupTraceparent`). This module extracts it and
 * opens a renderer-side `ok.app-startup` child span, ending it at the
 * first-content checkpoint (the later of page-list-ready and active-doc-synced,
 * surfaced by `startup-marks`). In Tempo the three processes — main, server,
 * renderer — join into one launch trace.
 *
 * Everything here is no-op-safe:
 *   - OTel disabled → `getAppTracer()` returns a NoopTracer; `startSpan` makes
 *     a non-recording span and `end()` does nothing.
 *   - No `startupTraceparent` (web build, OTel off in main, older host) → we
 *     skip entirely rather than start a parentless root.
 * The waterfall log path is independent of this module and works regardless.
 */

import { context, propagation, type Span } from '@opentelemetry/api';
import { onFirstContent } from '@/lib/perf/startup-marks';
import { getAppTracer } from './telemetry-impl';

let startupSpan: Span | undefined;

/**
 * Open the renderer `ok.app-startup` span parented to the main-process root and
 * arrange for it to end at first-content. Idempotent — a second call is a
 * no-op. Failures are swallowed (telemetry must never break startup).
 */
export function initStartupTrace(): void {
  if (startupSpan) return;
  try {
    const traceparent =
      typeof window !== 'undefined' ? window.okDesktop?.config.startupTraceparent : undefined;
    if (!traceparent) return;

    // Extract the main-process root context, then start the renderer child in
    // it. When OTel is disabled the tracer is a no-op and this whole chain is
    // cheap and inert.
    const parentCtx = propagation.extract(context.active(), { traceparent });
    const span = getAppTracer().startSpan('ok.app-startup', undefined, parentCtx);
    startupSpan = span;

    onFirstContent((firstContentMs) => {
      try {
        span.end(firstContentMs);
      } catch {
        // OTel SDK fault on end() must not escape — the waterfall log already
        // captured the timing independently.
      }
      startupSpan = undefined;
    });
  } catch {
    // Bridge read / propagator fault: leave the launch unaffected.
  }
}
