/**
 * Derive per-field enum constraints for the property panel from the RESOLVED
 * lint config — the same schemas and the same `appliesTo` matching the linter
 * uses, so the panel and the diagnostics can never disagree about which
 * schemas govern a doc. Schemas are data; this consumer derives select
 * vocabularies from them and nothing else.
 *
 * Merge across multiple matching schemas is the conjunction's intersection: a
 * value the panel offers must satisfy every governing schema. An empty
 * intersection falls back to no constraint (free text) — the linter still
 * reports the conflict; the panel must not offer a vocabulary that cannot
 * validate.
 */

import { type LinterConfig, selectGoverningFrontmatterSchemas } from '@inkeep/open-knowledge-core';

export interface FieldEnumConstraint {
  values: string[];
  /** True for `array` fields constrained via `items.enum` (multi-select). */
  multi: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function stringValues(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  return value.every((entry) => typeof entry === 'string') ? (value as string[]) : null;
}

function constraintFromProperty(property: Record<string, unknown>): FieldEnumConstraint | null {
  const direct = stringValues(property.enum);
  if (direct) return { values: direct, multi: false };
  if (property.type === 'array' && isRecord(property.items)) {
    const items = stringValues(property.items.enum);
    if (items) return { values: items, multi: true };
  }
  return null;
}

/** Per-field enum constraints for `docName` under the resolved config. */
export function enumConstraintsForDoc(
  config: LinterConfig | null,
  docName: string | undefined,
): Map<string, FieldEnumConstraint> {
  const constraints = new Map<string, FieldEnumConstraint>();
  // Fields a conflict already dropped to free text. Terminal: without it, a
  // later schema sees no existing constraint and re-adds its own vocabulary,
  // so the offered values would depend on schema order and could violate a
  // schema seen earlier.
  const droppedToFreeText = new Set<string>();

  // Every frontmatter-capable plugin's schemas feed the same intersection: a
  // field governed by more than one producer must offer only values satisfying
  // all of them, which is what the conjunction below already does — so the
  // shared selector concatenates the sources rather than branching per plugin.
  const governing = selectGoverningFrontmatterSchemas(config, docName);

  for (const { schema } of governing) {
    const properties = isRecord(schema.properties) ? schema.properties : {};
    for (const [field, rawProperty] of Object.entries(properties)) {
      if (!isRecord(rawProperty)) continue;
      const next = constraintFromProperty(rawProperty);
      if (!next) continue;
      if (droppedToFreeText.has(field)) continue;
      const existing = constraints.get(field);
      if (existing === undefined) {
        constraints.set(field, next);
        continue;
      }
      // Conjunction: intersect vocabularies. Mismatched multi-ness or an
      // empty intersection means no offerable vocabulary — drop to free text.
      if (existing.multi !== next.multi) {
        constraints.delete(field);
        droppedToFreeText.add(field);
        continue;
      }
      const intersection = existing.values.filter((value) => next.values.includes(value));
      if (intersection.length === 0) {
        constraints.delete(field);
        droppedToFreeText.add(field);
      } else constraints.set(field, { values: intersection, multi: existing.multi });
    }
  }
  return constraints;
}
