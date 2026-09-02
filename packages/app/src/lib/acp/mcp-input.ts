export function stringField(obj: Record<string, unknown>, key: string): string | null {
  const value = obj[key];
  return typeof value === 'string' && value !== '' ? value : null;
}

export interface UnwrappedMcpInput {
  tool: string | null;
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
    } catch {}
  }
  return { tool, args };
}
