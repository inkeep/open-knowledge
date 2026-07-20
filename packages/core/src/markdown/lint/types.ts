export const LINT_PLUGIN_IDS = ['markdownlint'] as const;
export type LintPluginId = (typeof LINT_PLUGIN_IDS)[number];

export type LintSeverity = 'error' | 'warning' | 'info' | 'hint';

export interface LintPosition {
  line: number;
  character: number;
}

export interface LintRange {
  start: LintPosition;
  end: LintPosition;
}

export interface LintTextEdit {
  range: LintRange;
  newText: string;
}

export interface LintDiagnostic {
  range: LintRange;
  severity: LintSeverity;
  source: LintPluginId;
  code: string;
  message: string;
  fixes?: LintTextEdit[];
}

type MarkdownlintRuleParams = Record<string, unknown>;

export const MARKDOWNLINT_RULE_SEVERITIES = ['error', 'warning'] as const;
export type MarkdownlintRuleSeverity = (typeof MARKDOWNLINT_RULE_SEVERITIES)[number];

export type MarkdownlintRuleWriteValue = boolean | MarkdownlintRuleParams;

export type MarkdownlintRuleSetting = MarkdownlintRuleWriteValue | MarkdownlintRuleSeverity;

export interface MarkdownlintSlice {
  enabled: boolean;
  rules: Record<string, MarkdownlintRuleSetting>;
}

interface RuleOptionSpecBase {
  key: string;
  description: string;
}

export type RuleOptionSpec =
  | (RuleOptionSpecBase & { type: 'boolean'; default?: boolean })
  | (RuleOptionSpecBase & {
      type: 'integer';
      default?: number;
      minimum?: number;
      maximum?: number;
    })
  | (RuleOptionSpecBase & { type: 'string'; default?: string })
  | (RuleOptionSpecBase & { type: 'enum'; enum: readonly string[]; default?: string })
  | (RuleOptionSpecBase & { type: 'string-array'; default?: readonly string[] })
  | (RuleOptionSpecBase & { type: 'unsupported'; default?: unknown });

export type RuleOptionType = RuleOptionSpec['type'];

export interface RuleCatalogEntry {
  id: string;
  alias: string;
  aliases: readonly string[];
  name: string;
  docUrl: string;
  tags: readonly string[];
  options: readonly RuleOptionSpec[];
}
