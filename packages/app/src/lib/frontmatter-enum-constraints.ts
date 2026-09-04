import { type LinterConfig, selectGoverningFrontmatterSchemas } from '@inkeep/open-knowledge-core';

export interface FieldEnumConstraint {
  values: string[];
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

export function enumConstraintsForDoc(
  config: LinterConfig | null,
  docName: string | undefined,
): Map<string, FieldEnumConstraint> {
  const constraints = new Map<string, FieldEnumConstraint>();
  const droppedToFreeText = new Set<string>();

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
