/**
 * Slides (Slidev) adoption telemetry — the renderer-side half.
 *
 * Emits one marker span when the user opens a document as slides — the adoption
 * and retention signal for whether the surface earns its keep. Shares the
 * `ok.slides.*` namespace with the main-side deck-open lifecycle span
 * (`packages/desktop/src/main/slides-telemetry.ts`) so both read as one family
 * across the two tracers.
 *
 * `@opentelemetry/api` returns a no-op tracer when no SDK is registered, so this
 * is zero-cost unless `VITE_OTEL_ENABLED='true'`. The marker carries no
 * attributes — no document name, no path, no content.
 */
import { trace } from '@opentelemetry/api';

const TRACER_NAME = 'open-knowledge-app';

/**
 * Emit a single zero-duration marker span, containing any opt-in OTel SDK fault
 * (a `startSpan`/`end` throw from a misconfigured provider or a flush-while-
 * shutdown race — `@opentelemetry/api` is a third-party boundary that can
 * genuinely throw) so it can never escape the user-action handler and surface as
 * a UI crash. Mirrors the fault-isolation wrap in `lib/terminal-telemetry.ts`.
 */
function emitMarker(name: string): void {
  try {
    trace.getTracer(TRACER_NAME).startSpan(name).end();
  } catch (err) {
    console.warn('[slides-telemetry] span emit failed:', err instanceof Error ? err : String(err));
  }
}

/** User opened a document as slides — Slides adoption. */
export function recordSlidesOpened(): void {
  emitMarker('ok.slides.opened');
}
