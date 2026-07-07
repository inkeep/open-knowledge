/**
 * Shared error-state helpers for UI surfaces that need to turn a rejected
 * async action into visible user feedback. Three callers today:
 *
 *   - `NavigatorApp` — dismissible banner via `setError(msg)` React state
 *   - `WorkspaceSwitcher` — transient toast via `runWithToast`
 *   - `CommandPalette` — transient toast via `runWithToast`
 *
 * All three share the same decision logic (prefer `Error.message`, else
 * fallback) and the same rejection-catch shape, so the helpers live here
 * rather than in any component file.
 */

import { toast as sonnerToast } from 'sonner';

/**
 * Resolve the user-visible error message for a thrown/rejected value.
 * Prefers `err.message` when present, otherwise the `fallback`. Pure.
 */
export function resolveErrorMessage(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

/**
 * Run `fn()` and surface any rejection via `setError`. Clears the error state
 * at the start so a prior failure doesn't linger into a new successful action.
 * Swallows rejections — callers continue regardless.
 *
 * `logPrefix` flows into the `console.error` breadcrumb (`[WorkspaceSwitcher]`,
 * `[NavigatorApp]`, …) so operational triage can correlate the thrown value
 * to the call site.
 */
export async function runWithErrorStatePure(
  fn: () => Promise<void>,
  fallback: string,
  setError: (msg: string | null) => void,
  logPrefix = 'action',
): Promise<void> {
  try {
    setError(null);
    await fn();
  } catch (err) {
    console.error(`[${logPrefix}] action failed:`, err);
    setError(resolveErrorMessage(err, fallback));
  }
}

/**
 * Toast adapter around `runWithErrorStatePure` — the right surface for
 * ephemeral launcher UIs (dropdowns, command palettes) that auto-close on
 * action click. An inline banner wouldn't be visible; a toast is.
 *
 * Filters the internal `setError(null)` clear so success doesn't surface
 * anything; only real rejections fire `toastApi.error(msg)`. `toastApi` is
 * injected with a default of sonner's module-level `toast` — makes the
 * helper unit-testable without mounting a real `<Toaster/>`.
 */
export async function runWithToast(
  fn: () => Promise<void>,
  fallback: string,
  toastApi: { error(msg: string): void } = sonnerToast,
  logPrefix = 'action',
): Promise<void> {
  await runWithErrorStatePure(
    fn,
    fallback,
    (msg) => {
      // setError(null) fires at the start; ignore — toasts auto-dismiss and
      // there's nothing to clear. Only surface non-null rejections.
      if (msg !== null) toastApi.error(msg);
    },
    logPrefix,
  );
}
