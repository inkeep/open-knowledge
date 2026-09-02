import { context, propagation } from '@opentelemetry/api';

export function appendTraceContextToCollabUrl(url: string): string {
  const carrier: Record<string, string> = {};
  propagation.inject(context.active(), carrier);
  if (!carrier.traceparent) return url;

  const sep = url.includes('?') ? '&' : '?';
  const params: string[] = [`traceparent=${encodeURIComponent(carrier.traceparent)}`];
  if (carrier.tracestate) {
    params.push(`tracestate=${encodeURIComponent(carrier.tracestate)}`);
  }
  return `${url}${sep}${params.join('&')}`;
}
