/**
 * Map `git clone` stderr (forwarded by `runCloneSubprocess` via simple-git's
 * `GitError.message`) into the `{title, detail}` shape that
 * `streamingProblemEvent` ships on the wire.
 *
 * Pre-fix, the HTTP clone handler passed stderr only as `cause` (Pino-only)
 * and never as `detail`, so the toast collapsed to the hardcoded title
 * "Clone subprocess reported an error." — surfacing neither the underlying
 * git stderr nor the likely cause (private repo / no access) even when the
 * user was signed in.
 *
 * `cause` stays for log correlation (`err: options.cause` in
 * `error-response.ts`); `detail` is what reaches the client envelope and
 * therefore the toast. PAT-style credentials are redacted from the URL
 * before either surface sees the stderr (reusing the share-publish
 * redactor — same threat model, same regex shape).
 *
 * Threat-model inheritance: `redactShareSubprocessStderr` only matches
 * `https?://user:pwd@host` shapes (the form the inline-token push URL
 * uses). Any future clone path that could surface other credential
 * shapes in stderr — bearer tokens, OAuth params, `http.extraHeader`
 * config quoted back — needs the redactor broadened (in
 * `share/publish.ts`) or a clone-specific redactor here. Today's clone
 * flow runs simple-git's `git.clone()` with a plain HTTPS URL and no
 * extra-header config, so the inherited model is sufficient.
 */

import { redactShareSubprocessStderr } from '../share/publish.ts';

export interface CloneErrorClassification {
  /** Human-readable title for the RFC 9457 envelope; surfaces in the toast. */
  title: string;
  /**
   * Sanitized, length-capped stderr for the envelope's `detail`. Empty
   * string when the upstream message was empty or whitespace-only.
   *
   * Callers are free to coerce `''` to `undefined` before passing to the
   * streaming writer; the current call site does. The helper does not
   * try to preserve the distinction.
   */
  detail: string;
}

const GENERIC_TITLE = 'Clone subprocess reported an error.';

/**
 * Cap detail at 500 chars — same ceiling the share-publish path applies
 * to subprocess stderr (api-extension.ts: redactShareSubprocessStderr +
 * `.slice(0, 500)`). Toast UI can't usefully render multi-page stderr,
 * and bounded-cardinality discipline applies to anything that lands on
 * Pino structured logs as well.
 */
const MAX_DETAIL_LEN = 500;

/**
 * Classify a single clone stderr string into envelope shape.
 *
 * Matches are tried in priority order; the first hit wins. Patterns are
 * intentionally permissive — git's exact phrasing drifts across versions
 * and platforms, so we match the load-bearing phrase rather than the
 * full line. Order matters: "Authentication failed" can co-occur with
 * "Repository not found" on some auth-shaped 404s; checking auth first
 * would mis-label.
 */
export function classifyCloneError(rawStderr: string): CloneErrorClassification {
  const detail = redactShareSubprocessStderr(rawStderr).trim().slice(0, MAX_DETAIL_LEN);

  if (detail.length === 0) {
    return { title: GENERIC_TITLE, detail: '' };
  }

  // 404 — repo doesn't exist OR is private and the caller has no access.
  // GitHub deliberately returns 404 for "private + unauthorized" to avoid
  // leaking existence; the title reflects both possibilities.
  if (/repository not found|returned error:\s*404/i.test(detail)) {
    return {
      title: "Can't access this repository. It may be private, or you may not have access.",
      detail,
    };
  }

  // 403 — explicit access denial. Distinct from 404: the repo exists and
  // the principal is recognized, but the recognized principal lacks
  // permission.
  if (/permission denied|access denied|returned error:\s*403/i.test(detail)) {
    return {
      title: "You don't have access to this repository.",
      detail,
    };
  }

  // Auth failure — credentials missing, expired, or rejected. Surfaces
  // as a "sign in again" prompt to the user rather than an access
  // statement; the credential, not the access policy, is the problem.
  if (/authentication failed/i.test(detail)) {
    return {
      title: 'GitHub authentication failed. Try signing in again.',
      detail,
    };
  }

  return { title: GENERIC_TITLE, detail };
}
