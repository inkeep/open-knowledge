/**
 * Shared merge primitives for open-shape frontmatter.
 *
 * One call site uses these per-key rules:
 *
 *   - Folder-frontmatter write (`applyFolderFrontmatterPatch` in
 *     `folder-frontmatter-write.ts`) overlays a user-supplied patch on top of
 *     the existing on-disk `<folder>/.ok/frontmatter.yml`.
 *
 * `mergePatch` is the write primitive: patch values REPLACE existing values
 * (the user is saying "tags are now [a, b]", not "add a, b"), and empty
 * values DROP the key so clearing every field in the UI yields `{}`.
 *
 * Folder frontmatter does NOT cascade into child docs or down the folder
 * tree — each `.ok/frontmatter.yml` describes only its own folder. New-doc
 * starting properties come from templates, not from a read-time value
 * overlay.
 */

import { type FrontmatterValue, isFrontmatterValueEmpty } from '@inkeep/open-knowledge-core';

export type FrontmatterRecord = Record<string, unknown>;

/**
 * Merge `patch` onto `existing` using PATCH semantics:
 *
 *   - Scalars / arrays / objects in patch → REPLACE existing wholesale.
 *   - `undefined` in patch → keep existing.
 *   - `null` / `''` / `[]` in patch → DROP the key from the result.
 *
 * Use on the WRITE path. The user's patch is the authoritative new state
 * for the keys it mentions — they're saying "tags are now [a, b]", not
 * "add a, b to existing tags". The empty-value-drops semantics keep
 * auto-clean predictable: clearing every field in the UI yields `{}`,
 * which lets the caller delete the file.
 */
export function mergePatch(
  existing: FrontmatterRecord,
  patch: FrontmatterRecord,
): FrontmatterRecord {
  const result: FrontmatterRecord = { ...existing };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if (isEmpty(value)) {
      delete result[key];
      continue;
    }
    result[key] = value;
  }
  return result;
}

// Thin wrapper over the shared core predicate so the mergePatch call
// site (typed against the open-shape FrontmatterRecord = Record<string,
// unknown>) keeps its current signature. The cast widens the type but
// matches the runtime semantic exactly: the core helper is total over
// unknown — anything that isn't null/''/empty-array returns false.
// Consolidates onto a single source of truth shared with the UI's
// empty-value ADD gate.
function isEmpty(value: unknown): boolean {
  return isFrontmatterValueEmpty(value as FrontmatterValue | null);
}
