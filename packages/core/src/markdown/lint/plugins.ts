
import { z } from 'zod';
import { DEFAULT_MARKDOWNLINT_CONFIG, resolveMarkdownlintConfig } from './default-config.ts';
import { fixMarkdownText, runMarkdownlint } from './markdownlint-runner.ts';
import {
  type LintDiagnostic,
  type LintPluginId,
  MARKDOWNLINT_RULE_SEVERITIES,
  type MarkdownlintSlice,
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

export const LINT_PLUGINS = [markdownlintPlugin] as const;

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
