/**
 * One parser for the `rawInput` an adapter reports on an MCP tool call.
 *
 * The adapters disagree about where the tool name and its arguments live, and
 * every shape below is one recorded off a real thread: Codex sends the full
 * `{ server, tool, arguments }` envelope; others name the tool at `name`, omit
 * `server` entirely, serialize `arguments` as a JSON string, or pass the
 * arguments object bare with no tool name at all.
 *
 * Shared so the two readers of these payloads — follow-mode's target
 * resolution and the transcript's tool-call copy — can never disagree about
 * what a given call said.
 */

/** A non-empty string field, or null. */
export function stringField(obj: Record<string, unknown>, key: string): string | null {
  const value = obj[key];
  return typeof value === 'string' && value !== '' ? value : null;
}

export interface UnwrappedMcpInput {
  /** The tool name when the adapter reported one, else null. */
  tool: string | null;
  /** The tool's own arguments, unwrapped from whichever envelope carried them. */
  args: Record<string, unknown>;
}

export function unwrapMcpInput(rawInput: unknown): UnwrappedMcpInput | null {
  if (typeof rawInput !== 'object' || rawInput === null) return null;
  const input = rawInput as Record<string, unknown>;
  const tool = stringField(input, 'tool') ?? stringField(input, 'name');
  let args: Record<string, unknown> = input;
  if (typeof input.arguments === 'object' && input.arguments !== null) {
    args = input.arguments as Record<string, unknown>;
  } else if (typeof input.arguments === 'string') {
    try {
      const parsed: unknown = JSON.parse(input.arguments);
      if (typeof parsed === 'object' && parsed !== null) {
        args = parsed as Record<string, unknown>;
      }
    } catch {
      // Not JSON — treat the input itself as the args object.
    }
  }
  return { tool, args };
}
