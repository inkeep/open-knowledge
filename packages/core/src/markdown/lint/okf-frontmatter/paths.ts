
import type { OkfRuleId } from '../okf-rule-meta.ts';

export const OKF_SCHEMA_DIR = '.ok/okf';

export function fileNameFor(ruleId: OkfRuleId): string {
  return `${ruleId.replace(/^frontmatter-/, '')}.schema.json`;
}

export function okfSchemaPathFor(ruleId: OkfRuleId): string {
  return `${OKF_SCHEMA_DIR}/${fileNameFor(ruleId)}`;
}
