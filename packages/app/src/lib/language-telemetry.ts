import type { LanguagePreference } from '@inkeep/open-knowledge-core';
import { trace } from '@opentelemetry/api';

const TRACER_NAME = 'open-knowledge-app';

export function recordLanguagePreferenceChanged({
  from,
  to,
}: {
  from: LanguagePreference;
  to: LanguagePreference;
}): void {
  try {
    trace
      .getTracer(TRACER_NAME)
      .startSpan('ok.language.preferenceChanged', {
        attributes: { 'ok.language.from': from, 'ok.language.to': to },
      })
      .end();
  } catch (err) {
    console.warn(
      '[language-telemetry] span emit failed:',
      err instanceof Error ? err : String(err),
    );
  }
}
