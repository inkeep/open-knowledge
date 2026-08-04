/**
 * Derive the catalogue of fields the schemas governing a doc DECLARE — the
 * layer above `frontmatter-enum-constraints`, which derives the allowed VALUES
 * of a field already known. Both read the RESOLVED lint config through
 * `selectApplicableFrontmatterSchemas`, so neither can disagree with the linter
 * about which schemas govern a doc.
 *
 * Two consumers, both on the add-property path: the field picker offers these
 * names so a user does not have to open the schema to learn them, and a row
 * staged for a missing required property takes its widget type from here.
 *
 * Presentational only. `required` is unioned across schemas for a hint in the
 * picker — whether a property is actually missing stays ajv's answer, carried
 * on the diagnostic as `frontmatterProperty`. Deriving that here instead would
 * miss `allOf` / `if`-`then` / `$ref` composition, which ajv resolves and a
 * direct read of `required` does not.
 *
 * Merge across schemas mirrors the enum module's conjunction rule: a field
 * declared with conflicting types by two governing schemas has no single widget
 * that can satisfy both, so it degrades to `text` rather than picking a side.
 * Only two EXPLICIT, differing types conflict — a schema that declares a
 * property without a `type` constrains nothing, so it must not be able to
 * outvote a sibling that does declare one.
 */

import {
  type FrontmatterType,
  type LinterConfig,
  selectApplicableFrontmatterSchemas,
} from '@inkeep/open-knowledge-core';

export interface SchemaField {
  /** Widget type for the field, defaulting to `text` when undeclared. */
  type: FrontmatterType;
  /** Declared `required` by at least one governing schema. */
  required: boolean;
  /** The schema's own `description`, shown as secondary text in the picker. */
  description?: string;
}

/**
 * A field mid-merge. `type: null` is "no governing schema has declared one
 * yet", kept distinct from an explicit `text` so an untyped declaration cannot
 * masquerade as a constraint a later schema then conflicts with. Resolved to
 * the panel's `text` fallback once every schema has been folded in.
 */
interface DeclaredField {
  type: FrontmatterType | null;
  required: boolean;
  description?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requiredNames(schema: Record<string, unknown>): string[] {
  if (!Array.isArray(schema.required)) return [];
  return schema.required.filter((name): name is string => typeof name === 'string');
}

/**
 * JSON-Schema `type` → the panel's widget vocabulary.
 *
 * `null` means "no single widget applies": an undeclared type, one OK has no
 * widget for, or a union (`type: ['string', 'number']`). Callers render those
 * as `text`, which accepts anything the user types and lets the linter judge
 * it — the alternative, guessing one branch of a union, produces a widget that
 * silently cannot express the other.
 */
function widgetTypeFor(property: Record<string, unknown>): FrontmatterType | null {
  const declared = property.type;
  if (typeof declared !== 'string') return null;
  switch (declared) {
    case 'string':
      // `format: date` is the one format with a dedicated widget; every other
      // format (email, uri, …) is text with a validator behind it.
      return property.format === 'date' ? 'date' : 'text';
    case 'number':
    case 'integer':
      return 'number';
    case 'boolean':
      return 'boolean';
    case 'array':
      return 'list';
    case 'object':
      return 'object';
    default:
      return null;
  }
}

/** The fields declared for `docName` by every schema that governs it. */
export function schemaFieldsForDoc(
  config: LinterConfig | null,
  docName: string | undefined,
): Map<string, SchemaField> {
  const slice = config?.plugins.frontmatter;
  if (!config?.enabled || !slice?.enabled || docName === undefined || docName === '') {
    return new Map();
  }
  const declared = new Map<string, DeclaredField>();
  const schemas = selectApplicableFrontmatterSchemas(slice.schemas, docName);

  // Unioned up front, not per schema: one schema may declare `status` under
  // `properties` while a sibling requires it, and the field is required either
  // way. Folding them in one pass would let declaration order decide.
  const required = new Set(schemas.flatMap(({ schema }) => requiredNames(schema)));

  // Fields a type conflict already dropped to `text`. Terminal by construction
  // rather than by `text` happening to absorb every later comparison, so the
  // offered widget cannot come to depend on schema order.
  const droppedToText = new Set<string>();

  function declare(name: string, type: FrontmatterType | null, description?: string): void {
    const existing = declared.get(name);
    if (existing === undefined) {
      declared.set(name, {
        type,
        required: required.has(name),
        ...(description === undefined ? {} : { description }),
      });
      return;
    }
    // The first description wins — schemas are conjoined, not ranked, so
    // concatenating two would read as one contradictory sentence.
    const next: DeclaredField = {
      ...existing,
      ...(existing.description === undefined && description !== undefined ? { description } : {}),
    };
    if (type !== null && !droppedToText.has(name)) {
      // An unconstrained field takes the first declared type; two explicit,
      // differing types have no common widget.
      if (existing.type === null) next.type = type;
      else if (type !== existing.type) {
        droppedToText.add(name);
        next.type = 'text';
      }
    }
    declared.set(name, next);
  }

  for (const { schema } of schemas) {
    const properties = isRecord(schema.properties) ? schema.properties : {};
    for (const [name, rawProperty] of Object.entries(properties)) {
      if (!isRecord(rawProperty)) continue;
      const description =
        typeof rawProperty.description === 'string' && rawProperty.description !== ''
          ? rawProperty.description
          : undefined;
      declare(name, widgetTypeFor(rawProperty), description);
    }
  }

  // A schema may require a field it never declares under `properties`. The
  // picker still has to offer it and a staged row still needs a type, so it
  // lands unconstrained and resolves to text.
  for (const name of required) declare(name, null);

  return new Map(
    [...declared].map(([name, field]) => [
      name,
      {
        type: field.type ?? 'text',
        required: field.required,
        ...(field.description === undefined ? {} : { description: field.description }),
      },
    ]),
  );
}
