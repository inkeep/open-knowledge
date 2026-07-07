import { type FrontmatterValidationError, fieldErrorsFromError } from '@inkeep/open-knowledge-core';

/**
 * Resolve a human-readable message for a frontmatter edit failure, keyed to the
 * field the user was editing. `WRITE_ERROR` carries a ready detail string;
 * otherwise prefer the per-field message (by `key`), then the first schema
 * issue, then the caller's fallback. Shared by the nested-editor widgets
 * (`ObjectWidget`, `ArrayOfObjectsWidget`) so the message resolution stays
 * identical across them.
 */
export function describeError(
  error: FrontmatterValidationError,
  key: string,
  fallback: string,
): string {
  if (error.code === 'WRITE_ERROR') return error.detail;
  const fieldErrors = fieldErrorsFromError(error);
  if (fieldErrors[key]) return fieldErrors[key];
  return error.issues[0]?.message ?? fallback;
}
