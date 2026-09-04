import { trace } from '@opentelemetry/api';
import type { ColorThemeSelection } from './color-themes';

const TRACER_NAME = 'open-knowledge-app';

export type SavedThemePairState = 'different' | 'incomplete' | 'same';

export function savedThemePairState(selection: ColorThemeSelection): SavedThemePairState {
  const lightSaved = selection.light.startsWith('saved-');
  const darkSaved = selection.dark.startsWith('saved-');
  if (!lightSaved || !darkSaved) return 'incomplete';
  return selection.light === selection.dark ? 'same' : 'different';
}

export function recordSavedThemeAssignment(selection: ColorThemeSelection): void {
  try {
    trace
      .getTracer(TRACER_NAME)
      .startSpan('ok.saved_themes.assignment', {
        attributes: { 'saved_theme.pair': savedThemePairState(selection) },
      })
      .end();
  } catch (err) {
    console.warn(
      '[saved-theme-telemetry] assignment span emit failed:',
      err instanceof Error ? err : String(err),
    );
  }
}
