/**
 * Shared "is there enough intent to act?" predicate for AI-prompt composers.
 *
 * Every prompt-composing entry point must require *some* intent before it
 * dispatches — a typed brief, an explicit `@`-mention, or a captured selection
 * is enough; an empty field is not. The bottom composer expresses this inline
 * via `canSend`; the create composer routes through this same predicate so the
 * two surfaces agree on what counts as actionable.
 */
export function hasValidPromptInput(
  instruction: string,
  mentions: readonly string[],
  hasSelection: boolean,
): boolean {
  return instruction.trim().length > 0 || mentions.length > 0 || hasSelection;
}
