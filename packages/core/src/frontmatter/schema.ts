import { z } from 'zod';

export const RESERVED_FRONTMATTER_KEY = 'frontmatter';

export const FRONTMATTER_TYPES = ['text', 'number', 'boolean', 'date', 'list', 'object'] as const;
export type FrontmatterType = (typeof FRONTMATTER_TYPES)[number];

export const FrontmatterTypeSchema = z.enum(FRONTMATTER_TYPES);

export type FrontmatterValue =
  | string
  | number
  | boolean
  | FrontmatterValue[]
  | { [key: string]: FrontmatterValue };

const FrontmatterScalarLeafSchema = z.union([z.string(), z.number(), z.boolean()]);

const FrontmatterArrayElementSchema: z.ZodType<FrontmatterValue> = z.lazy(() =>
  z.union([
    FrontmatterScalarLeafSchema.transform((v) => String(v)),
    z.record(z.string(), FrontmatterValueSchema),
    z.array(FrontmatterArrayElementSchema),
  ]),
);

export const FrontmatterValueSchema: z.ZodType<FrontmatterValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.array(FrontmatterArrayElementSchema),
    z.record(z.string(), FrontmatterValueSchema),
  ]),
);

const ISO_8601_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export function isIsoDateString(value: unknown): value is string {
  return typeof value === 'string' && ISO_8601_DATE_RE.test(value);
}

export function inferType(value: FrontmatterValue): FrontmatterType {
  if (Array.isArray(value)) return 'list';
  if (typeof value === 'object' && value !== null) return 'object';
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'number') return 'number';
  if (isIsoDateString(value)) return 'date';
  return 'text';
}

function coerceNullFrontmatter(value: unknown): unknown {
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    for (const element of value) {
      if (element === null) continue;
      out.push(coerceNullFrontmatter(element));
    }
    return out;
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      out[key] = child === null ? '' : coerceNullFrontmatter(child);
    }
    return out;
  }
  return value;
}

export const FrontmatterMapSchema = z.preprocess(
  coerceNullFrontmatter,
  z.record(z.string(), FrontmatterValueSchema),
);
export type FrontmatterMap = Record<string, FrontmatterValue>;

export const FrontmatterPatchSchema = z.record(
  z.string(),
  z.union([FrontmatterValueSchema, z.null()]),
);
export type FrontmatterPatch = Record<string, FrontmatterValue | null>;

export function isFrontmatterValueEmpty(value: FrontmatterValue | null): boolean {
  if (value === null) return true;
  if (typeof value === 'string' && value === '') return true;
  if (Array.isArray(value) && value.length === 0) return true;
  return false;
}

export function frontmatterValuesEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!frontmatterValuesEqual(a[i], b[i])) return false;
    }
    return true;
  }
  if (
    a !== null &&
    b !== null &&
    typeof a === 'object' &&
    typeof b === 'object' &&
    !Array.isArray(a) &&
    !Array.isArray(b)
  ) {
    const aKeys = Object.keys(a);
    const bKeys = Object.keys(b);
    if (aKeys.length !== bKeys.length) return false;
    for (const key of aKeys) {
      if (!Object.hasOwn(b, key)) return false;
      if (
        !frontmatterValuesEqual(
          (a as Record<string, unknown>)[key],
          (b as Record<string, unknown>)[key],
        )
      ) {
        return false;
      }
    }
    return true;
  }
  return false;
}
