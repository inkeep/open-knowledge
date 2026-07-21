/**
 * Per-request correlation IDs for the `/api/*` surface.
 *
 * The `onRequest` gate stack in `api-extension.ts` resolves one ID per API
 * request — honoring a well-formed incoming `x-request-id` (so multi-hop
 * callers like the MCP shim can propagate their own ID) or minting a UUID —
 * then echoes it as an `x-request-id` response header, stamps it on the
 * request span (`ok.request.id`), and includes it on the `api.access` log
 * line. Handlers can read it via `getRequestId(req)` for their own log
 * lines; the WeakMap keeps the plumbing off the handler signatures until
 * the planned route split introduces a real per-request context object.
 */

import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

/** Canonical header name, shared by the inbound read and the response echo. */
export const REQUEST_ID_HEADER = 'x-request-id';

/**
 * Accepted shape for a client-supplied request ID. Bounded length + a
 * conservative token charset so a hostile header can't smuggle log-breaking
 * or header-splitting bytes into the echo/log path. Anything non-conforming
 * is silently replaced with a minted UUID (never an error — the ID is a
 * diagnostic courtesy, not an input contract).
 */
const REQUEST_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;

/**
 * Resolve the request ID for an incoming request: the validated inbound
 * `x-request-id` when present and well-formed, else a fresh UUID.
 */
export function resolveRequestId(req: IncomingMessage): string {
  const raw = req.headers[REQUEST_ID_HEADER];
  const candidate = Array.isArray(raw) ? raw[0] : raw;
  if (candidate !== undefined && REQUEST_ID_RE.test(candidate)) return candidate;
  return randomUUID();
}

const requestIds = new WeakMap<IncomingMessage, string>();

/** Associate the resolved ID with the request object (gate-stack only). */
export function rememberRequestId(req: IncomingMessage, id: string): void {
  requestIds.set(req, id);
}

/** Read the ID the gate stack resolved for this request, if any. */
export function getRequestId(req: IncomingMessage): string | undefined {
  return requestIds.get(req);
}
