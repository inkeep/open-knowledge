/**
 * Renderer-side spans for a background bug-report send.
 *
 * Main already traces the transport. This traces the operation as the reporter
 * experiences it, which is a different span: it opens when they press Send and
 * closes when the toast resolves, so it covers the waiting the transport span
 * cannot see — the join of a duplicate retry, and a send whose IPC call never
 * comes back. It also carries the outcomes that never reach main at all: a
 * second Retry on an operation already in flight in this window is answered
 * here and never crosses the boundary.
 *
 * This span is the PARENT of main's. `traceparent()` hands the W3C header to
 * the send request; main extracts it and starts its transport span underneath,
 * so one trace covers the whole send rather than two disconnected halves.
 *
 * Concurrency is why each span keeps its own `Context` rather than reading the
 * active one. Several sends run at once by design, and both the header this
 * module injects and any child it parents must come from *that operation's*
 * context — `context.active()` in an interleaved async flow can belong to a
 * sibling send, which would silently graft one report's trace onto another.
 *
 * `@opentelemetry/api` returns a no-op tracer when no SDK is registered, so
 * this costs nothing unless `VITE_OTEL_ENABLED='true'`.
 */

import { type Context, propagation, ROOT_CONTEXT, type Span, trace } from '@opentelemetry/api';

const TRACER_NAME = 'open-knowledge-app';

/**
 * Distinct from main's `ok.bug-report.send`. The two are parent and child in one
 * stitched trace, so sharing a name renders as `send -> send -> mint` and gives
 * a consumer no way to tell the operation from the transport it wraps.
 */
const SPAN_NAME = 'ok.bug-report.send.attempt';

/**
 * Terminal states of a renderer send operation. A closed set: `joined` is the
 * duplicate-retry case main never sees, the rest mirror the bridge's outcomes.
 * Bounded by construction, per the cardinality discipline these spans share
 * with the rest of the app's telemetry.
 */
type RendererSendOutcome = 'sent' | 'email-drafted' | 'failed' | 'joined';

/** Bounded attributes only — numbers and booleans. */
type BoundedAttributes = Record<string, number | boolean>;

export interface BugReportSendSpan {
  /**
   * W3C `traceparent` for THIS operation, or undefined when telemetry is off.
   * Injected from the span's own context, never the ambient one, so a
   * concurrently-starting send cannot capture this header.
   */
  traceparent(): string | undefined;
  /** Close the operation. Idempotent — a later call is ignored. */
  end(outcome: RendererSendOutcome, attributes?: BoundedAttributes): void;
}

/**
 * A span handle that records nothing. Exported because the manager needs a
 * value for a record's span field before its first attempt opens a real one.
 */
export const INERT_SEND_SPAN: BugReportSendSpan = {
  traceparent: () => undefined,
  end: () => {},
};

const NOOP_SPAN = INERT_SEND_SPAN;

/**
 * Open the span for one send operation.
 *
 * Wrapped end to end: `@opentelemetry/api` is a third-party boundary that can
 * throw from a misconfigured provider, and a telemetry fault must not take
 * down a bug report — the one flow a user reaches because something else is
 * already broken. Mirrors the fault-isolation wrap in `lib/language-telemetry.ts`.
 */
export function beginBugReportSendSpan(attributes: BoundedAttributes = {}): BugReportSendSpan {
  try {
    const span = trace.getTracer(TRACER_NAME).startSpan(SPAN_NAME, { attributes });
    if (!span.isRecording()) {
      span.end();
      return NOOP_SPAN;
    }
    return createSpanHandle(span, trace.setSpan(ROOT_CONTEXT, span));
  } catch (err) {
    console.warn(
      '[bug-report-send-otel] span start failed:',
      err instanceof Error ? err : String(err),
    );
    return NOOP_SPAN;
  }
}

function createSpanHandle(span: Span, spanContext: Context): BugReportSendSpan {
  let ended = false;
  return {
    traceparent() {
      try {
        const carrier: Record<string, string> = {};
        propagation.inject(spanContext, carrier);
        return carrier.traceparent;
      } catch {
        return undefined;
      }
    },
    end(outcome, attributes) {
      if (ended) return;
      ended = true;
      try {
        if (attributes) span.setAttributes(attributes);
        // Namespaced away from main's `ok.bug_report.outcome`: the two enums
        // describe the same send in different vocabularies ('failed' vs
        // 'upload-failed'), so one key carrying both is unaggregatable.
        span.setAttribute('ok.bug_report.renderer_outcome', outcome);
        span.end();
      } catch {
        // A telemetry fault must not surface in the send's result.
      }
    },
  };
}
