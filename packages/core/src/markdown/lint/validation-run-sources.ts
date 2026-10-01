import { isLintPluginSelected, LINT_PLUGINS, type LinterConfig } from './plugins.ts';
import type { LinksValidationSetting, LintPluginId, ValidationSource } from './types.ts';

export type ValidationRunMode =
  | { mode: 'lint' }
  | { mode: 'audit'; linksValidation: LinksValidationSetting };

export function deriveValidationRunSources(
  config: LinterConfig,
  run: { mode: 'lint' },
): LintPluginId[];
export function deriveValidationRunSources(
  config: LinterConfig,
  run: ValidationRunMode,
): ValidationSource[];
export function deriveValidationRunSources(
  config: LinterConfig,
  run: ValidationRunMode,
): ValidationSource[] {
  const sources: ValidationSource[] = LINT_PLUGINS.filter((plugin) =>
    isLintPluginSelected(config, plugin.id),
  ).map((plugin) => plugin.id);

  if (run.mode === 'audit' && run.linksValidation !== 'off') sources.push('links');
  return sources;
}

export const AUDIT_EMPTY_SCOPE_WARNING =
  'No documents were checked: this scope contains no admitted documents.';

export function isAuditEmptyScopeWarning(warning: string): boolean {
  return warning === AUDIT_EMPTY_SCOPE_WARNING;
}

export function validationCoverageLines(
  ran: readonly string[] | undefined,
  fileCount?: number,
): string[] {
  if (fileCount === 0) {
    return ran !== undefined && ran.length > 0
      ? [`Checks selected: ${ran.join(', ')}; no document checks ran.`]
      : ['No document checks ran.'];
  }
  if (ran === undefined) return [];
  if (ran.length === 0) return ['No checks ran.'];
  return [`Checks run: ${ran.join(', ')}.`];
}
