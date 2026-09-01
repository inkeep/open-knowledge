import { PROTOCOL_VERSION } from './protocol-version.ts';

export type ClientKind = 'web' | 'mcp' | 'desktop-main' | 'cli';

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
