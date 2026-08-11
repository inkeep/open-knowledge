import type { ValidationDocResult } from '@inkeep/open-knowledge-core';
import { t } from '@lingui/core/macro';

type Diagnostic = ValidationDocResult['diagnostics'][number];

/** Localize structured local-target findings without parsing server prose. */
export function localizedValidationMessage(diagnostic: Diagnostic): string {
  const evidence = diagnostic.localTarget;
  if (diagnostic.source !== 'links' || evidence === undefined) return diagnostic.message;

  const shown = evidence.resolvedTarget ?? evidence.href;
  if (evidence.reason === 'unresolvable') {
    return evidence.role === 'image'
      ? t`Image target "${shown}" could not be resolved to a project-local file.`
      : t`Link target "${shown}" could not be resolved to a project-local target.`;
  }
  if (evidence.targetKind === 'file') {
    return evidence.role === 'image'
      ? t`Image target "${shown}" does not resolve to an existing file.`
      : t`Link target "${shown}" does not resolve to an existing file.`;
  }
  return t`Link target "${shown}" does not resolve to an existing document.`;
}
