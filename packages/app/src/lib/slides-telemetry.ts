import { trace } from '@opentelemetry/api';

const TRACER_NAME = 'open-knowledge-app';

function emitMarker(name: string): void {
  try {
    trace.getTracer(TRACER_NAME).startSpan(name).end();
  } catch (err) {
    console.warn('[slides-telemetry] span emit failed:', err instanceof Error ? err : String(err));
  }
}

export function recordSlidesOpened(): void {
  emitMarker('ok.slides.opened');
}
