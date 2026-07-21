/**
 * Small shared idioms for `api-extension.ts` handlers: query-string parsing
 * and errno extraction. Extracted so handlers stop hand-rolling competing
 * variants (two `new URL(...)` base idioms; repeated
 * `(err as NodeJS.ErrnoException).code` casts).
 */

import type { IncomingMessage } from 'node:http';

/**
 * Parse the request's query string.
 *
 * Uses a fixed dummy base rather than deriving one from the `Host` header:
 * query parsing never needs the authority component, and a malformed `Host`
 * header would make `new URL(req.url, `http://${host}`)` throw — turning a
 * hostile header into a 500 on an otherwise-valid request.
 */
export function parseQuery(req: IncomingMessage): URLSearchParams {
  return new URL(req.url ?? '', 'http://localhost').searchParams;
}

/**
 * Extract the string `code` from a Node errno-style error (`'ENOENT'`,
 * `'EACCES'`, ...). Returns `undefined` for non-objects, errors without a
 * `code`, and non-string codes — callers compare against errno literals, so
 * `undefined` behaves like any non-matching code.
 */
export function errnoCode(err: unknown): string | undefined {
  const code = (err as NodeJS.ErrnoException | null | undefined)?.code;
  return typeof code === 'string' ? code : undefined;
}
