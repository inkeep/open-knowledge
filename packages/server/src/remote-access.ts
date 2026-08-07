/**
 * Remote access — trust-the-tunnel model.
 *
 * OK binds loopback; a tunnel (ngrok, cloudflared, tailscale, a reverse proxy)
 * terminates TLS and proxies in. OK does not authenticate remote callers, so
 * whoever reaches the tunnel gets the local-caller surface; restricting who
 * can reach it is the tunnel's job (edge auth). That is why remote access is
 * an explicit `ok start --remote` opt-in, never a config side effect.
 *
 * With remote enabled the server still requires a loopback socket (the tunnel
 * connects from loopback; the bind is loopback-only) and an allowlisted Host
 * (loopback names, or the `remote.url` host for tunnel clients) — the
 * DNS-rebinding defense, not authentication.
 *
 * `resolveRemoteAccess` (config → shape) and `isRemoteAdmitted` (request →
 * admit) are the two choke points every gate in `mcp-mount.ts` consumes.
 */

import type { IncomingMessage } from 'node:http';
import { DEFAULT_REMOTE_PORT } from '@inkeep/open-knowledge-core';
import type { Config } from './config/schema.ts';
import { isAllowedWorkspaceHostHeader, isLoopbackAddress } from './loopback.ts';

export interface ResolvedRemoteAccess {
  /** Normalized public base URL (no trailing slash); always https. */
  url: string;
  /** `host[:port]` of `url` with any default-port suffix stripped — Host-header comparand. */
  publicHost: string;
  /** Fixed listen port from config (`remote.port`, falling back to 24550). */
  port: number;
}

export class RemoteConfigError extends Error {}

/**
 * Resolve the `remote:` config to runtime shape. `null` when `remote.url` is
 * unset (the caller decides if that is fine or fatal). Throws
 * `RemoteConfigError` on an unusable url so `ok start --remote` fails loud.
 */
export function resolveRemoteAccess(config: Config | undefined): ResolvedRemoteAccess | null {
  const remote = config?.remote;
  if (remote === undefined || remote.url === undefined || remote.url === '') return null;
  let parsed: URL;
  try {
    parsed = new URL(remote.url);
  } catch {
    throw new RemoteConfigError(`remote.url is not a valid URL: ${remote.url}`);
  }
  if (parsed.protocol !== 'https:') {
    // Tunnels serve https; plain http would be credentials-in-the-clear.
    throw new RemoteConfigError(
      `remote.url must be https — it is the public tunnel URL remote clients connect to (got: ${remote.url})`,
    );
  }
  return {
    url: remote.url.replace(/\/+$/, ''),
    publicHost: normalizeHostHeader(parsed.host),
    port: remote.port ?? DEFAULT_REMOTE_PORT,
  };
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** Strip a default-port suffix so `host:443`/`host:80` compare equal to `host`. */
function normalizeHostHeader(host: string): string {
  return host.replace(/:(443|80)$/, '').toLowerCase();
}

/** True when a raw `Host` names the tunnel's public host — for the route-level Host gates, in remote mode. */
export function hostHeaderMatchesPublicHost(host: string | undefined, publicHost: string): boolean {
  return host !== undefined && normalizeHostHeader(host) === publicHost;
}

/** True when a browser `Origin` names the tunnel's public host over https — extends the loopback-origin CSRF gates in remote mode. */
export function originMatchesPublicHost(origin: string, publicHost: string): boolean {
  try {
    const url = new URL(origin);
    return url.protocol === 'https:' && normalizeHostHeader(url.host) === publicHost;
  } catch {
    return false;
  }
}

/**
 * Admit decision when remote is enabled: a loopback socket AND an allowlisted
 * Host (loopback names, or the tunnel's public host). Refusals are wrong-Host
 * callers, not unauthenticated ones — there is no auth tier.
 */
export function isRemoteAdmitted(
  req: Pick<IncomingMessage, 'headers'> & { socket: { remoteAddress?: string | undefined } },
  remote: ResolvedRemoteAccess,
): boolean {
  if (!isLoopbackAddress(req.socket.remoteAddress)) return false;
  const host = firstHeader(req.headers.host);
  if (isAllowedWorkspaceHostHeader(host)) return true;
  return host !== undefined && normalizeHostHeader(host) === remote.publicHost;
}

/**
 * Proxy-forwarding headers (standard `X-Forwarded-*` / `Forwarded` plus common
 * vendor ones). Their presence while remote is DISABLED means a tunnel points
 * at a server that never opted in — mcp-mount's tripwire refuses with a hint.
 */
const FORWARDING_HEADERS = [
  'x-forwarded-for',
  'x-forwarded-proto',
  'forwarded',
  'x-real-ip',
  'cf-connecting-ip',
  'true-client-ip',
] as const;

/** True when the request carries any standard proxy-forwarding header. */
export function hasForwardingHeaders(req: Pick<IncomingMessage, 'headers'>): boolean {
  return FORWARDING_HEADERS.some((h) => req.headers[h] !== undefined);
}
