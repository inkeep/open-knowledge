import { type FrontmatterValidationError, fieldErrorsFromError } from '@inkeep/open-knowledge-core';

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
