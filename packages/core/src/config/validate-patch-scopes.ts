/**
 * Walk a patch tree and surface the first leaf whose registered `scope`
 * conflicts with the writer's scope.
 *
 * Used by both `writeConfigPatch` (L2 fs writer) and `bindConfigDoc.patch`
 * (L1 client-side Y.Text writer) so the rule lands in one place. Each
 * leaf's compatibility is judged against `getLeafFieldMeta(...).scope`:
 *
 *  - Field scope `'either'` (or no metadata) — any writer accepted.
 *  - Field scope `'user'` — only writer scope `'user'`.
 *  - Field scope `'project'` — only writer scope `'project'`.
 *  - Field scope `'project-local'` — only writer scope `'project-local'`.
 *
 * Returns the first conflict found (the patch's other leaves may be
 * valid; we surface one error per call to keep the client-side toast
 * legible). Returns `null` when every leaf is scope-compatible.
 */

import type { ConfigValidationError, FieldScope, WriteScope } from './errors.ts';
import { type ConfigPatch, ConfigSchema } from './schema.ts';
import { getLeafFieldMeta } from './schema-leaf.ts';

function isScopeCompatible(field: FieldScope, writer: WriteScope): boolean {
  if (field === 'either') return true;
  return field === writer;
}

/**
 * Walk `patch` and return the first SCOPE_VIOLATION encountered, or null
 * if every registered leaf is compatible with `writerScope`. Unregistered
 * leaves (extra-keys via `looseObject`, array indices) are passed through
 * — they are governed by L2 schema validation, not scope.
 */
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
    // Scalar / array / null leaf — check the field's registered scope.
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
