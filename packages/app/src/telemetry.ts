/**
 * Frontend OpenTelemetry init — lazy-loaded.
 *
 * The actual SDK code is in `telemetry-impl.ts` and loaded via dynamic
 * `import()` only when `VITE_OTEL_ENABLED === 'true'`. The lazy chunk
 * that ships in `dist/assets/telemetry-impl-*.js` is **~22 KB gzipped**
 * (~72 KB raw). Because Vite emits dynamic imports as separate chunks
 * by default, the file exists on disk for every build — but the runtime
 * cost is genuinely 0 KB when `VITE_OTEL_ENABLED` is not set: nothing
 * fetches the chunk. The bundle-check assertion pins both the chunk size
 * and the absence of `__ok_perf` / Histogram / typing-burst sentinels in
 * the main prod chunks.
 *
 * Called FIRST by `main.tsx`. Runs async but the promise is intentionally
 * fire-and-forget — no await. Subsequent module loads race against the
 * OTel init, which is fine: any spans emitted before init completes become
 * no-ops (trace API returns a NoopTracer when no provider is registered).
 */
export function initFrontendTelemetry(): void {
  const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env;
  if (env?.VITE_OTEL_ENABLED !== 'true') return;
  // Fire-and-forget. Failure is logged by the impl module and doesn't block
  // anything else — the tracer falls back to the no-op implementation.
  void import('./telemetry-impl').then((m) => m.install());
}
