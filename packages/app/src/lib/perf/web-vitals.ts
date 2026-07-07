/**
 * `initWebVitals()` — subscribe to INP / LCP / CLS / FCP via the `web-vitals`
 * library (v5+ attribution build) and emit each as an `ok/vitals/<lower>`
 * mark.
 *
 * Dev-only init. Guard at the call site in `main.tsx` with
 * `if (import.meta.env.DEV) initWebVitals()`. The library itself is a
 * devDependency; it won't appear in production bundles.
 */

import { recordVital } from './collector';
import { mark } from './mark';
import type { WebVitalName, WebVitalsMark } from './types';

/**
 * The web-vitals library emits union types per metric
 * (`INPMetricWithAttribution`, `LCPMetricWithAttribution`, ...). Accept all of
 * them via a structural minimum and narrow the attribution payload at the
 * `unknown` boundary — our consumers treat it opaquely.
 */
interface LibMetricLike {
  name: string;
  value: number;
  rating: 'good' | 'needs-improvement' | 'poor';
  delta: number;
  id: string;
  navigationType?: string;
  attribution?: unknown;
}

function handleMetric(metric: LibMetricLike): void {
  const normalized: WebVitalsMark = {
    name: metric.name as WebVitalName,
    value: metric.value,
    rating: metric.rating,
    delta: metric.delta,
    id: metric.id,
    ...(metric.navigationType ? { navigationType: metric.navigationType } : {}),
    ...(metric.attribution ? { attribution: metric.attribution as Record<string, unknown> } : {}),
  };
  recordVital(normalized);
  mark(`ok/vitals/${metric.name.toLowerCase()}`, {
    value: Math.round(metric.value * 1000) / 1000,
    rating: metric.rating,
    delta: metric.delta,
    id: metric.id,
  });
}

/**
 * Initialize web-vitals subscriptions. Idempotent — multiple calls return
 * without re-subscribing. Dynamic import so non-dev callers don't pull
 * the library into their chunks.
 */
let initialized = false;

export async function initWebVitals(): Promise<void> {
  if (initialized) return;
  initialized = true;
  if (typeof window === 'undefined') return;
  try {
    const { onINP, onLCP, onCLS, onFCP } = await import('web-vitals/attribution');
    onINP(handleMetric);
    onLCP(handleMetric);
    onCLS(handleMetric);
    onFCP(handleMetric);
  } catch (err) {
    // web-vitals is a devDependency; fail quietly in prod builds that
    // somehow still invoke this path (should be dead code).
    if (!import.meta.env?.PROD) {
      // eslint-disable-next-line no-console
      console.warn('[perf] web-vitals init failed', err);
    }
  }
}

/** Test-only reset — exported for unit tests. */
export function __resetWebVitalsForTests(): void {
  initialized = false;
}
