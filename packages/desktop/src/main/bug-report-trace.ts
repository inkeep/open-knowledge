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

type BugReportSendOutcome = 'sent' | 'email-drafted' | 'upload-failed' | 'send-in-flight';

type BugReportSendPhase = 'mint' | 'upload' | 'complete';

export type BoundedAttributes = Record<string, number | boolean>;

export interface BugReportSendTrace {
  phase(
    name: BugReportSendPhase,
    attributes: BoundedAttributes,
    startMs: number,
    endMs: number,
  ): void;
  end(outcome: BugReportSendOutcome, attributes?: BoundedAttributes): void;
}

const NOOP_TRACE: BugReportSendTrace = {
  phase: () => {},
  end: () => {},
};

function otelEnabled(): boolean {
  return process.env.OTEL_SDK_DISABLED === 'false';
}

export function beginSendTrace(
  attributes: BoundedAttributes = {},
  traceparent?: string,
): BugReportSendTrace {
  if (!otelEnabled()) return NOOP_TRACE;
  try {
    const parent =
      traceparent === undefined ? ROOT_CONTEXT : propagation.extract(ROOT_CONTEXT, { traceparent });
    const span = getTracer().startSpan('ok.bug-report.send', undefined, parent);
    if (!span.isRecording()) {
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
        const child = getTracer().startSpan(
          `ok.bug-report.${name}`,
          { startTime: startMs },
          sendContext,
        );
        child.setAttributes(attributes);
        child.end(endMs);
      } catch {}
    },
    end(outcome, attributes) {
      if (ended) return;
      ended = true;
      try {
        if (attributes) span.setAttributes(attributes);
        span.setAttribute('ok.bug_report.outcome', outcome);
        span.setStatus({
          code: outcome === 'upload-failed' ? SpanStatusCode.ERROR : SpanStatusCode.OK,
        });
        span.end();
      } catch {}
    },
  };
}
