import { LINT_PLUGINS, type LinterConfig } from './plugins.ts';
import type { LintDiagnostic } from './types.ts';

export async function lintDocument(
  text: string,
  config: LinterConfig,
  docName?: string,
): Promise<LintDiagnostic[]> {
  if (!config.enabled) return [];
  const diagnostics: LintDiagnostic[] = [];
  for (const plugin of LINT_PLUGINS) {
    const slice = config.plugins[plugin.id];
    if (!slice.enabled) continue;
    diagnostics.push(
      ...(await plugin.lint(text, slice as Parameters<typeof plugin.lint>[1], { docName })),
    );
  }
  return diagnostics;
}

export function fixDocument(text: string, config: LinterConfig): string {
  if (!config.enabled) return text;
  let out = text;
  for (const plugin of LINT_PLUGINS) {
    const slice = config.plugins[plugin.id];
    if (!slice.enabled || !plugin.fix) continue;
    out = plugin.fix(out, slice as Parameters<NonNullable<typeof plugin.fix>>[1]);
  }
  return out;
}

export {
  type LintAuditResponse,
  LintAuditResponseSchema,
  type LintConfigResponse,
  LintConfigResponseSchema,
  type LintDocResult,
  LintDocResultSchema,
  LinterConfigSchema,
  type LintFixRequest,
  LintFixRequestSchema,
  type LintFixResult,
  LintFixResultSchema,
  MarkdownlintRuleWriteRequestSchema,
  type PersistedLinterConfig,
  toEffectiveBase,
} from './config-schemas.ts';
export { DEFAULT_MARKDOWNLINT_CONFIG, resolveMarkdownlintConfig } from './default-config.ts';
export { fixMarkdownText, runMarkdownlint } from './markdownlint-runner.ts';
export {
  DEFAULT_LINTER_CONFIG,
  LINT_PLUGINS,
  type LinterConfig,
  type LintPlugin,
  type LintPluginId,
} from './plugins.ts';
export { canonicalRuleId, findRuleConfigEntry } from './rule-aliases.ts';
export { MARKDOWNLINT_RULE_CATALOG } from './rule-catalog.generated.ts';
export {
  displayCategoryForRule,
  RULE_DISPLAY_CATEGORIES,
  type RuleDisplayCategory,
} from './rule-catalog-categories.ts';
export { applyTextEdits } from './text-edits.ts';
export type {
  LintDiagnostic,
  LintPosition,
  LintRange,
  LintSeverity,
  LintTextEdit,
  MarkdownlintRuleSetting,
  MarkdownlintRuleSeverity,
  MarkdownlintRuleWriteValue,
  MarkdownlintSlice,
  RuleCatalogEntry,
  RuleOptionSpec,
  RuleOptionType,
} from './types.ts';
