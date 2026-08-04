export interface ValidationSourceCounts {
  errorCount: number;
  warningCount: number;
}

export interface ValidationCountsBySource {
  lint: ValidationSourceCounts;
  links: ValidationSourceCounts;
}

interface CountableDiagnostic {
  severity: string;
  source: string;
}

export type ValidationSourceKey = keyof ValidationCountsBySource;

export const ZERO_SOURCE_COUNTS = {
  errorCount: 0,
  warningCount: 0,
} as const satisfies ValidationSourceCounts;

export function countDiagnosticsBySource(
  diagnostics: readonly CountableDiagnostic[],
): ValidationCountsBySource {
  const counts: ValidationCountsBySource = {
    lint: { errorCount: 0, warningCount: 0 },
    links: { errorCount: 0, warningCount: 0 },
  };
  for (const diagnostic of diagnostics) {
    const bucket = diagnostic.source === 'links' ? counts.links : counts.lint;
    if (diagnostic.severity === 'error') bucket.errorCount += 1;
    else bucket.warningCount += 1;
  }
  return counts;
}
