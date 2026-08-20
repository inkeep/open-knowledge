import type { Configuration } from 'markdownlint';
import type { MarkdownlintRuleSetting } from './types.ts';

export const DEFAULT_MARKDOWNLINT_CONFIG: Record<string, MarkdownlintRuleSetting> = {
  default: true,
  MD013: false,
};


export function resolveMarkdownlintConfig(
  rules: Record<string, MarkdownlintRuleSetting> | undefined,
): Configuration {
  return rules ?? DEFAULT_MARKDOWNLINT_CONFIG;
}
