const PRIMITIVE_READ_TYPES = new Set(['string', 'number', 'bigint', 'boolean', 'undefined']);

export interface ExpectStableOptions {
  durationMs?: number;
  pollMs?: number;
}

function readHeld<T>(held: string, read: () => T): T {
  try {
    return read();
  } catch (thrown) {
    const message = thrown instanceof Error ? thrown.message : String(thrown);
    const wrapped = new Error(`while holding ${held}: ${message}`, { cause: thrown });
    const originalStack = thrown instanceof Error ? thrown.stack : undefined;
    if (originalStack !== undefined) {
      wrapped.stack = originalStack.replace(message, () => wrapped.message);
    }
    throw wrapped;
  }
}

export async function expectStable<T extends string | number | bigint | boolean | null | undefined>(
  held: string,
  read: () => T,
  { durationMs = 600, pollMs = 50 }: ExpectStableOptions = {},
): Promise<T> {
  const initial = readHeld(held, read);
  if (initial !== null && !PRIMITIVE_READ_TYPES.has(typeof initial)) {
    throw new Error(
      `${held} was read as ${typeof initial}, but expectStable holds a value by identity, which equals value equality only for a primitive, so read a string, number, bigint, boolean, null or undefined instead`,
    );
  }
  const deadline = Date.now() + durationMs;
  while (Date.now() < deadline) {
    if (readHeld(held, read) !== initial) {
      throw new Error(`${held} changed during a ${durationMs}ms stability window`);
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  return initial;
}
