import type { IncomingMessage } from 'node:http';
import type { ServerRuntimeConfig } from '@inkeep/open-knowledge-core';
import { isAllowedApiOrigin } from './api-origin.ts';
import { isAllowedWorkspaceHostHeader, isLoopbackAddress } from './loopback.ts';

export function normalizeHostHeader(host: string): string {
  return host.replace(/:(443|80)$/, '').toLowerCase();
}

export function hostHeaderMatchesExternalHost(
  host: string | undefined,
  externalHost: string,
): boolean {
  return host !== undefined && normalizeHostHeader(host) === externalHost;
}

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

export function hasForwardingHeaders(req: Pick<IncomingMessage, 'headers'>): boolean {
  return FORWARDING_HEADERS.some((h) => req.headers[h] !== undefined);
}

export const HOST_NOT_ADMITTED_REMEDIATION =
  'Add this host to server.bind or set server.externalUrl to it, then restart. Loopback (localhost/127.0.0.1/[::1]) is always admitted.';

export interface IngressPolicy {
  allowExternal: boolean;
  bindLiterals: readonly string[];
  externalOrigin: { host: string; protocol: string } | undefined;
  tolerateForwardedHeaders: boolean;
}

export class ExposureConsentError extends Error {}

export interface BuildIngressPolicyInput {
  serverRuntime?: ServerRuntimeConfig | undefined;
}

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

export function isPeerAdmitted(remoteAddress: string | undefined, policy: IngressPolicy): boolean {
  if (isLoopbackAddress(remoteAddress)) return true;
  return policy.allowExternal && remoteAddress !== undefined;
}

function hostnameOfHostHeader(host: string): string | null {
  if (host.startsWith('[')) {
    const close = host.indexOf(']');
    if (close < 0) return null;
    return host.slice(1, close).toLowerCase();
  }
  const colon = host.lastIndexOf(':');
  return (colon >= 0 ? host.slice(0, colon) : host).toLowerCase();
}

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

export function tripsForwardedHeaderTripwire(
  req: Pick<IncomingMessage, 'headers'>,
  policy: IngressPolicy,
): boolean {
  return !policy.tolerateForwardedHeaders && hasForwardingHeaders(req);
}

export interface IngressRequestContext {
  requestId: string | undefined;
  peerClass: 'loopback' | 'external' | 'unknown';
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
