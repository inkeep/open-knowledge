
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
    diagnostics.push(...(await plugin.lint(text, slice as never, { docName })));
  }
  return diagnostics;
}

export function fixDocument(text: string, config: LinterConfig): string {
  if (!config.enabled) return text;
  let out = text;
  for (const plugin of LINT_PLUGINS) {
    const slice = config.plugins[plugin.id];
    if (!slice.enabled || !plugin.fix) continue;
    out = plugin.fix(out, slice as never);
  }
  return out;
}

export {
  type AppliesToPatternSummary,
  type AppliesToSummary,
  type CompiledAppliesTo,
  compileAppliesTo,
  findZeroMatchAppliesToPatterns,
  summarizeAppliesTo,
} from './applies-to.ts';
export { isMarkdownlintJsonConfig } from './config-files.ts';
export {
  type FrontmatterSchemasListSuccess,
  FrontmatterSchemasListSuccessSchema,
  type FrontmatterSchemaWriteRequest,
  FrontmatterSchemaWriteRequestSchema,
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
  type ValidationAuditCountsResponse,
  ValidationAuditCountsResponseSchema,
  type ValidationAuditResponse,
  ValidationAuditResponseSchema,
  type ValidationDocCounts,
  ValidationDocCountsSchema,
  type ValidationDocResult,
  ValidationDocResultSchema,
} from './config-schemas.ts';
export { DEFAULT_MARKDOWNLINT_CONFIG, resolveMarkdownlintConfig } from './default-config.ts';
export {
  applyFieldConstraint,
  emptyFrontmatterSchemaText,
  type FrontmatterFieldConstraint,
  FrontmatterSchemaEditError,
  isFrontmatterSchemaAsset,
  isToolManagedSchemaPath,
  removeSchemaField,
  renameSchemaField,
  type SchemaParentPathSegment,
} from './frontmatter-schema-edit.ts';
export {
  CANONICAL_SCHEMA_DIALECT_URIS,
  DEFAULT_SCHEMA_DIALECT,
  type FrontmatterSchemaDialect,
  frontmatterSchemaCompileError,
  isSupportedSchemaDialect,
  resolveFrontmatterSchemaDialect,
  SUPPORTED_SCHEMA_DIALECTS,
  selectApplicableFrontmatterSchemas,
} from './frontmatter-validate.ts';
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
  FrontmatterSchemaMapping,
  FrontmatterSlice,
  LinksValidationSetting,
  LintDiagnostic,
  LintPosition,
  LintRange,
  LintSeverity,
  LintTextEdit,
  MarkdownlintRuleSetting,
  MarkdownlintRuleSeverity,
  MarkdownlintRuleWriteValue,
  MarkdownlintSlice,
  ResolvedFrontmatterSchemaEntry,
  RuleCatalogEntry,
  RuleOptionSpec,
  RuleOptionType,
  ValidationDiagnostic,
  ValidationSource,
} from './types.ts';
export { DEFAULT_LINKS_VALIDATION, LINKS_VALIDATION_SETTINGS } from './types.ts';
export {
  countDiagnosticsBySource,
  type ValidationCountsBySource,
  type ValidationSourceCounts,
  type ValidationSourceKey,
  ZERO_SOURCE_COUNTS,
} from './validation-counts.ts';
