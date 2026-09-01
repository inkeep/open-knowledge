import {
  type FrontmatterType,
  type LinterConfig,
  selectGoverningFrontmatterSchemas,
} from '@inkeep/open-knowledge-core';

export interface SchemaField {
  type: FrontmatterType;
  required: boolean;
  description?: string;
}

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

function widgetTypeFor(property: Record<string, unknown>): FrontmatterType | null {
  const declared = property.type;
  if (typeof declared !== 'string') return null;
  switch (declared) {
    case 'string':
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

const AUTHORABLE_LIST_ITEM_TYPES = new Set(['string', 'number', 'integer', 'boolean']);

const TYPELESS_CONSTRAINT_KEYWORDS = ['anyOf', 'oneOf', 'allOf', 'not'];

function hasAuthorableWidget(property: Record<string, unknown>): boolean {
  if (property.type === 'array') {
    const itemType = isRecord(property.items) ? property.items.type : undefined;
    return typeof itemType !== 'string' || AUTHORABLE_LIST_ITEM_TYPES.has(itemType);
  }
  if (typeof property.type === 'string') return true;
  return !TYPELESS_CONSTRAINT_KEYWORDS.some((keyword) => keyword in property);
}

export function schemaFieldsForDoc(
  config: LinterConfig | null,
  docName: string | undefined,
): Map<string, SchemaField> {
  const declared = new Map<string, DeclaredField>();
  const schemas = selectGoverningFrontmatterSchemas(config, docName);

  const required = new Set(schemas.flatMap(({ schema }) => requiredNames(schema)));

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
    const next: DeclaredField = {
      ...existing,
      ...(existing.description === undefined && description !== undefined ? { description } : {}),
    };
    if (type !== null && !droppedToText.has(name)) {
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
      if (!hasAuthorableWidget(rawProperty)) {
        if (required.has(name)) declare(name, null, description);
        continue;
      }
      declare(name, widgetTypeFor(rawProperty), description);
    }
  }

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
