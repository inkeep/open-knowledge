import { MARKDOWNLINT_RULE_CATALOG } from './rule-catalog.generated.ts';

const keyToCanonicalId: ReadonlyMap<string, string> = (() => {
  const map = new Map<string, string>();
  for (const entry of MARKDOWNLINT_RULE_CATALOG) {
    map.set(entry.id.toUpperCase(), entry.id);
    for (const alias of entry.aliases) {
      map.set(alias.toUpperCase(), entry.id);
    }
  }
  return map;
})();

export function canonicalRuleId(key: string): string | null {
  return keyToCanonicalId.get(key.toUpperCase()) ?? null;
}

interface RuleConfigEntry {
  key: string;
  value: unknown;
}

export function findRuleConfigEntry(
  rules: Readonly<Record<string, unknown>>,
  ruleId: string,
): RuleConfigEntry | undefined {
  const canonical = canonicalRuleId(ruleId);
  if (canonical === null) return undefined;
  let found: RuleConfigEntry | undefined;
  for (const [key, value] of Object.entries(rules)) {
    if (canonicalRuleId(key) === canonical) {
      found = { key, value };
    }
  }
  return found;
}
