/**
 * OTEL emission for git-preflight failure events.
 *
 * Separated from `git-preflight.ts` so the detection primitive stays pure
 * (no OTel imports) and so the wire-in sites — `bootServer()` and Electron
 * `ensureGitAvailable()` — share one bounded-cardinality helper.
 *
 * Cardinality is bounded by design:
 *   - `ok.platform`              — `NodeJS.Platform` enum (≤11 values).
 *   - `ok.preflight.git.reason`  — two values (`not_available` / `too_old`).
 *   - `ok.preflight.git.detected_version` — empty string for `not_available`;
 *     semver triple below `MIN_GIT_VERSION` for `too_old` (bounded by floor).
 *
 * Failure-only — callers MUST NOT invoke on the success path.
 */

import { type GitNotAvailableError, GitTooOldError } from './git-preflight.ts';
import { withSpanSync } from './telemetry.ts';

/**
 * OTEL span name emitted on git-preflight failure. Pinned — downstream
 * dashboards / aggregations key on this exact string.
 */
export const GIT_PREFLIGHT_FAIL_SPAN_NAME = 'ok.preflight.git.fail';

/**
 * Emit a single `ok.preflight.git.fail` span. No-op when telemetry is
 * disabled (`OTEL_SDK_DISABLED != 'false'`) — `getTracer()` returns the
 * OTel API no-op tracer, which records but never exports.
 */
export function emitPreflightFailureSpan(err: GitNotAvailableError | GitTooOldError): void {
  const reason = err instanceof GitTooOldError ? 'too_old' : 'not_available';
  const detectedVersion = err instanceof GitTooOldError ? err.detected : '';
  withSpanSync(
    GIT_PREFLIGHT_FAIL_SPAN_NAME,
    {
      attributes: {
        'ok.platform': err.platform,
        'ok.preflight.git.reason': reason,
        'ok.preflight.git.detected_version': detectedVersion,
      },
    },
    () => {},
  );
}
