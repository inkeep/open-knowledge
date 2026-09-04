import type { LintDiagnostic } from '@inkeep/open-knowledge-core';

export const SKILL_RESERVED_KEYS = ['name'] as const;

export const NO_RESERVED_KEYS: readonly string[] = [];

export function withoutReservedProperties(
  diagnostics: readonly LintDiagnostic[],
  reservedKeys: readonly string[],
): readonly LintDiagnostic[] {
  if (reservedKeys.length === 0) return diagnostics;
  const reserved = new Set(reservedKeys);
  return diagnostics.filter(
    (diagnostic) =>
      diagnostic.frontmatterProperty === undefined || !reserved.has(diagnostic.frontmatterProperty),
  );
}
