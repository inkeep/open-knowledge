/**
 * Throttled user-visible toast for paste-path conversion failures.
 *
 * When a paste goes through the rich-HTML branch and any
 * pipeline stage throws, the dispatcher falls through to a lower-
 * fidelity path. Telemetry captures
 * the failure for aggregators, but without a user-visible signal the
 * degradation is invisible — the user just sees "less formatting than I
 * expected" and has no way to know the rich-HTML path failed.
 *
 * We emit a single `toast.error` with a neutral message. The throttle
 * prevents a rapid sequence of failures (e.g. drag-sweeping 50 files into
 * the editor at once) from spamming the notification tray — one toast per
 * THROTTLE_MS window, per scope.
 *
 * Scope lets WYSIWYG + Source + future surfaces have independent throttle
 * counters. Same module-singleton pattern as `shift-tracker.ts` — per-
 * session global state; works because we have one editor-mount per tab.
 *
 * The `toast` import is deferred into the module so tests can mock
 * `sonner` before the helper runs.
 */

import { toast } from 'sonner';

const THROTTLE_MS = 3000;

const lastShownAt: Map<string, number> = new Map();

/**
 * Show a neutral paste-degradation notice if one hasn't been shown for
 * `scope` within the last THROTTLE_MS. Returns `true` if the toast was
 * emitted, `false` if throttled.
 *
 * Default `message` matches the soft-notice UX: the paste
 * landed in some form, but rich formatting may have degraded. Callers
 * can override with a more specific message when the failure mode is
 * known (e.g. "paste was too large" for `HtmlPayloadTooLargeError`).
 */
export function notifyPasteDegraded(
  scope: string,
  message = 'Pasted as plain text — some formatting could not be converted.',
): boolean {
  const now = Date.now();
  const last = lastShownAt.get(scope) ?? 0;
  if (now - last < THROTTLE_MS) return false;
  lastShownAt.set(scope, now);
  toast.error(message);
  return true;
}

/** Reset the throttle state. Test-only; not exported from the barrel. */
export function resetPasteFailureThrottle(): void {
  lastShownAt.clear();
}
