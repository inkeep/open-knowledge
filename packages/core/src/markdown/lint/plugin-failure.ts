import type { LintPluginId } from './types.ts';

export interface LintPluginFailure {
  source: LintPluginId;
  phase: 'lint' | 'fix';
  docName?: string;
  message: string;
}

export type LintPluginFailureReporter = (failure: LintPluginFailure) => void;

function lintPluginFailurePrefix(failure: LintPluginFailure): string {
  return `source "${failure.source}" ${failure.phase} failed`;
}

export function formatLintPluginFailure(failure: LintPluginFailure): string {
  const location = failure.docName === undefined ? '' : ` on "${failure.docName}"`;
  return `${lintPluginFailurePrefix(failure)}${location}: ${failure.message}`;
}

export function summarizeLintPluginFailures(failures: readonly LintPluginFailure[]): string[] {
  const byFault = new Map<string, { first: LintPluginFailure; docNames: Set<string> }>();
  for (const failure of failures) {
    const key = [failure.source, failure.phase, failure.message].join('\u0000');
    const seen = byFault.get(key) ?? { first: failure, docNames: new Set<string>() };
    if (failure.docName !== undefined) seen.docNames.add(failure.docName);
    byFault.set(key, seen);
  }
  return [...byFault.values()].map(({ first, docNames }) => {
    if (docNames.size <= 1) return formatLintPluginFailure(first);
    return `${lintPluginFailurePrefix(first)} on ${docNames.size} documents (first: "${first.docName}"): ${first.message}`;
  });
}
