/**
 * Same-origin collab WebSocket URL for the `/api/config` bootstrap payload.
 *
 * Host-reflecting by design: the shell loaded from this server, so
 * `ws(s)://<the client's own Host>/collab` reaches the same process the
 * request arrived on. The scheme honors `X-Forwarded-Proto` because tunnels
 * (ngrok, cloudflared, tailscale serve) terminate TLS at the edge and proxy
 * plain http inward — a browser on the https tunnel origin must be handed
 * `wss://`, or the mixed-content check blocks the socket outright.
 */

import type { IncomingMessage } from 'node:http';

export function collabUrlFromRequestHeaders(headers: IncomingMessage['headers']): string | null {
  const host = headers.host;
  if (!host) return null;
  const fwd = headers['x-forwarded-proto'];
  const proto = Array.isArray(fwd) ? fwd[0] : fwd;
  return `${proto === 'https' ? 'wss' : 'ws'}://${host}/collab`;
}
