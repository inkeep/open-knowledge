
import type { z } from 'zod';
import { type FieldMeta, getFieldMeta } from './field-registry.ts';

type AnyZ = z.ZodType<unknown>;

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

export function getLeafFieldMeta(
  rootSchema: AnyZ,
  path: readonly (string | number)[],
): FieldMeta | undefined {
  const leaf = resolveLeafSchema(rootSchema, path);
  if (leaf === undefined) return undefined;
  return getFieldMeta(leaf);
}
