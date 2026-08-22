import { isOkfRuleEnabled, type OkfRuleId, type OkfRuleToggles } from './okf-rule-meta.ts';
import type { OkfRule } from './okf-runner.ts';
import { indexShape } from './rules/index-shape.ts';
import { logShape } from './rules/log-shape.ts';
import { noWikiLinks } from './rules/no-wiki-links.ts';
import { reservedCasing } from './rules/reserved-casing.ts';

interface OkfRuleEntry {
  readonly id: OkfRuleId;
  readonly rule: OkfRule;
}

export const OKF_RULE_REGISTRY: readonly OkfRuleEntry[] = [
  { id: 'no-wiki-links', rule: noWikiLinks },
  { id: 'log-shape', rule: logShape },
  { id: 'index-shape', rule: indexShape },
  { id: 'reserved-casing', rule: reservedCasing },
];

const ALL_OKF_RULES: readonly OkfRule[] = OKF_RULE_REGISTRY.map((entry) => entry.rule);

export function selectEnabledOkfRules(rules: OkfRuleToggles): readonly OkfRule[] {
  if (rules === undefined) return ALL_OKF_RULES;
  return OKF_RULE_REGISTRY.filter((entry) => isOkfRuleEnabled(rules, entry.id)).map(
    (entry) => entry.rule,
  );
}
