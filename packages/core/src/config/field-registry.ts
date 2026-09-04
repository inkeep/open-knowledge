import { z } from 'zod';
import type { FieldScope, WriteScope } from './errors.ts';

export type ReloadClass = 'boot' | 'live';

export interface FieldMeta {
  scope: FieldScope;
  agentSettable: boolean;
  reload: ReloadClass;
  defaultScope?: WriteScope;
  description: string;
}

const SINGLETON_KEY = Symbol.for('@inkeep/open-knowledge/field-registry');

interface SingletonGlobal {
  [SINGLETON_KEY]?: z.core.$ZodRegistry<FieldMeta>;
}

const g = globalThis as SingletonGlobal;
if (g[SINGLETON_KEY] === undefined) {
  g[SINGLETON_KEY] = z.registry<FieldMeta>();
}

export const fieldRegistry: z.core.$ZodRegistry<FieldMeta> = g[SINGLETON_KEY];

export function getFieldMeta(schema: unknown): FieldMeta | undefined {
  let cur: unknown = schema;
  for (let depth = 0; depth < 16; depth++) {
    if (cur === null || cur === undefined) return undefined;
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
