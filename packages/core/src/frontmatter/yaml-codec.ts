import {
  Document,
  isMap,
  isSeq,
  type Pair,
  parseDocument,
  type ToStringOptions,
  type YAMLMap,
  type YAMLSeq,
} from 'yaml';
import { type FrontmatterMap, FrontmatterMapSchema, FrontmatterValueSchema } from './schema.ts';

export const STRINGIFY_OPTIONS: ToStringOptions = {
  defaultKeyType: 'PLAIN',
  defaultStringType: 'PLAIN',
  lineWidth: 0,
};

export type ParsedFrontmatter =
  | { doc: Document; map: FrontmatterMap; parseError?: never }
  | { doc: Document; map: null; parseError: string };

export function parseFrontmatterYaml(yaml: string): ParsedFrontmatter {
  if (yaml.trim() === '') {
    return { doc: new Document({}), map: {} };
  }
  let doc: Document;
  try {
    doc = parseDocument(yaml);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { doc: new Document({}), map: null, parseError: `parse threw: ${msg}` };
  }
  if (doc.errors.length > 0) {
    return { doc, map: null, parseError: doc.errors[0]?.message ?? 'yaml parse errors' };
  }
  let json: unknown;
  try {
    json = doc.toJS();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { doc, map: null, parseError: `toJS threw: ${msg}` };
  }
  if (json == null || typeof json !== 'object' || Array.isArray(json)) {
    return { doc, map: null, parseError: 'top-level value is not a mapping' };
  }
  const result = FrontmatterMapSchema.safeParse(json);
  if (!result.success) {
    const issue = result.error.issues[0];
    const path = issue && Array.isArray(issue.path) ? issue.path.join('.') : '';
    const reason = issue?.message ?? 'unknown';
    return {
      doc,
      map: null,
      parseError: path
        ? `value at "${path}" failed schema: ${reason}`
        : `schema validation failed: ${reason}`,
    };
  }
  return { doc, map: result.data };
}

export function serializeFrontmatterMap(map: FrontmatterMap): string {
  if (Object.keys(map).length === 0) return '';
  const doc = new Document(map);
  return doc.toString(STRINGIFY_OPTIONS);
}

export function applyPatchToDocument(doc: Document, patch: Record<string, unknown>): string {
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) {
      doc.delete(key);
      continue;
    }
    const result = FrontmatterValueSchema.safeParse(value);
    if (!result.success) {
      throw new Error(`Invalid frontmatter value for "${key}": ${result.error.message}`);
    }
    doc.set(key, buildValueNode(doc, doc.get(key, true), result.data));
  }
  return doc.toString(STRINGIFY_OPTIONS);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function buildValueNode(doc: Document, existing: unknown, data: unknown): unknown {
  if (Array.isArray(data)) {
    const node = doc.createNode(data) as YAMLSeq;
    const flow = isSeq(existing) ? (existing as YAMLSeq).flow : undefined;
    if (flow !== undefined) node.flow = flow;
    return node;
  }
  if (isPlainObject(data)) {
    const node = doc.createNode(data) as YAMLMap;
    const flow = isMap(existing) ? (existing as YAMLMap).flow : undefined;
    if (flow !== undefined) node.flow = flow;
    return node;
  }
  return data;
}

export function withFences(yamlBody: string): string {
  if (yamlBody === '') return '';
  const trimmed = yamlBody.endsWith('\n') ? yamlBody.slice(0, -1) : yamlBody;
  return `---\n${trimmed}\n---\n`;
}

export function getDocumentKeys(doc: Document): string[] {
  const contents = doc.contents;
  if (contents == null || typeof contents !== 'object' || !('items' in contents)) {
    return [];
  }
  const items = (contents as { items: Pair[] }).items;
  return items
    .map((pair) => {
      const key = pair.key as { value?: unknown } | string | undefined;
      if (typeof key === 'string') return key;
      if (key && typeof key === 'object' && 'value' in key && typeof key.value === 'string') {
        return key.value;
      }
      return null;
    })
    .filter((k): k is string => k !== null);
}
