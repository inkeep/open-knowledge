/**
 * Canonical YAML codec for frontmatter.
 *
 * Wraps `yaml@2.x` `parseDocument` / `Document.toString()` so that:
 *   - User-source order is preserved (`sortMapEntries: false`).
 *   - Comments and blank lines round-trip via the Document AST (`parseDocument`,
 *     not `parse`).
 *   - Output is deterministic across runs (default scalar style, no anchors).
 *
 * Used at every YAML boundary: disk load (`onLoadDocument`), disk store
 * (`onStoreDocument`), source-mode reconciliation (Observer B), and the
 * `bindFrontmatterDoc` binding when re-serializing the FM region after a
 * patch or rename.
 */
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

/**
 * Shared `Document.toString()` options for every FM serializer in the repo
 * (`serializeFrontmatterMap`, `applyPatchToDocument`, and the parse-edit-
 * stringify primitives in `bridge/frontmatter-region.ts`). Exported so the
 * region-level binding can keep one canonical site for these settings.
 */
export const STRINGIFY_OPTIONS: ToStringOptions = {
  defaultKeyType: 'PLAIN',
  defaultStringType: 'PLAIN',
  lineWidth: 0,
};

/**
 * Result of a parse attempt — `null` map when the YAML is malformed or fails
 * `FrontmatterMapSchema`. `parseError` carries a short human-readable reason
 * when `map === null` so server-side callers can include the cause in their
 * log output (this module is in `@inkeep/open-knowledge-core` so it's
 * browser+Node and can't depend on a logger directly). On success
 * `parseError` is `undefined`.
 */
// Discriminated on `map` so "valid map AND parseError" is unrepresentable:
// a clean parse carries no `parseError`; a null map always carries one.
export type ParsedFrontmatter =
  | { doc: Document; map: FrontmatterMap; parseError?: never }
  | { doc: Document; map: null; parseError: string };

/**
 * Parse a YAML *body* (the content between the `---` fences, no fences) into
 * a `Document` (preserving comments + source order) and a typed `FrontmatterMap`
 * snapshot. Returns `map: null` if the YAML is malformed or its top-level value
 * is not a mapping or contains values outside the supported shapes; in that
 * case `parseError` describes which check failed.
 *
 * Empty / whitespace-only input is valid: returns an empty map plus a fresh
 * Document (the caller can populate it).
 */
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
    // First error is the most actionable — yaml@2 surfaces line/column in
    // the message already.
    return { doc, map: null, parseError: doc.errors[0]?.message ?? 'yaml parse errors' };
  }
  // yaml@2's `doc.toJS()` throws on some pathological documents (circular
  // anchors, exotic merge keys). Catch so the function stays total — the
  // contract is "every exit returns ParsedFrontmatter with parseError on
  // failure," which downstream observer / Y.Text-driven callers rely on.
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

/**
 * Serialize a `FrontmatterMap` to canonical YAML (no `---` fences). Output is
 * stable across runs given the same input — the substrate bridge invariant
 * depends on this (composed-string equality across XmlFragment ↔ Y.Text).
 *
 * Returns the empty string for an empty map so callers can decide whether to
 * emit fences at all (`prependFrontmatter` already short-circuits on empty).
 */
export function serializeFrontmatterMap(map: FrontmatterMap): string {
  if (Object.keys(map).length === 0) return '';
  const doc = new Document(map);
  return doc.toString(STRINGIFY_OPTIONS);
}

/**
 * Apply a per-key patch to an existing parsed Document, preserving comments
 * and source order on untouched keys.
 *
 * Semantics (RFC 7396 Merge Patch):
 *   - `value !== null` → set or create the key
 *   - `value === null` → delete the key
 *   - missing keys → unchanged
 *
 * Returns the canonical YAML string (no fences). Validates each value against
 * `FrontmatterValueSchema` and throws on shape mismatch — the caller is
 * expected to pre-validate at the API boundary.
 */
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

/**
 * Build the node to assign for a frontmatter value, preserving an existing
 * collection's flow/block style on whole-subtree replacement. Scalars pass
 * through unchanged; arrays and nested maps become yaml@2 nodes whose `.flow`
 * flag is copied from the node currently at the target (when one exists), so a
 * user's chosen `[a, b]` / `{ a: 1 }` flow style survives a `doc.set` /
 * `doc.setIn` replacement that would otherwise reset it to the block default.
 * Shared by `applyPatchToDocument` (here) and the path-addressed setters in
 * `bridge/frontmatter-region.ts`.
 */
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

/**
 * Wrap a serialized YAML body with `---` fences for disk persistence. Returns
 * the empty string for an empty body (caller writes a fence-less file).
 */
export function withFences(yamlBody: string): string {
  if (yamlBody === '') return '';
  const trimmed = yamlBody.endsWith('\n') ? yamlBody.slice(0, -1) : yamlBody;
  return `---\n${trimmed}\n---\n`;
}

/**
 * Read the ordered list of key strings from a parsed Document — used when the
 * caller needs to populate a `Y.Map` in the YAML's source order.
 */
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
