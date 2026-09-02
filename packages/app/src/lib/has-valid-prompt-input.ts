export function hasValidPromptInput(
  instruction: string,
  mentions: readonly string[],
  hasSelection: boolean,
): boolean {
  return instruction.trim().length > 0 || mentions.length > 0 || hasSelection;
}
