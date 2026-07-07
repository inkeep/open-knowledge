/**
 * Walk a `ZodObject`-rooted schema down to a leaf at a given path, transparent
 * to wrapper layers (`.default()`, `.optional()`, `.nullable()`).
 *
 * Pure introspection — no I/O, no side effects. Used by:
 *   - the Settings pane walker (form rendering)
 *   - the loader (post-fail Zod issue annotation)
 */

import type { z } from 'zod';
import { type FieldMeta, getFieldMeta } from './field-registry.ts';

type AnyZ = z.ZodType<unknown>;

/**
 * Strip `.default()` / `.optional()` / `.nullable()` (and any single-
 * `innerType` wrapper) until we find a schema that exposes a `shape` —
 * i.e. a `ZodObject` whose keys we can index. Bounded depth=16 mirrors
 * `getFieldMeta`'s loop guard.
 */
function unwrapToShape(schema: unknown): unknown {
  let cur: unknown = schema;
  for (let depth = 0; depth < 16; depth++) {
    if (cur === null || cur === undefined) return cur;
    const shape = (cur as { _zod?: { def?: { shape?: unknown } } })?._zod?.def?.shape;
    if (shape !== undefined) return cur;
    const inner = (cur as { _zod?: { def?: { innerType?: unknown } } })?._zod?.def?.innerType;
    if (inner === undefined) return cur;
    cur = inner;
  }
  return cur;
}

/**
 * Resolve the schema at `path` inside `rootSchema`. Returns `undefined`
 * if any segment fails to resolve (missing key, scalar in the middle of
 * the path, etc.). Does NOT unwrap the leaf — callers that want the
 * inner type pass the result through `getFieldDefault` / `getLeafTypeTag`
 * etc.
 */
export function resolveLeafSchema(
  rootSchema: AnyZ,
  path: readonly (string | number)[],
): AnyZ | undefined {
  let cur: unknown = rootSchema;
  for (const seg of path) {
    cur = unwrapToShape(cur);
    const shape = (cur as { _zod?: { def?: { shape?: Record<string, AnyZ> } } })?._zod?.def?.shape;
    if (!shape) return undefined;
    cur = shape[String(seg)];
    if (cur === undefined) return undefined;
  }
  return cur as AnyZ;
}

/**
 * Resolve the leaf at `path` and return its registered `FieldMeta`.
 * Returns `undefined` if the path doesn't resolve OR no metadata is
 * registered (e.g., an array index — `folders.0.match` — since registration
 * happens at the array-leaf level, not per-element).
 */
export function getLeafFieldMeta(
  rootSchema: AnyZ,
  path: readonly (string | number)[],
): FieldMeta | undefined {
  const leaf = resolveLeafSchema(rootSchema, path);
  if (leaf === undefined) return undefined;
  return getFieldMeta(leaf);
}
