export function initFrontendTelemetry(): void {
  const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env;
  if (env?.VITE_OTEL_ENABLED !== 'true') return;
  void import('./telemetry-impl').then((m) => m.install());
}
