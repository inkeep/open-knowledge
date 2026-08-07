interface TerminalStateContext {
  readonly projectPath: string;
  readonly canonicalKey: string;
  readonly ephemeral?: unknown;
}

export function terminalStateKeyForContext(context: TerminalStateContext | null): string | null {
  if (context === null) return null;
  return context.ephemeral === undefined ? context.projectPath : context.canonicalKey;
}
