import { resolveLeafSchema } from '@inkeep/open-knowledge-core';
import type { z } from 'zod';

export { resolveLeafSchema };

type AnyZ = z.ZodType<unknown>;

export function buildPatch(
  path: readonly (string | number)[],
  value: unknown,
): Record<string, unknown> {
  if (path.length === 0) {
    throw new Error('buildPatch: path must be non-empty');
  }
  const [head, ...rest] = path;
  if (rest.length === 0) {
    return { [String(head)]: value };
  }
  return { [String(head)]: buildPatch(rest, value) };
}

export function getFieldDefault(schema: AnyZ): unknown {
  let cur: unknown = schema;
  for (let depth = 0; depth < 16; depth++) {
    if (cur === null || cur === undefined) return undefined;
    const def = (cur as { _zod?: { def?: { type?: string; defaultValue?: unknown } } })?._zod?.def;
    if (def?.type === 'default') {
      const dv = def.defaultValue;
      return typeof dv === 'function' ? (dv as () => unknown)() : dv;
    }
    const inner = (cur as { _zod?: { def?: { innerType?: unknown } } })?._zod?.def?.innerType;
    if (inner === undefined) return undefined;
    cur = inner;
  }
  return undefined;
}

export function getLeafTypeTag(schema: AnyZ): string | undefined {
  let cur: unknown = schema;
  for (let depth = 0; depth < 16; depth++) {
    if (cur === null || cur === undefined) return undefined;
    const def = (cur as { _zod?: { def?: { type?: string; innerType?: unknown } } })?._zod?.def;
    if (!def) return undefined;
    if (def.type === 'default' || def.type === 'optional' || def.type === 'nullable') {
      cur = def.innerType;
      continue;
    }
    return def.type;
  }
  return undefined;
}

export function getEnumOptions(schema: AnyZ): readonly string[] | undefined {
  let cur: unknown = schema;
  for (let depth = 0; depth < 16; depth++) {
    if (cur === null || cur === undefined) return undefined;
    const def = (
      cur as {
        _zod?: { def?: { type?: string; entries?: Record<string, string>; innerType?: unknown } };
      }
    )?._zod?.def;
    if (!def) return undefined;
    if (def.type === 'enum') {
      return def.entries ? Object.values(def.entries) : undefined;
    }
    if (def.innerType !== undefined) {
      cur = def.innerType;
      continue;
    }
    return undefined;
  }
  return undefined;
}
