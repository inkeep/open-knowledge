import { z } from 'zod';
import type { FieldScope, WriteScope } from './errors.ts';

export interface FieldMeta {
  scope: FieldScope;
  agentSettable: boolean;
  defaultScope?: WriteScope;
  /**
   * Human-readable, English description of the field. Single source of field
   * help: the build injects it into the published JSON schema (editor hover)
   * via the `metadata: fieldRegistry` option. NOTE: `.describe()` does NOT work here — `toJSONSchema`
   * is given this custom registry, so it ignores Zod's global `description`
   * meta and only copies fields off the registered `FieldMeta`. The app's
   * settings UI localizes via lingui separately (kept in sync by a drift-guard
   * test), so this string is the non-localized canonical text, not the UI copy.
   */
  description: string;
}

// Symbol-keyed globalThis singleton — mirrors `z.globalRegistry`'s
// `globalThis.__zod_globalRegistry` discipline. Two copies of this module
// loaded under different file paths (e.g. workspace vs node_modules) still
// share the same WeakMap of registered schemas.
const SINGLETON_KEY = Symbol.for('@inkeep/open-knowledge/field-registry');

interface SingletonGlobal {
  [SINGLETON_KEY]?: z.core.$ZodRegistry<FieldMeta>;
}

const g = globalThis as SingletonGlobal;
if (g[SINGLETON_KEY] === undefined) {
  g[SINGLETON_KEY] = z.registry<FieldMeta>();
}

export const fieldRegistry: z.core.$ZodRegistry<FieldMeta> = g[SINGLETON_KEY];

// Zod v4 `.meta()` does NOT propagate through `.default()` / `.optional()` /
// `.nullable()` wrappers — they construct fresh instances without setting
// `_zod.parent`. The walker descends `_zod.def.innerType` to find the leaf
// metadata that `.register()` attached BEFORE the wrappers. Verified for
// Zod 4.3.6.
export function getFieldMeta(schema: unknown): FieldMeta | undefined {
  let cur: unknown = schema;
  // Bound the descent — single-innerType wrappers stack at most a handful deep
  // (.default().optional().nullable()) and a runaway loop would silently mask
  // a malformed schema.
  for (let depth = 0; depth < 16; depth++) {
    if (cur === null || cur === undefined) return undefined;
    // Zod's `registry.get(schema)` walks `_zod.parent` — passing a non-schema
    // value crashes its internals, so gate by `_zod` presence first.
    const meta = isZodSchema(cur) ? fieldRegistry.get(cur) : undefined;
    if (meta !== undefined) return meta;
    const innerType = (cur as { _zod?: { def?: { innerType?: unknown } } })._zod?.def?.innerType;
    if (innerType === undefined) return undefined;
    cur = innerType;
  }
  return undefined;
}

function isZodSchema(value: unknown): value is z.ZodType {
  return typeof value === 'object' && value !== null && '_zod' in value && 'parse' in value;
}
