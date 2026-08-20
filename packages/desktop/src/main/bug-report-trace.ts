/**
 * OTel spans for the bug-report send path.
 *
 * The send used to be observable by eye: a modal held the reporter until it
 * resolved, so a slow or wedged upload was visible to the person who started
 * it. Sends now run in the background behind a toast, which means the only
 * remaining account of how long one took, and whether it worked, is this
 * trace. Everything the path emitted before was error-only (`logIpcError`), so
 * a send that succeeded slowly looked identical to one that succeeded fast.
 *
 * Topology: **one trace per send**, rooted at `ok.bug-report.send`, with a
 * child per transport step (`mint` / `upload` / `complete`). Sends are NOT
 * parented into the launch trace: `ok.app-startup` ends at window-shown, and a
 * report filed twenty minutes later would otherwise hang off a long-dead root.
 *
 * Concurrency is the reason this module exists rather than a `withSpan` call
 * at the handler. Several sends can be in flight at once (the whole point of
 * the background manager), and `startActiveSpan` parents from the *ambient*
 * async context — so an upload that begins while another is awaiting can nest
 * under its sibling and produce a trace that misreports one send as a phase of
 * another. Every span here is opened with an **explicit parent context** that
 * the caller holds, so two concurrent sends cannot see each other's context.
 * `beginSendTrace` returns a handle; the handle owns its context; phases pass
 * it back. Nothing reads `context.active()`.
 *
 * Fault isolation is total, matching `startup-trace.ts`: the SDK is off unless
 * `OTEL_SDK_DISABLED === 'false'`, every entry point swallows SDK faults, and
 * a non-recording span degrades to a no-op handle. Telemetry must never be
 * able to fail a bug report — the one path a user reaches *because* something
 * else already broke.
 */

import { getTracer } from '@inkeep/open-knowledge-server';
import {
  type Context,
  propagation,
  ROOT_CONTEXT,
  type Span,
  SpanStatusCode,
  trace,
} from '@opentelemetry/api';
import { getLogger } from './desktop-logger.ts';

/**
 * Closed set of terminal outcomes, mirroring the handler's own branches. A
 * closed enum is deliberate: the cardinality rule this trace shares with the
 * launch trace bars free-form string attributes (paths, ids, error text), and
 * a four-value set is bounded by construction. Anything unbounded belongs in
 * the log line, not on a span.
 */
type BugReportSendOutcome = 'sent' | 'email-drafted' | 'upload-failed' | 'send-in-flight';

/** Transport steps inside a send, in the order `uploadBugReport` runs them. */
type BugReportSendPhase = 'mint' | 'upload' | 'complete';

/** Bounded attributes only — numbers and booleans. See the cardinality note above. */
export type BoundedAttributes = Record<string, number | boolean>;

/**
 * A single send's trace. Every method is a no-op when OTel is off or the span
 * is not recording, so callers need no conditionals of their own.
 */
export interface BugReportSendTrace {
  /**
   * Record a transport step as a child of THIS send. Takes explicit start/end
   * timestamps because the steps are timed by the caller and recorded on
   * completion, and passes this handle's own context as the parent so a
   * concurrent send cannot capture it.
   */
  phase(
    name: BugReportSendPhase,
    attributes: BoundedAttributes,
    startMs: number,
    endMs: number,
  ): void;
  /** Terminal outcome. Idempotent — a second call is ignored. */
  end(outcome: BugReportSendOutcome, attributes?: BoundedAttributes): void;
}

/** Handle used when OTel is off, the SDK is not recording, or anything threw. */
const NOOP_TRACE: BugReportSendTrace = {
  phase: () => {},
  end: () => {},
};

function otelEnabled(): boolean {
  // Same gate as startup-trace: opt-IN, so a normal desktop run pays nothing.
  return process.env.OTEL_SDK_DISABLED === 'false';
}

/**
 * Open the root span for one send.
 *
 * `ROOT_CONTEXT` is passed explicitly rather than `context.active()`. That is
 * the load-bearing line for concurrency: it guarantees this send begins its
 * own trace no matter what ambient context the IPC handler happens to run
 * under, so two sends started microseconds apart are siblings in separate
 * traces rather than one appearing nested inside the other.
 *
 * Never throws. Returns a no-op handle when telemetry is unavailable.
 */
export function beginSendTrace(
  attributes: BoundedAttributes = {},
  traceparent?: string,
): BugReportSendTrace {
  if (!otelEnabled()) return NOOP_TRACE;
  try {
    // The renderer owns the user-perceived send and passes its W3C
    // `traceparent` over IPC, so main's transport work nests under the
    // operation the reporter actually started. Each in-flight send carries its
    // own header, which is what keeps the parenting correct when several are
    // running at once. Absent or malformed, `extract` yields the context
    // unchanged and this send roots its own trace instead.
    const parent =
      traceparent === undefined ? ROOT_CONTEXT : propagation.extract(ROOT_CONTEXT, { traceparent });
    const span = getTracer().startSpan('ok.bug-report.send', undefined, parent);
    if (!span.isRecording()) {
      // No real provider registered — end it rather than carry a phantom root
      // whose children would go nowhere.
      span.end();
      return NOOP_TRACE;
    }
    span.setAttributes(attributes);
    return createHandle(span, trace.setSpan(ROOT_CONTEXT, span));
  } catch (err) {
    getLogger('bug-report-trace').warn(
      { err },
      'OTel span start failed for bug-report send — continuing untraced',
    );
    return NOOP_TRACE;
  }
}

function createHandle(span: Span, sendContext: Context): BugReportSendTrace {
  let ended = false;
  return {
    phase(name, attributes, startMs, endMs) {
      if (ended) return;
      try {
        // `sendContext` — this send's own context, captured at begin. Passing
        // it explicitly is what keeps concurrent sends from adopting each
        // other's spans as parents.
        const child = getTracer().startSpan(
          `ok.bug-report.${name}`,
          { startTime: startMs },
          sendContext,
        );
        child.setAttributes(attributes);
        child.end(endMs);
      } catch {
        // A telemetry fault must not surface in the send's result.
      }
    },
    end(outcome, attributes) {
      if (ended) return;
      ended = true;
      try {
        if (attributes) span.setAttributes(attributes);
        span.setAttribute('ok.bug_report.outcome', outcome);
        // Only a genuinely failed upload is an error. `email-drafted` is the
        // designed no-intake path and `send-in-flight` is a refused duplicate;
        // marking either ERROR would light up dashboards for working behavior.
        span.setStatus({
          code: outcome === 'upload-failed' ? SpanStatusCode.ERROR : SpanStatusCode.OK,
        });
        span.end();
      } catch {
        // ignore SDK fault on end
      }
    },
  };
}
