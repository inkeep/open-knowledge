/**
 * One ingress policy for every admission gate — HTTP requests AND WebSocket
 * upgrades. Built once at boot from the resolved `server.*` runtime, then
 * threaded to every gate site: the surface admission prelude
 * (`admitRequestSurface`), the `/api/*` pipeline gates, the `/mcp` gates, the
 * collaboration host's upgrade admission, the config-doc admission, and the
 * local-op security checks. One policy, one set of predicates — the HTTP and
 * WS halves of the server can never disagree about who is admitted.
 *
 * Exposing the server is just these keys — `server.externalUrl` + a
 * `server.bind` + `server.allowExternal` consent — there is no separate
 * tunnel policy shape.
 *
 * The three predicates and what governs each:
 *
 *  - PEER (`isPeerAdmitted`) — the TCP peer address, the only unforgeable
 *    signal. Loopback always passes. `server.allowExternal` is the sanctioned
 *    relaxation: consent means "an authenticating edge fronts this port; OK
 *    may trust non-loopback peers". Nothing else relaxes it.
 *  - HOST (`isHostAdmitted`) — the name the client dialed (DNS-rebinding
 *    defense). Always validates, in every mode, against loopback names + the
 *    non-loopback bind-address literals + the declared `server.externalUrl`
 *    host. Consent does NOT widen this set: an unconfigured name stays
 *    refused, so a rebound page presenting the attacker's domain is refused
 *    no matter what the peer looks like.
 *  - ORIGIN (`isOriginAdmitted`) — browser CSRF defense; "if present, must
 *    match" (curl and MCP clients send none). Admits the loopback set, the
 *    null/file:// Electron shapes, the bind literals, and the declared
 *    public origin scheme-matched against `externalUrl`'s own scheme.
 *
 * Wildcard binds (`0.0.0.0`, `::`) contribute no Host names — they are not
 * nameable addresses. A deployment binding wide needs `server.externalUrl` for
 * any non-loopback name to be admitted; the boot hint says so.
 */

import type { IncomingMessage } from 'node:http';
import type { ServerRuntimeConfig } from '@inkeep/open-knowledge-core';
import { isAllowedApiOrigin } from './api-origin.ts';
import { isAllowedWorkspaceHostHeader, isLoopbackAddress } from './loopback.ts';

/** Strip a default-port suffix so `host:443`/`host:80` compare equal to `host`. */
export function normalizeHostHeader(host: string): string {
  return host.replace(/:(443|80)$/, '').toLowerCase();
}

/** True when a raw `Host` names the declared public host — for the Host gates. */
export function hostHeaderMatchesExternalHost(
  host: string | undefined,
  externalHost: string,
): boolean {
  return host !== undefined && normalizeHostHeader(host) === externalHost;
}

/**
 * Proxy-forwarding headers (standard `X-Forwarded-*` / `Forwarded` plus common
 * vendor ones). Their presence while the policy does not tolerate them means
 * a tunnel/proxy points at a server that never opted into exposure — the
 * tripwire refuses with a hint.
 */
const FORWARDING_HEADERS = [
  'x-forwarded-for',
  'x-forwarded-proto',
  'x-forwarded-host',
  'forwarded',
  'x-real-ip',
  'x-client-ip',
  'x-cluster-client-ip',
  'cf-connecting-ip',
  'fastly-client-ip',
  'true-client-ip',
] as const;

/** True when the request carries any standard proxy-forwarding header. */
export function hasForwardingHeaders(req: Pick<IncomingMessage, 'headers'>): boolean {
  return FORWARDING_HEADERS.some((h) => req.headers[h] !== undefined);
}

/**
 * Remediation detail for a `host-not-allowed` refusal. The read gate now fires
 * in normal mode, so a legitimate operator can trip it (a reverse proxy that
 * preserves the client Host, a `.local`/hosts-file alias pointing at a loopback
 * bind). The bare title names no fix; this detail tells them which config key
 * admits the host without reading source. Shared across every gate that emits
 * `host-not-allowed` so the guidance never drifts between sites.
 */
export const HOST_NOT_ADMITTED_REMEDIATION =
  'Add this host to server.bind or set server.externalUrl to it, then restart. Loopback (localhost/127.0.0.1/[::1]) is always admitted.';

export interface IngressPolicy {
  /**
   * Exposure consent (`server.allowExternal`, scope-correctly resolved).
   * Relaxes the loopback-PEER gate only — never Host/Origin validation.
   */
  allowExternal: boolean;
  /**
   * Non-loopback, non-wildcard `server.bind` literals, lowercased with any
   * IPv6 brackets stripped. Admitted as Host/Origin hostnames on any port —
   * rebinding-safe (a rebound page presents the attacker's domain, never
   * your bind address), and what makes `http://<tailnet-ip>:<port>` work
   * with zero extra config.
   */
  bindLiterals: readonly string[];
  /**
   * The declared canonical origin — the EXPLICIT `server.externalUrl`;
   * `host` is `host[:port]` with default ports stripped, `protocol` is
   * `http:`/`https:`, matched exactly for Origin checks since the key
   * admits http for tailnet/LAN deployments.
   */
  externalOrigin: { host: string; protocol: string } | undefined;
  /**
   * Proxy-forwarding headers tolerated (never trusted — addressing and
   * identity stay socket/config-derived). True under consent with a declared
   * public origin; otherwise their presence trips the proxied-request
   * tripwire.
   */
  tolerateForwardedHeaders: boolean;
}

/**
 * Boot refusal from the exposure consent interlock: the resolved runtime
 * declares external exposure (non-loopback bind, or `server.externalUrl`)
 * without `server.allowExternal`. The message IS the one-line fix; the CLI
 * maps it to EX_CONFIG like the other config-shaped boot errors.
 */
export class ExposureConsentError extends Error {}

export interface BuildIngressPolicyInput {
  /**
   * The resolved `server.*` runtime. Omit for a policy equivalent to the
   * loopback-only default (test rigs, legacy construction sites).
   */
  serverRuntime?: ServerRuntimeConfig | undefined;
}

/** Loopback / wildcard shapes that never contribute an admissible Host name. */
const NON_NAMEABLE_BINDS = new Set(['0.0.0.0', '::', 'localhost', '::1', '[::1]']);

function normalizeBindLiteral(address: string): string {
  const trimmed = address.trim().toLowerCase();
  return trimmed.startsWith('[') && trimmed.endsWith(']') ? trimmed.slice(1, -1) : trimmed;
}

export function buildIngressPolicy(input: BuildIngressPolicyInput): IngressPolicy {
  const runtime = input.serverRuntime;

  const bindLiterals =
    runtime === undefined
      ? []
      : runtime.bind
          .map(normalizeBindLiteral)
          .filter((addr) => !NON_NAMEABLE_BINDS.has(addr) && !addr.startsWith('127.'));

  let externalOrigin: IngressPolicy['externalOrigin'];
  if (runtime?.externalUrl !== undefined) {
    // The schema guarantees a parseable http(s) URL; a throw here would be a
    // schema/resolver drift bug, so let it propagate loudly at boot.
    const parsed = new URL(runtime.externalUrl);
    externalOrigin = { host: normalizeHostHeader(parsed.host), protocol: parsed.protocol };
  }

  const allowExternal = runtime?.allowExternal === true;
  return {
    allowExternal,
    bindLiterals,
    externalOrigin,
    tolerateForwardedHeaders: allowExternal && externalOrigin !== undefined,
  };
}

/**
 * PEER gate: loopback always passes; `allowExternal` admits any connected
 * peer (the deployer's edge owns who can reach the port). `undefined`
 * (socket gone) stays refused — no basis to attest anything.
 */
export function isPeerAdmitted(remoteAddress: string | undefined, policy: IngressPolicy): boolean {
  if (isLoopbackAddress(remoteAddress)) return true;
  return policy.allowExternal && remoteAddress !== undefined;
}

/** Hostname (no port, no IPv6 brackets, lowercased) of a raw Host header. */
function hostnameOfHostHeader(host: string): string | null {
  if (host.startsWith('[')) {
    const close = host.indexOf(']');
    if (close < 0) return null;
    return host.slice(1, close).toLowerCase();
  }
  const colon = host.lastIndexOf(':');
  return (colon >= 0 ? host.slice(0, colon) : host).toLowerCase();
}

/**
 * HOST gate: loopback names, the bind literals (any port), and the declared
 * `externalUrl` host (exact host[:port] after default-port normalization).
 * Never widened by consent.
 */
export function isHostAdmitted(host: string | undefined, policy: IngressPolicy): boolean {
  if (isAllowedWorkspaceHostHeader(host)) return true;
  if (host === undefined) return false;
  if (policy.bindLiterals.length > 0) {
    const hostname = hostnameOfHostHeader(host);
    if (hostname !== null && policy.bindLiterals.includes(hostname)) return true;
  }
  return (
    policy.externalOrigin !== undefined &&
    hostHeaderMatchesExternalHost(host, policy.externalOrigin.host)
  );
}

/**
 * ORIGIN gate ("if present, must match" — callers skip when absent): the
 * loopback/null/file:// set, the declared public origin (scheme-matched
 * against `externalUrl`'s own scheme), and the bind literals over http or
 * https.
 */
export function isOriginAdmitted(origin: string, policy: IngressPolicy): boolean {
  if (isAllowedApiOrigin(origin)) return true;
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  if (
    policy.externalOrigin !== undefined &&
    parsed.protocol === policy.externalOrigin.protocol &&
    normalizeHostHeader(parsed.host) === policy.externalOrigin.host
  ) {
    return true;
  }
  if (policy.bindLiterals.length > 0) {
    const hostname = normalizeBindLiteral(parsed.hostname);
    if (policy.bindLiterals.includes(hostname)) return true;
  }
  return false;
}

/**
 * Tripwire: proxy-forwarding headers on a request when the policy does not
 * tolerate them — a tunnel/proxy points at a server that never opted into
 * exposure. Callers refuse with the fix instruction.
 */
export function tripsForwardedHeaderTripwire(
  req: Pick<IncomingMessage, 'headers'>,
  policy: IngressPolicy,
): boolean {
  return !policy.tolerateForwardedHeaders && hasForwardingHeaders(req);
}

/**
 * Per-request ingress context, stamped once at admission — by the `/api/*`
 * pipeline for HTTP and by the collaboration host for WS upgrades — so both
 * halves of the server carry the same actor-bearing shape. `actor` is the
 * auth drop-in point: today every admitted request is the anonymous
 * local-owner surface (`undefined`); a future authentication layer resolves
 * a principal here at the one chokepoint instead of per route.
 */
export interface IngressRequestContext {
  /** Correlation id when the surface resolves one (HTTP `/api/*` only). */
  requestId: string | undefined;
  /** TCP-peer classification at admission time. */
  peerClass: 'loopback' | 'external' | 'unknown';
  /** Authenticated principal — always `undefined` until auth is un-deferred. */
  actor: undefined;
}

const ingressContexts = new WeakMap<IncomingMessage, IngressRequestContext>();

export function stampIngressContext(
  req: IncomingMessage,
  input: { requestId?: string | undefined },
): IngressRequestContext {
  const peer = req.socket?.remoteAddress;
  const context: IngressRequestContext = {
    requestId: input.requestId,
    peerClass: peer === undefined ? 'unknown' : isLoopbackAddress(peer) ? 'loopback' : 'external',
    actor: undefined,
  };
  ingressContexts.set(req, context);
  return context;
}

export function getIngressContext(req: IncomingMessage): IngressRequestContext | undefined {
  return ingressContexts.get(req);
}
