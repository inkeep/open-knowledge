import type { Counter, Histogram } from '@opentelemetry/api';
import { getMeter } from './telemetry.ts';

let saveCounter: Counter | null = null;
let deleteCounter: Counter | null = null;
let scanCounter: Counter | null = null;
let parseCounter: Counter | null = null;
let parseFailureCounter: Counter | null = null;
let usableCountHistogram: Histogram | null = null;

function savedThemeSaveCounter(): Counter {
  saveCounter ||= getMeter().createCounter('ok.saved_themes.save_total', {
    description: 'Successful saved-theme file saves. Attribute-free to keep cardinality bounded.',
  });
  return saveCounter;
}

function savedThemeDeleteCounter(): Counter {
  deleteCounter ||= getMeter().createCounter('ok.saved_themes.delete_total', {
    description:
      'Successful saved-theme file deletions. Attribute-free to keep cardinality bounded.',
  });
  return deleteCounter;
}

function savedThemeParseFailureCounter(): Counter {
  parseFailureCounter ||= getMeter().createCounter('ok.saved_themes.parse_failure_total', {
    description: 'Saved-theme scheme parse failures. Attribute-free to keep cardinality bounded.',
  });
  return parseFailureCounter;
}

function savedThemeScanCounter(): Counter {
  scanCounter ||= getMeter().createCounter('ok.saved_themes.scan_total', {
    description: 'Saved-theme store scans. Attribute-free to keep cardinality bounded.',
  });
  return scanCounter;
}

function savedThemeParseCounter(): Counter {
  parseCounter ||= getMeter().createCounter('ok.saved_themes.parse_total', {
    description: 'Saved-theme scheme parse attempts. Attribute-free to keep cardinality bounded.',
  });
  return parseCounter;
}

function savedThemeUsableCountHistogram(): Histogram {
  usableCountHistogram ||= getMeter().createHistogram('ok.saved_themes.usable_count', {
    description:
      'Usable saved themes returned by a completed bounded scan. Attribute-free to keep cardinality bounded.',
  });
  return usableCountHistogram;
}

export function recordSavedThemeSave(): void {
  savedThemeSaveCounter().add(1);
}

export function recordSavedThemeDelete(): void {
  savedThemeDeleteCounter().add(1);
}

export function recordSavedThemeScan(): void {
  savedThemeScanCounter().add(1);
}

export function recordSavedThemeParseAttempt(): void {
  savedThemeParseCounter().add(1);
}

export function recordSavedThemeParseFailure(): void {
  savedThemeParseFailureCounter().add(1);
}

export function recordSavedThemeUsableCount(count: number): void {
  savedThemeUsableCountHistogram().record(count);
}

/**
 * Drop cached lazy-init instruments so tests can bind them to a fresh global
 * MeterProvider. Production installs its provider once and never calls this.
 */
export function __resetSavedThemesTelemetryForTests(): void {
  saveCounter = null;
  deleteCounter = null;
  scanCounter = null;
  parseCounter = null;
  parseFailureCounter = null;
  usableCountHistogram = null;
}
