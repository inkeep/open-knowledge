import { z } from 'zod';
import { agentIdentityFields, safeDocNameField, summaryField } from '../../schemas/api/_shared.ts';
import { LocalTargetDiagnosticEvidenceSchema } from '../../schemas/api/agent-write.ts';
import { DEFAULT_MARKDOWNLINT_CONFIG } from './default-config.ts';
import { LINT_PLUGINS, type LinterConfig } from './plugins.ts';
import type { FrontmatterSchemaMapping, MarkdownlintRuleSetting } from './types.ts';

interface PersistedMarkdownlintSlice {
  enabled: boolean;
  rules?: Record<string, MarkdownlintRuleSetting>;
}
interface PersistedFrontmatterSlice {
  enabled: boolean;
  schemas?: FrontmatterSchemaMapping[];
}
export interface PersistedLinterConfig {
  enabled?: boolean;
  markdownlint: PersistedMarkdownlintSlice;
  frontmatter?: PersistedFrontmatterSlice;
}

export function toEffectiveBase(persisted: PersistedLinterConfig): LinterConfig {
  return {
    enabled: persisted.enabled ?? true,
    plugins: {
      markdownlint: {
        ...persisted.markdownlint,
        rules: persisted.markdownlint.rules ?? DEFAULT_MARKDOWNLINT_CONFIG,
      },
      frontmatter: {
        enabled: persisted.frontmatter?.enabled ?? false,
        schemas: persisted.frontmatter?.schemas ?? [],
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

export const FrontmatterSchemaWriteRequestSchema = z
  .object({
    file: z.string().min(1).max(512),
    delete: z.literal(true).optional(),
    field: z.string().min(1).max(256).optional(),
    parentPath: z
      .array(z.union([z.string().min(1).max(256), z.object({ items: z.literal(true) }).strict()]))
      .max(8)
      .optional(),
    removeField: z.literal(true).optional(),
    renameTo: z.string().min(1).max(256).optional(),
    constraint: z
      .object({
        type: z.enum(['string', 'number', 'boolean', 'array', 'object']).nullable().optional(),
        enum: z
          .array(z.union([z.string(), z.number(), z.boolean()]))
          .nullable()
          .optional(),
        itemsEnum: z
          .array(z.union([z.string(), z.number(), z.boolean()]))
          .nullable()
          .optional(),
        itemsType: z.enum(['string', 'number', 'boolean', 'object']).nullable().optional(),
        pattern: z.string().nullable().optional(),
        format: z.string().nullable().optional(),
        description: z.string().max(2048).nullable().optional(),
        required: z.boolean().optional(),
      })
      .optional(),
  })
  .refine(
    (body) =>
      body.delete === undefined ||
      (body.field === undefined &&
        body.constraint === undefined &&
        body.removeField === undefined &&
        body.renameTo === undefined),
    { message: 'delete cannot be combined with a field edit' },
  )
  .refine(
    (body) =>
      [body.constraint, body.removeField, body.renameTo].filter((v) => v !== undefined).length <= 1,
    { message: 'constraint, removeField, and renameTo are mutually exclusive' },
  )
  .refine(
    (body) =>
      (body.removeField === undefined && body.renameTo === undefined) || body.field !== undefined,
    {
      message: 'removeField and renameTo require field',
    },
  )
  .refine((body) => body.parentPath === undefined || body.field !== undefined, {
    message: 'parentPath requires field',
  })
  .refine(
    (body) =>
      body.field === undefined
        ? body.constraint === undefined
        : body.constraint !== undefined ||
          body.removeField !== undefined ||
          body.renameTo !== undefined,
    { message: 'field requires constraint, removeField, or renameTo' },
  );
export type FrontmatterSchemaWriteRequest = z.infer<typeof FrontmatterSchemaWriteRequestSchema>;

export const FrontmatterSchemasListSuccessSchema = z
  .object({
    schemas: z.array(z.string()),
    truncated: z.boolean(),
  })
  .strict();
export type FrontmatterSchemasListSuccess = z.infer<typeof FrontmatterSchemasListSuccessSchema>;

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
  frontmatterScope: z.enum(['missing', 'invalid']).optional(),
  frontmatterProperty: z.string().optional(),
});

export const LintDocResultSchema = z.object({
  file: z.string(),
  diagnostics: z.array(LintDiagnosticSchema),
  warnings: z.array(z.string()).optional(),
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

const ValidationDiagnosticSchema = LintDiagnosticSchema.extend({
  linkTarget: z.string().optional(),
  localTarget: LocalTargetDiagnosticEvidenceSchema.optional(),
});

export const ValidationDocResultSchema = z.object({
  file: z.string(),
  diagnostics: z.array(ValidationDiagnosticSchema),
});

export const ValidationAuditResponseSchema = z.object({
  files: z.array(ValidationDocResultSchema),
  fileCount: z.number(),
  errorCount: z.number(),
  warningCount: z.number(),
  warnings: z.array(z.string()),
});

export type ValidationDocResult = z.infer<typeof ValidationDocResultSchema>;
export type ValidationAuditResponse = z.infer<typeof ValidationAuditResponseSchema>;

const ValidationSourceCountsSchema = z.object({
  errorCount: z.number().int().nonnegative(),
  warningCount: z.number().int().nonnegative(),
});

export const ValidationDocCountsSchema = z.object({
  file: z.string(),
  lint: ValidationSourceCountsSchema,
  links: ValidationSourceCountsSchema,
});

export const ValidationAuditCountsResponseSchema = z.object({
  files: z.array(ValidationDocCountsSchema),
  fileCount: z.number().int().nonnegative(),
  errorCount: z.number().int().nonnegative(),
  warningCount: z.number().int().nonnegative(),
  warnings: z.array(z.string()),
});

export type ValidationDocCounts = z.infer<typeof ValidationDocCountsSchema>;
export type ValidationAuditCountsResponse = z.infer<typeof ValidationAuditCountsResponseSchema>;

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
