import { type Context, propagation, ROOT_CONTEXT, type Span, trace } from '@opentelemetry/api';

const TRACER_NAME = 'open-knowledge-app';

const SPAN_NAME = 'ok.bug-report.send.attempt';

type RendererSendOutcome = 'sent' | 'email-drafted' | 'failed' | 'joined';

type BoundedAttributes = Record<string, number | boolean>;

export interface BugReportSendSpan {
  traceparent(): string | undefined;
  end(outcome: RendererSendOutcome, attributes?: BoundedAttributes): void;
}

export const INERT_SEND_SPAN: BugReportSendSpan = {
  traceparent: () => undefined,
  end: () => {},
};

const NOOP_SPAN = INERT_SEND_SPAN;

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
        span.setAttribute('ok.bug_report.renderer_outcome', outcome);
        span.end();
      } catch {}
    },
  };
}
