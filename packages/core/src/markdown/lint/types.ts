
import type { BrokenLinkReason } from '../../schemas/api/agent-write.ts';

export const LINT_PLUGIN_IDS = ['markdownlint', 'frontmatter'] as const;
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
  frontmatterScope?: 'missing' | 'invalid';
  frontmatterProperty?: string;
}

const VALIDATION_SOURCES = [...LINT_PLUGIN_IDS, 'links'] as const;
export type ValidationSource = (typeof VALIDATION_SOURCES)[number];

export type LocalTargetKind = 'document' | 'file' | 'unknown';

export type LocalTargetRole = 'link' | 'image';

export type LocalTargetSourceForm = 'markdown-inline' | 'markdown-reference' | 'html-img';

export type LocalTargetResolutionMethod = 'source-relative' | 'root-relative' | 'tolerant' | 'none';

export interface LocalTargetDiagnosticEvidence extends Record<string, unknown> {
  href: string;
  targetKind: LocalTargetKind;
  role: LocalTargetRole;
  sourceForm: LocalTargetSourceForm;
  resolvedTarget: string | null;
  reason: BrokenLinkReason;
  resolutionMethod: LocalTargetResolutionMethod;
  fallbackTarget?: string;
  definition?: {
    [key: string]: unknown;
    line: number;
    label: string;
  };
}

export interface ValidationDiagnostic extends Omit<LintDiagnostic, 'source'> {
  source: ValidationSource;
  linkTarget?: string;
  localTarget?: LocalTargetDiagnosticEvidence;
}

export const LINKS_VALIDATION_SETTINGS = ['off', 'warning', 'error'] as const;
export type LinksValidationSetting = (typeof LINKS_VALIDATION_SETTINGS)[number];
export const DEFAULT_LINKS_VALIDATION: LinksValidationSetting = 'warning';

type MarkdownlintRuleParams = Record<string, unknown>;

export const MARKDOWNLINT_RULE_SEVERITIES = ['error', 'warning'] as const;
export type MarkdownlintRuleSeverity = (typeof MARKDOWNLINT_RULE_SEVERITIES)[number];

export type MarkdownlintRuleWriteValue = boolean | MarkdownlintRuleParams;

export type MarkdownlintRuleSetting = MarkdownlintRuleWriteValue | MarkdownlintRuleSeverity;

export interface MarkdownlintSlice {
  enabled: boolean;
  rules: Record<string, MarkdownlintRuleSetting>;
}

export interface FrontmatterSchemaMapping {
  appliesTo?: string | string[];
  file: string;
  enabled?: boolean;
}

export interface ResolvedFrontmatterSchemaEntry extends FrontmatterSchemaMapping {
  key?: string;
  schema?: Record<string, unknown>;
}

export interface FrontmatterSlice {
  enabled: boolean;
  schemas: ResolvedFrontmatterSchemaEntry[];
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
