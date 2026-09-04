import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

export const REQUEST_ID_HEADER = 'x-request-id';

const REQUEST_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;

export function resolveRequestId(req: IncomingMessage): string {
  const raw = req.headers[REQUEST_ID_HEADER];
  const candidate = Array.isArray(raw) ? raw[0] : raw;
  if (candidate !== undefined && REQUEST_ID_RE.test(candidate)) return candidate;
  return randomUUID();
}

const requestIds = new WeakMap<IncomingMessage, string>();

export function rememberRequestId(req: IncomingMessage, id: string): void {
  requestIds.set(req, id);
}

export function getRequestId(req: IncomingMessage): string | undefined {
  return requestIds.get(req);
}
