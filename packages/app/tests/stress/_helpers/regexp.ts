/**
 * Regex helpers shared across the stress suite.
 *
 * `escapeRegExp` lived in private copies across `sidebar.ts`,
 * `showall-lazy-tree.e2e.ts`, `upload-fixtures.ts` (whose own header scopes it
 * to "magic-byte buffers for upload e2e tests" — the wrong home for a general
 * string primitive), and `graph-panel-surfaces.e2e.ts` under the near-miss name
 * `escapeRegex`, which is why a grep for the canonical spelling missed it. One
 * definition here, re-exported from the barrel.
 *
 * (A copy also exists in product code at
 * `src/components/command-palette-search.ts`. Test helpers must not be
 * imported from `src/`, so that one stays where it is.)
 */

/**
 * Escape a string for embedding in a `RegExp`. Callers build patterns around
 * filenames and labels that carry a literal `.` — unescaped, it matches any
 * character, so an assertion meant to pin `shot-a3f9.png` would also accept
 * `shot-a3f9Xpng`.
 */
export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
