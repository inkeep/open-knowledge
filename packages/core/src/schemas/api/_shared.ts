/**
 * Internal field schemas reused across cluster files.
 *
 * `safeDocNameField`, `agentIdentityFields`, and `summaryField` are spread or
 * referenced by the mutating-handler request schemas in `agent-write.ts`,
 * `pages.ts`, `history.ts` (save-version), and `tags-search.ts` (template).
 * `URN_UUID_RE` is the regex used by `ProblemDetailsSchema` in `_envelope.ts`
 * to validate the `instance` URI form (`urn:uuid:<uuid>`).
 *
 * Underscore prefix marks the file as internal-to-the-cluster split — the
 * names are NOT re-exported from `index.ts` because they were never part
 * of the public surface (the original `api.ts` did not export them).
 */

import { z } from 'zod';
import { validateDocName } from '../../util/doc-name.ts';

/**
 * `docName` shape shared by every mutating handler. When present, the value
 * must satisfy the structural docName contract (`validateDocName`): non-empty,
 * no leading/trailing whitespace, no control characters, no path traversal,
 * absolute or backslash paths, no empty / hidden-dot path segments. `.optional()`
 * still admits an omitted field — that path is gated separately at the handler.
 *
 * Stricter than the read-path `isSafeDocName` guard in `api-extension.ts` on
 * purpose; this is the write-time admission contract.
 */
/**
 * Emit the SPECIFIC rejection reason from `validateDocName` as a Zod issue
 * rather than one flat catch-all. `validateDocName` already classifies the
 * failure (`'docName must not contain ".."…'`, `'…must not start with "."…'`,
 * etc.); the boolean `isValidDocName` form discarded it, so every malformed
 * docName surfaced the same generic line through `withValidation`'s `detail`.
 * Surfacing the reason makes the server-side `urn:ok:error:invalid-request`
 * detail actionable, matching the bar set by the semantic handler errors
 * Runs only when a value is present — `.optional()` admits an
 * omitted field, gated separately at the handler.
 */
function checkDocName(value: string, ctx: z.RefinementCtx): void {
  const result = validateDocName(value);
  if (!result.ok) {
    ctx.addIssue({ code: 'custom', message: result.reason });
  }
}

export const safeDocNameField = z.string().superRefine(checkDocName).optional();

/**
 * Identity fields shared by every mutating handler. All optional —
 * `extractAgentIdentity` in `api-extension.ts` carries the default-agent
 * fallback for missing fields. The schema only validates the wire-level
 * type (string when present); semantic validation (e.g. agent-id regex)
 * stays inside `extractAgentIdentity`.
 */
export const agentIdentityFields = {
  agentId: z.string().optional(),
  agentName: z.string().optional(),
  colorSeed: z.string().optional(),
  clientName: z.string().optional(),
  clientVersion: z.string().optional(),
  label: z.string().optional(),
};

/**
 * Optional summary field shared by write / write-md / patch handlers.
 * Schema-rejected for non-string values (number, boolean, null, array,
 * object) — `urn:ok:error:invalid-request` pre-identity. Empty / whitespace
 * strings reach the handler and `normalizeSummary` classifies them as
 * `kind: 'absent'` (no adoption count).
 */
export const summaryField = z.string().optional();

/**
 * URI-form regex for the RFC 9457 `instance` field. Matches the RFC 4122
 * URN representation of a UUID — single token, no slashes / path segments,
 * so log-grep workflows can pattern-match it as a flat string.
 */
export const URN_UUID_RE =
  /^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
