/**
 * Frontmatter validation error envelope — shared shape for L1 (client binding),
 * L3 (persistence-hook revert), and CC1 broadcast payload.
 *
 * Mirrors the `ConfigValidationError` discriminated union but scoped to the
 * shapes produced by frontmatter writes:
 *   - `SCHEMA_INVALID` — one or more keys' values failed `FrontmatterValueSchema`
 *     or the patch contained a reserved key (e.g. legacy `'frontmatter'` slot).
 *   - `WRITE_ERROR` — the binding was disposed, or the doc/text was unavailable.
 *
 * `issueCode` is preserved per-issue so consumers can render typed messages
 * (e.g. "Invalid date format" vs "Number expected"). `path` is `[key]` for
 * top-level frontmatter values; nested paths surface for list-element issues
 * if a future schema admits structured values.
 */
import { z } from 'zod';

export const FrontmatterIssueSchema = z.object({
  /** Frontmatter key that produced the issue (e.g. `['title']`). */
  path: z.array(z.union([z.string(), z.number()])),
  message: z.string(),
  issueCode: z.string(),
});

export type FrontmatterIssue = z.infer<typeof FrontmatterIssueSchema>;

export const FrontmatterValidationErrorSchema = z.discriminatedUnion('code', [
  z.object({
    code: z.literal('SCHEMA_INVALID'),
    issues: z.array(FrontmatterIssueSchema),
  }),
  z.object({
    code: z.literal('WRITE_ERROR'),
    detail: z.string(),
  }),
]);

export type FrontmatterValidationError = z.infer<typeof FrontmatterValidationErrorSchema>;

/** Convert a Zod issue to a `FrontmatterIssue`. Path entries are coerced to
 *  `string | number` (Zod's native path includes symbols which don't survive
 *  JSON serialization). */
export function toFrontmatterIssue(zIssue: z.core.$ZodIssue): FrontmatterIssue {
  return {
    path: zIssue.path.map((p) => (typeof p === 'symbol' ? String(p) : p)),
    message: zIssue.message,
    issueCode: zIssue.code,
  };
}

/** Build a `fieldErrors: Record<key, message>` map from a SCHEMA_INVALID
 *  error — convenience for UI consumers (PropertyPanel) that key error
 *  messages by the affected frontmatter field. Multi-issue keys are
 *  concatenated with `'; '`. */
export function fieldErrorsFromError(error: FrontmatterValidationError): Record<string, string> {
  if (error.code !== 'SCHEMA_INVALID') return {};
  const out: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path[0];
    if (typeof key !== 'string') continue;
    out[key] = out[key] ? `${out[key]}; ${issue.message}` : issue.message;
  }
  return out;
}
