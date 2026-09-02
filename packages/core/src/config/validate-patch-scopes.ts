import type { ConfigValidationError, FieldScope, WriteScope } from './errors.ts';
import { type ConfigPatch, ConfigSchema } from './schema.ts';
import { getLeafFieldMeta } from './schema-leaf.ts';

function isScopeCompatible(field: FieldScope, writer: WriteScope): boolean {
  if (field === 'either') return true;
  return field === writer;
}

export function validatePatchScopes(
  patch: ConfigPatch,
  writerScope: WriteScope,
): Extract<ConfigValidationError, { code: 'SCOPE_VIOLATION' }> | null {
  let violation: Extract<ConfigValidationError, { code: 'SCOPE_VIOLATION' }> | null = null;

  function walk(value: unknown, path: string[]): void {
    if (violation !== null) return;
    if (value === undefined) return;
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      for (const [key, subValue] of Object.entries(value)) {
        walk(subValue, [...path, key]);
        if (violation !== null) return;
      }
      return;
    }
    const meta = getLeafFieldMeta(ConfigSchema, path);
    if (meta?.scope === undefined) return;
    if (isScopeCompatible(meta.scope, writerScope)) return;
    violation = {
      code: 'SCOPE_VIOLATION',
      path,
      expectedScope: meta.scope,
      actualScope: writerScope,
    };
  }

  for (const [key, value] of Object.entries(patch)) {
    walk(value, [key]);
    if (violation !== null) break;
  }
  return violation;
}
