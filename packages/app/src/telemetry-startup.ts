import { context, propagation, type Span } from '@opentelemetry/api';
import { onFirstContent } from '@/lib/perf/startup-marks';
import { getAppTracer } from './telemetry-impl';

let startupSpan: Span | undefined;

export function initStartupTrace(): void {
  if (startupSpan) return;
  try {
    const traceparent =
      typeof window !== 'undefined' ? window.okDesktop?.config.startupTraceparent : undefined;
    if (!traceparent) return;

    const parentCtx = propagation.extract(context.active(), { traceparent });
    const span = getAppTracer().startSpan('ok.app-startup', undefined, parentCtx);
    startupSpan = span;

    onFirstContent((firstContentMs) => {
      try {
        span.end(firstContentMs);
      } catch {}
      startupSpan = undefined;
    });
  } catch {}
}
