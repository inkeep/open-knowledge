import { z } from 'zod';
import { agentIdentityFields, safeDocNameField, summaryField } from '../../schemas/api/_shared.ts';
import { DEFAULT_MARKDOWNLINT_CONFIG } from './default-config.ts';
import { LINT_PLUGINS, type LinterConfig } from './plugins.ts';
import type { MarkdownlintRuleSetting } from './types.ts';

interface PersistedMarkdownlintSlice {
  enabled: boolean;
  rules?: Record<string, MarkdownlintRuleSetting>;
}
export interface PersistedLinterConfig {
  enabled?: boolean;
  markdownlint: PersistedMarkdownlintSlice;
}

export function toEffectiveBase(persisted: PersistedLinterConfig): LinterConfig {
  return {
    enabled: persisted.enabled ?? true,
    plugins: {
      markdownlint: {
        ...persisted.markdownlint,
        rules: persisted.markdownlint.rules ?? DEFAULT_MARKDOWNLINT_CONFIG,
      },
    },
  };
}

const fullPluginShape = Object.fromEntries(
  LINT_PLUGINS.map((plugin) => [plugin.id, plugin.sliceSchema]),
) as z.ZodRawShape;


export const LinterConfigSchema = z.object({
  enabled: z.boolean(),
  plugins: z.object(fullPluginShape),
}) as unknown as z.ZodType<LinterConfig>;

export const LintConfigResponseSchema = z.object({
  effective: LinterConfigSchema,
  configFile: z.string().nullable().optional(),
  configProblems: z.array(z.string()).optional(),
});

const MarkdownlintRuleWriteValueSchema = z.union([z.boolean(), z.record(z.string(), z.unknown())]);

export const MarkdownlintRuleWriteRequestSchema = z.object({
  ruleId: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[A-Za-z][A-Za-z0-9_-]*$/),
  value: z.union([MarkdownlintRuleWriteValueSchema, z.null()]),
});

export type LintConfigResponse = z.infer<typeof LintConfigResponseSchema>;

const LintPositionSchema = z.object({ line: z.number(), character: z.number() });
const LintRangeSchema = z.object({ start: LintPositionSchema, end: LintPositionSchema });

const LintDiagnosticSchema = z.object({
  range: LintRangeSchema,
  severity: z.enum(['error', 'warning', 'info', 'hint']),
  source: z.string(),
  code: z.string(),
  message: z.string(),
  fixes: z.array(z.object({ range: LintRangeSchema, newText: z.string() })).optional(),
});

export const LintDocResultSchema = z.object({
  file: z.string(),
  diagnostics: z.array(LintDiagnosticSchema),
});

export const LintAuditResponseSchema = z.object({
  files: z.array(LintDocResultSchema),
  fileCount: z.number(),
  errorCount: z.number(),
  warningCount: z.number(),
  warnings: z.array(z.string()),
});

export type LintDocResult = z.infer<typeof LintDocResultSchema>;
export type LintAuditResponse = z.infer<typeof LintAuditResponseSchema>;

export const LintFixRequestSchema = z
  .object({
    docName: safeDocNameField,
    summary: summaryField,
    ...agentIdentityFields,
  })
  .loose();
export type LintFixRequest = z.infer<typeof LintFixRequestSchema>;

export const LintFixResultSchema = z.object({
  file: z.string(),
  fixedCount: z.number(),
  diagnostics: z.array(LintDiagnosticSchema),
  errorCount: z.number(),
  warningCount: z.number(),
  warning: z.string().optional(),
});
export type LintFixResult = z.infer<typeof LintFixResultSchema>;
