const componentStacks = new WeakMap<object, string>();

export function rememberComponentStack(
  error: unknown,
  componentStack: string | null | undefined,
): void {
  if (typeof error !== 'object' || error === null) return;
  if (typeof componentStack !== 'string' || componentStack.trim() === '') return;
  componentStacks.set(error, componentStack);
}

export function recallComponentStack(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  return componentStacks.get(error);
}
