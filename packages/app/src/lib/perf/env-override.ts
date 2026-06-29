
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

export function resetPerfOverrideWarnings(): void {
  warned.clear();
}
