import { compileAppliesTo } from '../applies-to.ts';
import { validateFrontmatterSource } from '../frontmatter-validate.ts';
import {
  isOkfRuleEnabled,
  OKF_RULE_IDS,
  type OkfRuleId,
  type OkfRuleToggles,
} from '../okf-rule-meta.ts';
import type { FrontmatterSchemaMapping, LintDiagnostic } from '../types.ts';
import { okfSchemaPathFor } from './paths.ts';
import {
  OKF_ATTESTED_COMPUTATION_SCHEMA,
  OKF_PROVENANCE_SCHEMA,
  OKF_RECOMMENDED_SCHEMA,
  OKF_REQUIRED_SCHEMA,
  OKF_RESERVED_INDEX_SCHEMA,
  OKF_ROOT_INDEX_SCHEMA,
} from './schemas.ts';

const CONCEPT_SCOPE = ['**', '!**/{index,log}'];

const RESERVED_INDEX_SCOPE = ['**/index', '!index'];

const ROOT_INDEX_SCOPE = ['index'];

export interface OkfFrontmatterEntry {
  readonly id: OkfRuleId;
  readonly appliesTo: readonly string[];
  readonly schema: Record<string, unknown>;
}

export const OKF_FRONTMATTER_REGISTRY: readonly OkfFrontmatterEntry[] = [
  {
    id: 'frontmatter-required',
    appliesTo: CONCEPT_SCOPE,
    schema: OKF_REQUIRED_SCHEMA,
  },
  {
    id: 'frontmatter-recommended',
    appliesTo: CONCEPT_SCOPE,
    schema: OKF_RECOMMENDED_SCHEMA,
  },
  {
    id: 'frontmatter-provenance',
    appliesTo: CONCEPT_SCOPE,
    schema: OKF_PROVENANCE_SCHEMA,
  },
  {
    id: 'frontmatter-computation',
    appliesTo: CONCEPT_SCOPE,
    schema: OKF_ATTESTED_COMPUTATION_SCHEMA,
  },
  {
    id: 'frontmatter-reserved-index',
    appliesTo: RESERVED_INDEX_SCOPE,
    schema: OKF_RESERVED_INDEX_SCHEMA,
  },
  {
    id: 'frontmatter-root-index',
    appliesTo: ROOT_INDEX_SCOPE,
    schema: OKF_ROOT_INDEX_SCHEMA,
  },
];

export const OKF_FRONTMATTER_ONLY_TOGGLES: Partial<Record<OkfRuleId, boolean>> = Object.fromEntries(
  OKF_RULE_IDS.filter((id) => !OKF_FRONTMATTER_REGISTRY.some((entry) => entry.id === id)).map(
    (id) => [id, false] as const,
  ),
);

export function selectOkfFrontmatterSchemas(
  rules: OkfRuleToggles,
  docName: string | undefined,
): OkfFrontmatterEntry[] {
  if (docName === undefined) return [];
  return OKF_FRONTMATTER_REGISTRY.filter(
    (entry) =>
      isOkfRuleEnabled(rules, entry.id) && compileAppliesTo([...entry.appliesTo]).matches(docName),
  );
}

export function okfAdvertisedSchemaMappings(rules: OkfRuleToggles): FrontmatterSchemaMapping[] {
  return OKF_FRONTMATTER_REGISTRY.filter((entry) => isOkfRuleEnabled(rules, entry.id)).map(
    (entry) => ({
      appliesTo: [...entry.appliesTo],
      file: okfSchemaPathFor(entry.id),
    }),
  );
}

export function runOkfFrontmatterRules(
  text: string,
  rules: OkfRuleToggles,
  docName: string | undefined,
): LintDiagnostic[] {
  const selected = selectOkfFrontmatterSchemas(rules, docName);
  if (selected.length === 0) return [];
  return validateFrontmatterSource(
    text,
    selected.map((entry) => ({
      file: okfSchemaPathFor(entry.id),
      schema: entry.schema,
      ruleId: entry.id,
    })),
    { source: 'okf' },
  );
}
