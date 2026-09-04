import type { IncomingMessage } from 'node:http';

export function collabUrlFromRequestHeaders(headers: IncomingMessage['headers']): string | null {
  const host = headers.host;
  if (!host) return null;
  const fwd = headers['x-forwarded-proto'];
  const proto = Array.isArray(fwd) ? fwd[0] : fwd;
  return `${proto === 'https' ? 'wss' : 'ws'}://${host}/collab`;
}
