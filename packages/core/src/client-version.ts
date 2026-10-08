import type { EmbeddedHost } from './constants/embedded-host.ts';
import { PROTOCOL_VERSION } from './protocol-version.ts';

export type ClientSurface = 'desktop' | 'browser' | `embedded:${NonNullable<EmbeddedHost>}`;

export type ClientKind = ClientSurface | 'mcp' | 'desktop-main' | 'cli';

export const CLIENT_SURFACE_ATTRIBUTE = 'ok.client.surface';

export const CLIENT_RUNTIME_VERSION_FALLBACK = '0.0.0-unknown';

export const CLIENT_VERSION_HEADER = {
  protocol: 'x-ok-client-protocol',
  runtime: 'x-ok-client-runtime',
  kind: 'x-ok-client-kind',
} as const;

export interface ClientVersionInput {
  readonly kind: ClientKind;
  readonly runtimeVersion: string;
}

export interface ClientVersionTokenFields {
  readonly clientProtocolVersion: number;
  readonly clientRuntimeVersion: string;
  readonly clientKind: ClientKind;
}

interface ClientSurfaceSignals {
  readonly hasDesktopBridge: boolean;
  readonly embeddedHost: EmbeddedHost;
}

const KNOWN_CLIENT_SURFACES: Readonly<Record<ClientSurface, true>> = {
  desktop: true,
  browser: true,
  'embedded:cursor': true,
  'embedded:codex': true,
  'embedded:claude-desktop': true,
};

const NON_SURFACE_CLIENT_KINDS: Readonly<Record<Exclude<ClientKind, ClientSurface>, true>> = {
  mcp: true,
  'desktop-main': true,
  cli: true,
};

export type ClientSurfaceReading = ClientSurface | 'unknown' | undefined;

function isClientSurface(value: string): value is ClientSurface {
  return Object.hasOwn(KNOWN_CLIENT_SURFACES, value);
}

export function deriveClientSurface({
  hasDesktopBridge,
  embeddedHost,
}: ClientSurfaceSignals): ClientSurface {
  if (hasDesktopBridge) return 'desktop';
  if (embeddedHost !== null) return `embedded:${embeddedHost}`;
  return 'browser';
}

export function readClientSurface(kind: string | undefined): ClientSurfaceReading {
  if (kind === undefined || kind.length === 0 || Object.hasOwn(NON_SURFACE_CLIENT_KINDS, kind)) {
    return undefined;
  }
  return isClientSurface(kind) ? kind : 'unknown';
}

export function clientVersionHeaders({
  kind,
  runtimeVersion,
}: ClientVersionInput): Record<string, string> {
  return {
    [CLIENT_VERSION_HEADER.protocol]: String(PROTOCOL_VERSION),
    [CLIENT_VERSION_HEADER.runtime]: runtimeVersion,
    [CLIENT_VERSION_HEADER.kind]: kind,
  };
}

export function clientVersionTokenFields({
  kind,
  runtimeVersion,
}: ClientVersionInput): ClientVersionTokenFields {
  return {
    clientProtocolVersion: PROTOCOL_VERSION,
    clientRuntimeVersion: runtimeVersion,
    clientKind: kind,
  };
}
