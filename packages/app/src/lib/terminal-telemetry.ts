/**
 * Docked-terminal adoption telemetry — the renderer-side half.
 *
 * Emits the two renderer-originated signals as frontend OTel spans on the
 * `open-knowledge-app` tracer: the panel opening (adoption) and the user
 * granting shell consent (intent to run Claude Code in-app). Span names share
 * the `ok.desktop.*` convention with the main-side lifecycle spans
 * (`packages/desktop/src/main/terminal-telemetry.ts`) so the four terminal
 * events read as one family across the two tracers.
 *
 * `@opentelemetry/api` returns a no-op tracer when no SDK is registered, so
 * these are zero-cost unless `VITE_OTEL_ENABLED='true'`. Never captures command
 * contents or shell I/O — these are open/consent markers with no attributes.
 */
import { trace } from '@opentelemetry/api';

const TRACER_NAME = 'open-knowledge-app';

/**
 * Emit a single zero-duration marker span. Wrapped so an opt-in OTel SDK fault
 * (a `startSpan`/`end` throw from a misconfigured provider or a flush-while-
 * shutdown race — `@opentelemetry/api` is a third-party boundary that can
 * genuinely throw) cannot escape a React effect or a user-action handler and
 * surface as a UI crash. Mirrors the fault-isolation wrap in `lib/perf/otel-spans.ts`.
 */
function emitMarker(name: string): void {
  try {
    trace.getTracer(TRACER_NAME).startSpan(name).end();
  } catch (err) {
    console.warn(
      '[terminal-telemetry] span emit failed:',
      err instanceof Error ? err : String(err),
    );
  }
}

/** Panel opened — terminal adoption. */
export function recordTerminalOpened(): void {
  emitMarker('ok.desktop.terminalOpened');
}

/** Shell consent granted — intent to use Claude Code in-app. */
export function recordShellConsentGranted(): void {
  emitMarker('ok.desktop.shellConsentGranted');
}
