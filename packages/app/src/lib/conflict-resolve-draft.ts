/**
 * The instruction staged for an agent asked to resolve a file's merge conflicts,
 * seeded into the Ask AI composer while a conflicted document is open.
 *
 * The guardrails below are the payload's whole value, not the opening sentence.
 */

/**
 * Deliberately NOT translated, and deliberately not caught by the
 * user-facing-string lint (whose four branches do not match a template-literal
 * return).
 *
 * This is machine-directed input — a prompt handed to an agent — in the same
 * category as the CLI command surface that CLAUDE.md exempts, not chrome. The
 * tools it addresses describe themselves in English, and translating the
 * instruction would send a localised request to them.
 *
 * There is also a concrete cost: `isSeedText` recognises an untouched seed by
 * exact content match, and the draft persists to localStorage — so a localised
 * seed stops being recognised the moment the user changes language, and reads
 * as their own text forever. Revisiting this means storing a non-content marker
 * alongside the draft first.
 */
export function buildResolveDraft(filePath: string): string {
  // One line on purpose. The `conflicts` and `resolve_conflict` tool descriptions
  // already name each other and explain every strategy, and "all" carries the
  // only constraint that mattered — resolve every region, not the first one.
  //
  // This is a STAGED draft, not a sent prompt: the user reads it and adds
  // whatever they want for a given conflict before sending. A starting point
  // they extend beats a paragraph they have to delete.
  return `Resolve all the merge conflicts in ${filePath}.`;
}
