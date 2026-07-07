/**
 * Shared error-message formatting for fail-open diagnostic breadcrumbs. The
 * git branch-info / checkout / freshness / target-status catches all bound an
 * arbitrary error to a single log-safe line the same way; one definition keeps
 * the 500-char cap and the ellipsis consistent across those sites.
 */

/** Bound an error to a log-safe message: non-Errors stringify; over 500 chars truncates with an ellipsis. */
export function truncateError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.length > 500 ? `${message.slice(0, 500)}…` : message;
}
