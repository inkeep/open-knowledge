import type { HocuspocusProvider } from '@hocuspocus/provider';
import {
  isFrontmatterScoped,
  LINT_PLUGINS,
  type LintDiagnostic,
  type LinterConfig,
  selectFrontmatterOnlyConfig,
} from '@inkeep/open-knowledge-core';
import { useDocDiagnostics } from './useDocDiagnostics.ts';

export function partitionFrontmatterProblems(diagnostics: readonly LintDiagnostic[]): {
  missing: LintDiagnostic[];
  invalid: LintDiagnostic[];
} {
  const missing: LintDiagnostic[] = [];
  const invalid: LintDiagnostic[] = [];
  const named = new Set<string>();
  const stated = new Set<string>();
  for (const diagnostic of diagnostics) {
    if (!isFrontmatterScoped(diagnostic)) continue;
    if (diagnostic.frontmatterScope !== 'missing') {
      if (stated.has(diagnostic.message)) continue;
      stated.add(diagnostic.message);
      invalid.push(diagnostic);
      continue;
    }
    const property = diagnostic.frontmatterProperty;
    if (property !== undefined && property !== '') {
      if (named.has(property)) continue;
      named.add(property);
    }
    missing.push(diagnostic);
  }
  return { missing, invalid };
}

export function useFrontmatterDiagnostics(
  provider: HocuspocusProvider | null,
  config: LinterConfig | null,
): LintDiagnostic[] {
  const active =
    config?.enabled === true &&
    LINT_PLUGINS.some(
      (plugin) => plugin.frontmatter !== undefined && config.plugins[plugin.id]?.enabled === true,
    );
  const diagnostics = useDocDiagnostics(
    provider,
    active && config ? selectFrontmatterOnlyConfig(config) : null,
  );
  return diagnostics.filter(isFrontmatterScoped);
}
