/**
 * Hocuspocus WebSocket ↔ OTel trace context bridge.
 *
 * The browser's native WebSocket API cannot set headers (unlike fetch), so
 * we inject the current trace context as a URL query parameter. The server's
 * `onConnect` hook (packages/server/src/server-factory.ts, future wiring) extracts
 * `traceparent` from `requestParameters` and attaches it to the session
 * origin, so downstream spans (`persistence.onStoreDocument`,
 * `shadow.commitWip`, etc.) can parent back to the original browser trace.
 *
 * This is additive — when OTel is disabled the helper returns the URL
 * unchanged.
 */
import { context, propagation } from '@opentelemetry/api';

/**
 * Append `traceparent=<current>` and (if present) `tracestate=<current>` to
 * the collab URL.
 *
 * The propagator defaults to W3CTraceContextPropagator, set by the
 * WebTracerProvider's `register()` call in `src/telemetry.ts`.
 */
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
