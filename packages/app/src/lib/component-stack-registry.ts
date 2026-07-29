/**
 * Carries React's `errorInfo.componentStack` from an error boundary's
 * `onError` to the fallback that renders next.
 *
 * `react-error-boundary` passes `errorInfo` to `onError` only — `FallbackProps`
 * is `{ error, resetErrorBoundary }` — so a fallback building a crash report
 * cannot otherwise reach it. That matters because a packaged build minifies
 * both halves of the usual signal: React ships numeric error codes instead of
 * messages, and the JS stack is mangled identifiers. The component stack is the
 * only part that still names real components.
 *
 * Keyed by the thrown value rather than a module-level "last stack" so a nested
 * boundary that catches first cannot leak its stack into an outer boundary's
 * report. `WeakMap` also means a retained stack never outlives its error.
 */
const componentStacks = new WeakMap<object, string>();

/** No-ops for primitives (unkeyable) and for blank stacks (nothing to report). */
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
