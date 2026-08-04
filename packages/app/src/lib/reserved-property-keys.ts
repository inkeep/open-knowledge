/**
 * Which frontmatter keys a document's property panel refuses to own, shared by
 * the panel that reserves them and the toolbar affordance that offers to add
 * the missing ones. Two copies of the list would drift into a button that
 * advertises a property the panel then declines to stage.
 */

import type { LintDiagnostic } from '@inkeep/open-knowledge-core';

/**
 * A skill's `name` is its folder identity (and the id agents invoke it by), so
 * it is renamed by moving the folder, never patched as a frontmatter property —
 * exactly as a document's filename is not one of its properties. The skill panel
 * renders it as a fixed identity row and keeps it out of its frontmatter rows.
 */
export const SKILL_RESERVED_KEYS = ['name'] as const;

/** Ordinary documents own every key, so nothing is held back from them. */
export const NO_RESERVED_KEYS: readonly string[] = [];

/**
 * Drop the missing-property diagnostics naming a key reserved for this document.
 *
 * A surface that counts or lists them would promise an add the panel will not
 * perform. The schema violation itself is not lost — it still reports through
 * the Problems panel like any other diagnostic.
 */
export function withoutReservedProperties(
  diagnostics: readonly LintDiagnostic[],
  reservedKeys: readonly string[],
): readonly LintDiagnostic[] {
  if (reservedKeys.length === 0) return diagnostics;
  const reserved = new Set(reservedKeys);
  return diagnostics.filter(
    (diagnostic) =>
      diagnostic.frontmatterProperty === undefined || !reserved.has(diagnostic.frontmatterProperty),
  );
}
