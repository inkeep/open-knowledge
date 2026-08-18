import { CANONICAL_SCHEMA_DIALECT_URIS, DEFAULT_SCHEMA_DIALECT } from './frontmatter-validate.ts';

export interface FrontmatterFieldConstraint {
  type?: 'string' | 'number' | 'boolean' | 'array' | 'object' | null;
  enum?: (string | number | boolean)[] | null;
  itemsEnum?: (string | number | boolean)[] | null;
  itemsType?: 'string' | 'number' | 'boolean' | 'object' | null;
  pattern?: string | null;
  format?: string | null;
  description?: string | null;
  required?: boolean;
}

export type SchemaParentPathSegment = string | { items: true };

export function emptyFrontmatterSchemaText(): string {
  const $schema = CANONICAL_SCHEMA_DIALECT_URIS[DEFAULT_SCHEMA_DIALECT];
  return `${JSON.stringify({ $schema, type: 'object' }, null, 2)}\n`;
}

export function isToolManagedSchemaPath(file: string): boolean {
  const normalized = file.trim().replace(/^\.\//, '');
  if (!normalized.startsWith('.ok/schemas/')) return false;
  const name = normalized.slice('.ok/schemas/'.length);
  return (
    name.length > 0 && !name.includes('/') && !name.includes('\\') && name !== '.' && name !== '..'
  );
}

export function isFrontmatterSchemaAsset(path: string): boolean {
  const basename = path.trim().toLowerCase().split('/').pop() ?? '';
  if (basename.endsWith('.schema.json') && basename.length > '.schema.json'.length) return true;
  return isToolManagedSchemaPath(path) && basename.endsWith('.json');
}

export class FrontmatterSchemaEditError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function navigateToParent(
  schema: Record<string, unknown>,
  parentPath: readonly SchemaParentPathSegment[],
  create: boolean,
): Record<string, unknown> {
  let node = schema;
  for (const segment of parentPath) {
    if (typeof segment !== 'string') {
      const items = node.items;
      if (items === undefined) {
        if (!create) {
          throw new FrontmatterSchemaEditError('field path items does not exist');
        }
        const created: Record<string, unknown> = { type: 'object' };
        node.items = created;
        node = created;
        continue;
      }
      if (!isRecord(items)) {
        throw new FrontmatterSchemaEditError('field path items is not an object sub-schema');
      }
      node = items;
      continue;
    }
    const properties = schemaProperties(node);
    const child = properties[segment];
    if (child === undefined) {
      if (!create) {
        throw new FrontmatterSchemaEditError(
          `field path ${JSON.stringify(segment)} does not exist`,
        );
      }
      const created: Record<string, unknown> = { type: 'object' };
      node.properties = { ...properties, [segment]: created };
      node = created;
      continue;
    }
    if (!isRecord(child)) {
      throw new FrontmatterSchemaEditError(
        `field path ${JSON.stringify(segment)} is not an object property`,
      );
    }
    node = child;
  }
  return node;
}

export function applyFieldConstraint(
  schemaText: string,
  field: string,
  constraint: FrontmatterFieldConstraint,
  parentPath: readonly SchemaParentPathSegment[] = [],
): string {
  let schema: Record<string, unknown>;
  if (schemaText.trim() === '') {
    schema = JSON.parse(emptyFrontmatterSchemaText()) as Record<string, unknown>;
  } else {
    schema = parseSchemaObject(schemaText);
  }
  const parent = navigateToParent(schema, parentPath, true);

  const properties = schemaProperties(parent);
  const existing = isRecord(properties[field]) ? properties[field] : {};
  const property: Record<string, unknown> = { ...existing };

  for (const keyword of ['type', 'enum', 'pattern', 'format', 'description'] as const) {
    if (!(keyword in constraint)) continue;
    const value = constraint[keyword];
    if (value === null || value === undefined) delete property[keyword];
    else property[keyword] = value;
  }

  if ('itemsEnum' in constraint || 'itemsType' in constraint) {
    if (property.items !== undefined && !isRecord(property.items)) {
      throw new FrontmatterSchemaEditError('field path items is not an object sub-schema');
    }
    const items = isRecord(property.items) ? { ...property.items } : {};
    if ('itemsEnum' in constraint) {
      if (constraint.itemsEnum === null || constraint.itemsEnum === undefined) delete items.enum;
      else items.enum = constraint.itemsEnum;
    }
    if ('itemsType' in constraint) {
      if (constraint.itemsType === null || constraint.itemsType === undefined) delete items.type;
      else items.type = constraint.itemsType;
    }
    if (Object.keys(items).length > 0) property.items = items;
    else delete property.items;
  }

  if (Object.keys(property).length > 0) {
    parent.properties = { ...properties, [field]: property };
  } else if (field in properties) {
    const { [field]: _removed, ...rest } = properties;
    if (Object.keys(rest).length > 0) parent.properties = rest;
    else delete parent.properties;
  }

  if (constraint.required !== undefined) {
    const required = schemaRequired(parent);
    const has = required.includes(field);
    if (constraint.required && !has) parent.required = [...required, field];
    else if (!constraint.required && has) {
      setRequired(
        parent,
        required.filter((entry) => entry !== field),
      );
    }
  }

  return `${JSON.stringify(schema, null, 2)}\n`;
}

function parseSchemaObject(schemaText: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(schemaText);
  } catch (err) {
    throw new FrontmatterSchemaEditError(
      `schema is not valid JSON (${err instanceof Error ? err.message : String(err)})`,
    );
  }
  if (!isRecord(parsed)) {
    throw new FrontmatterSchemaEditError('schema is not a JSON object');
  }
  return parsed;
}

function schemaProperties(schema: Record<string, unknown>): Record<string, unknown> {
  return isRecord(schema.properties) ? schema.properties : {};
}

function schemaRequired(schema: Record<string, unknown>): string[] {
  return Array.isArray(schema.required)
    ? schema.required.filter((entry): entry is string => typeof entry === 'string')
    : [];
}

function setRequired(schema: Record<string, unknown>, required: string[]): void {
  if (required.length > 0) schema.required = required;
  else delete schema.required;
}

export function removeSchemaField(
  schemaText: string,
  field: string,
  parentPath: readonly SchemaParentPathSegment[] = [],
): string {
  const schema = parseSchemaObject(schemaText);
  const parent = navigateToParent(schema, parentPath, false);
  const properties = schemaProperties(parent);
  if (field in properties) {
    const { [field]: _removed, ...rest } = properties;
    if (Object.keys(rest).length > 0) parent.properties = rest;
    else delete parent.properties;
  }
  setRequired(
    parent,
    schemaRequired(parent).filter((entry) => entry !== field),
  );
  return `${JSON.stringify(schema, null, 2)}\n`;
}

export function renameSchemaField(
  schemaText: string,
  field: string,
  to: string,
  parentPath: readonly SchemaParentPathSegment[] = [],
): string {
  const schema = parseSchemaObject(schemaText);
  const parent = navigateToParent(schema, parentPath, false);
  const properties = schemaProperties(parent);
  if (!(field in properties)) {
    throw new FrontmatterSchemaEditError(`field ${JSON.stringify(field)} does not exist`);
  }
  if (to in properties) {
    throw new FrontmatterSchemaEditError(`field ${JSON.stringify(to)} already exists`);
  }
  const renamed: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(properties)) {
    renamed[key === field ? to : key] = value;
  }
  parent.properties = renamed;
  setRequired(
    parent,
    schemaRequired(parent).map((entry) => (entry === field ? to : entry)),
  );
  return `${JSON.stringify(schema, null, 2)}\n`;
}
