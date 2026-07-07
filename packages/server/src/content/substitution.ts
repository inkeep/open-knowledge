/**
 * Template body substitution allowlist.
 *
 * Hard-allowlists exactly two server-side substitutions in template bodies:
 *
 *   {{date}} → today's date in ISO-8601 (YYYY-MM-DD), UTC.
 *   {{user}} → calling principal's display name; empty string when no
 *              principal is attached to the request.
 *
 * Any other `{{...}}` token is rejected at template-write time with
 * TEMPLATE_UNKNOWN_VARIABLE — preventing organic "engine" growth.
 *
 * Forward-compatible: any v1 template that doesn't use `{{...}}` (or uses
 * only the allowlist) is also a valid v2 template if the allowlist expands.
 *
 * Pure module — no side effects, no I/O, no clock unless caller passes a
 * Date. Two call sites:
 *   - `write({ template })` validates body at write time (rejects unknown).
 *   - `write` applies substitution at instantiation time.
 */

/**
 * Tokens accepted inside `{{...}}`. Add a string here to expand the
 * allowlist; also add the corresponding field to `SubstitutionContext`.
 */
export const SUBSTITUTION_ALLOWLIST = ['date', 'user'] as const;

type SubstitutionToken = (typeof SUBSTITUTION_ALLOWLIST)[number];

/** Context provided at instantiation time for each allowlisted token. */
interface SubstitutionContext {
  /** Today's date in ISO-8601 (`YYYY-MM-DD`). */
  date: string;
  /** Calling principal's display name; empty string when not attached. */
  user: string;
}

/**
 * Match `{{...}}` with single-line content. Trimmed token may contain
 * letters/digits/underscores/hyphens — the validator rejects anything not
 * in the allowlist regardless of shape.
 */
const TOKEN_PATTERN = /\{\{([^{}\n]+?)\}\}/g;

/** Identifies an unknown token surfaced by `validateSubstitution`. */
interface UnknownTokenError {
  /** The trimmed token string between `{{` and `}}`. */
  token: string;
  /** 0-based byte offset of the `{{` opening in the input string. */
  offset: number;
}

/**
 * Validate that a template body contains only allowlisted `{{...}}` tokens.
 *
 * Returns an empty array on success; an array of {token, offset} on failure.
 * A body that contains no `{{...}}` tokens at all also returns `[]`.
 *
 * Used by `write({ template })` at template-write time. The agent gets a clear
 * list of unknown tokens to remove before the template can be saved.
 */
export function validateSubstitution(body: string): UnknownTokenError[] {
  const errors: UnknownTokenError[] = [];
  for (const match of body.matchAll(TOKEN_PATTERN)) {
    const token = (match[1] ?? '').trim();
    if (!isAllowedToken(token)) {
      errors.push({ token, offset: match.index ?? 0 });
    }
  }
  return errors;
}

/**
 * Apply the substitution allowlist to a template body. Returns the body
 * with allowlisted tokens replaced; unknown tokens left literal.
 *
 * Used by `write` at instantiation time. By the time we get here,
 * `validateSubstitution` should already have rejected unknown tokens at the
 * `write({ template })` template layer — but apply leaves them literal as a safety net so a
 * stale/imported template can never crash an instantiation.
 *
 * Substitution is single-pass — substituted values are NOT re-scanned for
 * `{{...}}`. A `{{date}}` value containing the literal string `{{user}}`
 * comes through verbatim, not re-substituted.
 */
export function applySubstitution(body: string, ctx: SubstitutionContext): string {
  return body.replace(TOKEN_PATTERN, (raw, capture: string) => {
    const token = capture.trim();
    if (!isAllowedToken(token)) return raw;
    return ctx[token];
  });
}

function isAllowedToken(token: string): token is SubstitutionToken {
  return (SUBSTITUTION_ALLOWLIST as readonly string[]).includes(token);
}

/**
 * Build today's ISO-8601 date in UTC. Pure function; pass a `Date` for
 * deterministic test output (`todayIsoUtc(new Date('2026-05-03Z'))`).
 */
export function todayIsoUtc(now: Date = new Date()): string {
  const yyyy = now.getUTCFullYear().toString().padStart(4, '0');
  const mm = (now.getUTCMonth() + 1).toString().padStart(2, '0');
  const dd = now.getUTCDate().toString().padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}
