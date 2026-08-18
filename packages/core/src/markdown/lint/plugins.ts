
import { z } from 'zod';
import { DEFAULT_MARKDOWNLINT_CONFIG, resolveMarkdownlintConfig } from './default-config.ts';
import {
  selectApplicableFrontmatterSchemas,
  validateFrontmatterSource,
} from './frontmatter-validate.ts';
import { fixMarkdownText, runMarkdownlint } from './markdownlint-runner.ts';
import { runOkfFrontmatterRules } from './okf-frontmatter/registry.ts';
import { selectEnabledOkfRules } from './okf-rules.ts';
import { runOkfRules } from './okf-runner.ts';
import {
  type FrontmatterSlice,
  type LintDiagnostic,
  type LintPluginId,
  MARKDOWNLINT_RULE_SEVERITIES,
  type MarkdownlintSlice,
  type OkfSlice,
} from './types.ts';


const MarkdownlintRuleSettingSchema = z.union([
  z.boolean(),
  z.enum(MARKDOWNLINT_RULE_SEVERITIES),
  z.record(z.string(), z.unknown()),
]);

export interface LintPlugin<Id extends LintPluginId, Slice> {
  id: Id;
  sliceSchema: z.ZodType<Slice>;
  defaultSlice: Slice;
  lint(text: string, slice: Slice, ctx: { docName?: string }): Promise<LintDiagnostic[]>;
  fix?(text: string, slice: Slice): string;
}

const markdownlintPlugin: LintPlugin<'markdownlint', MarkdownlintSlice> = {
  id: 'markdownlint',
  sliceSchema: z.object({
    enabled: z.boolean(),
    rules: z.record(z.string(), MarkdownlintRuleSettingSchema),
  }),
  defaultSlice: { enabled: false, rules: DEFAULT_MARKDOWNLINT_CONFIG },
  async lint(text, slice) {
    return runMarkdownlint(text, resolveMarkdownlintConfig(slice.rules));
  },
  fix(text, slice) {
    return fixMarkdownText(text, resolveMarkdownlintConfig(slice.rules));
  },
};

const FrontmatterSchemaEntrySchema = z.object({
  appliesTo: z.union([z.string(), z.array(z.string())]).optional(),
  file: z.string(),
  enabled: z.boolean().optional(),
  key: z.string().optional(),
  schema: z.record(z.string(), z.unknown()).optional(),
});

const frontmatterPlugin: LintPlugin<'frontmatter', FrontmatterSlice> = {
  id: 'frontmatter',
  sliceSchema: z.object({
    enabled: z.boolean(),
    schemas: z.array(FrontmatterSchemaEntrySchema),
  }),
  defaultSlice: { enabled: false, schemas: [] },
  async lint(text, slice, ctx) {
    return validateFrontmatterSource(
      text,
      selectApplicableFrontmatterSchemas(slice.schemas, ctx.docName),
    );
  },
};

const okfPlugin: LintPlugin<'okf', OkfSlice> = {
  id: 'okf',
  sliceSchema: z.object({
    enabled: z.boolean(),
    rules: z.record(z.string(), z.boolean()).optional(),
    generate: z.object({ index: z.boolean().optional() }).optional(),
  }),
  defaultSlice: { enabled: false },
  async lint(text, slice, ctx) {
    return [
      ...runOkfRules(text, selectEnabledOkfRules(slice.rules), ctx.docName),
      ...runOkfFrontmatterRules(text, slice.rules, ctx.docName),
    ];
  },
};

export const LINT_PLUGINS = [markdownlintPlugin, frontmatterPlugin, okfPlugin] as const;

type LintPluginEntry = (typeof LINT_PLUGINS)[number];

export type { LintPluginId };

export type LinterConfig = {
  enabled: boolean;
  plugins: {
    [K in LintPluginId]: Extract<LintPluginEntry, { id: K }> extends LintPlugin<K, infer S>
      ? S
      : never;
  };
};

export const DEFAULT_LINTER_CONFIG: LinterConfig = {
  enabled: true,
  plugins: Object.fromEntries(
    LINT_PLUGINS.map((plugin) => [plugin.id, plugin.defaultSlice]),
  ) as LinterConfig['plugins'],
};
