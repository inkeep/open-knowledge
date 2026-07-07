/**
 * Test-time override for numeric knobs that govern cache / pool / activity
 * sizing. Lets perf scenarios sweep values without rebuilding.
 *
 * Two input channels, checked in order:
 *
 * 1. `window.__okPerfOverrides?.[key]` — set by Playwright scenarios via
 *    `page.addInitScript` before any page JS runs, or by a human pasting in
 *    DevTools before navigating. Preferred for scenario sweeps.
 *
 * 2. `import.meta.env.VITE_OK_PERF_<KEY>` — set at `bun run dev` time for
 *    local testing (e.g. `VITE_OK_PERF_BYTES_CACHE_THRESHOLD=10000000 bun run
 *    dev`). Uses the `VITE_` prefix so Vite's default envPrefix admits it.
 *
 * Production builds return the default immediately. `import.meta.env.PROD`
 * is replaced at build time with a literal boolean by Vite, so the
 * override-reader body is unreachable in production and is a candidate for
 * tree-shaking. (Using `PROD` rather than `DEV` so Bun-test contexts, where
 * `import.meta.env.DEV` is undefined, still exercise the override logic.)
 *
 * Warns once per overridden key at startup so the override is visible in
 * dev-server output / test logs.
 */

type PerfOverrideKey =
  | 'BYTES_CACHE_THRESHOLD'
  | 'VIEW_COUNT_CACHE_THRESHOLD'
  | 'MAX_CACHE'
  | 'ACTIVITY_MOUNT_LIMIT'
  | 'LARGE_DOC_CHAR_THRESHOLD'
  | 'MAX_POOL'
  | 'SYNC_TIMEOUT_MS'
  | 'MAX_BUFFER_BYTES'
  | 'MOUNT_STALLED_THRESHOLD_MS'
  | 'HOVER_INTENT_MS'
  | 'MAX_RING_ENTRIES'
  | 'MAX_VITALS_RING_ENTRIES'
  | 'MAX_HISTOGRAM_PRECISION'
  | 'BURST_DEBOUNCE_MS'
  | 'PREWARM_CORRELATION_WINDOW_MS';

export type { PerfOverrideKey };

declare global {
  interface Window {
    __okPerfOverrides?: Partial<Record<PerfOverrideKey, number>>;
  }
}

const warned = new Set<PerfOverrideKey>();

function warnOnce(key: PerfOverrideKey, value: number, source: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  // Intentional console.warn — visible in dev-server and Playwright traces.
  console.warn(`[perf-override] ${key} = ${value} (via ${source})`);
}

export function readNumericOverride(key: PerfOverrideKey, defaultValue: number): number {
  if (import.meta.env.PROD === true) return defaultValue;

  if (typeof window !== 'undefined') {
    const fromWindow = window.__okPerfOverrides?.[key];
    if (typeof fromWindow === 'number' && Number.isFinite(fromWindow)) {
      warnOnce(key, fromWindow, 'window.__okPerfOverrides');
      return fromWindow;
    }
  }

  const envName = `VITE_OK_PERF_${key}` as const;
  const fromEnv = (import.meta.env as Record<string, string | undefined>)[envName];
  if (typeof fromEnv === 'string' && fromEnv.length > 0) {
    const parsed = Number(fromEnv);
    if (Number.isFinite(parsed)) {
      warnOnce(key, parsed, `import.meta.env.${envName}`);
      return parsed;
    }
    console.warn(
      `[perf-override] ${envName}=${JSON.stringify(fromEnv)} is not numeric; falling back to default ${defaultValue}`,
    );
  }

  return defaultValue;
}

/**
 * Test-only: reset the warn-once cache between test runs so overrides from
 * prior tests don't silently suppress expected warnings. Not exported from
 * the perf index — import directly if needed in a test file.
 */
export function resetPerfOverrideWarnings(): void {
  warned.clear();
}
