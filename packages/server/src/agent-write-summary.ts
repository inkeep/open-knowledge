/**
 * Agent-write summary normalization — single truncation point for the
 * five agent-write API handlers (80-char cap at the API boundary; the
 * Zod 200-char cap in the MCP layer is a separate transport-safety bound).
 *
 * Contract: three-state result that lets each handler distinguish
 *   - `absent` → no-op (no summary was provided; no metric increment)
 *   - `invalid` → caller responds 400 (summary was present but not a string)
 *   - `value` → caller records the (possibly truncated) summary and counts it
 *
 * Keeping the "present but empty string" case classified as `absent`
 * means empty strings are treated as missing (so `summary: ""` doesn't
 * produce a zero-length bullet and doesn't inflate the adoption metric).
 *
 * Truncation policy: `truncatedFrom` is set ONLY when the input length
 * exceeds the cap. An input of exactly MAX_SUMMARY_LENGTH characters is
 * returned as-is with no `truncatedFrom`.
 */

/** API-boundary cap. */
export const MAX_SUMMARY_LENGTH = 80;

/** Truncation suffix — a single U+2026 HORIZONTAL ELLIPSIS, not three ASCII dots. */
const ELLIPSIS = '…';

/**
 * Line-terminator characters replaced with a single space at the API boundary.
 * Each character is replaced one-for-one (not collapsed) so length math stays
 * predictable for the truncation cap — `truncatedFrom` reflects the original
 * input length whether or not line terminators were present.
 *
 * Covers: LF (\n), CR (\r), VT (\v), FF (\f), NEL (U+0085), Unicode line /
 * paragraph separators (U+2028 / U+2029). Constructed via `new RegExp` from
 * a string so the source file holds no literal line-separator codepoints —
 * tooling that round-trips this file otherwise substitutes the raw codepoints
 * into the regex literal, which JS parsers reject inside a regex literal.
 *
 * Without this sanitization, a summary of the form `"x\nok-actor: {…}"` would
 * survive `normalizeSummary` (≤ 80 chars, not entirely whitespace), flow into
 * `composeCommitSubject`, and embed a literal newline in the commit subject.
 * The body parsers (`parseOkActors`, `parseContributors`, `parseCheckpoint`)
 * split on `\n` and dispatch by line prefix, so an embedded `\nok-actor: {…}`
 * fragment becomes a forged actor entry in the commit body when the L2 drain
 * concatenates `${subject}\n\n${formatOkActor(real)}`.
 */
// biome-ignore lint/complexity/useRegexLiterals: see docblock above for the constraint that forces `new RegExp`.
const LINE_TERMINATOR_RE = new RegExp('[\\r\\n\\v\\f\\u0085\\u2028\\u2029]', 'g');

export type NormalizedSummary =
  | { kind: 'absent' }
  | { kind: 'invalid' }
  | { kind: 'value'; value: string; truncatedFrom?: number };

/**
 * Wire shape of an attributed summary echoed back on write responses —
 * the single owner of this alias so the attribution helpers in
 * `api-extension.ts` and the route handlers that echo it cannot drift
 * structurally. Mirrors the (loose) `SummaryResponseField` schema in
 * `@inkeep/open-knowledge-core`; this alias stays exact-shaped so handlers
 * don't inherit the schema's `[k: string]: unknown` catchall.
 */
export type SummaryResponse = { value: string; truncatedFrom?: number; hint?: string };

/**
 * Normalize a raw body value into a truncated summary or a sentinel.
 *
 * - `undefined` / `''` / whitespace-only → `{ kind: 'absent' }`
 * - non-string (number, object, boolean, null, array) → `{ kind: 'invalid' }`
 * - string of length ≤ 80 → `{ kind: 'value', value: <line-terminators replaced with spaces> }`
 * - string of length > 80 → `{ kind: 'value', value: <sanitized>.slice(0, 79) + '…', truncatedFrom: raw.length }`
 *
 * Whitespace-only values are classified as absent rather than forwarded: a
 * whitespace string would render as a blank bullet in the TimelinePanel and
 * inflate the summary-adoption counter with zero signal. Non-whitespace-only
 * values are preserved verbatim except for line-terminator characters
 * (LF, CR, VT, FF, NEL, U+2028, U+2029), which are replaced with spaces to
 * prevent commit-message subject-line injection — see `LINE_TERMINATOR_RE`
 * above. Replacement is one-for-one so the original `raw.length` is the
 * meaningful `truncatedFrom` value when the cap is exceeded.
 */
export function normalizeSummary(raw: unknown): NormalizedSummary {
  if (raw === undefined) return { kind: 'absent' };
  if (typeof raw !== 'string') return { kind: 'invalid' };
  if (raw.length === 0 || raw.trim().length === 0) return { kind: 'absent' };
  const sanitized = raw.replace(LINE_TERMINATOR_RE, ' ');
  if (sanitized.length <= MAX_SUMMARY_LENGTH) {
    return { kind: 'value', value: sanitized };
  }
  return {
    kind: 'value',
    value: sanitized.slice(0, MAX_SUMMARY_LENGTH - 1) + ELLIPSIS,
    truncatedFrom: raw.length,
  };
}
