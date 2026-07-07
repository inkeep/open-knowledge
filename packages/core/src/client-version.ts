/**
 * Client→server version metadata — the v1 wire contract.
 *
 * Every OpenKnowledge client (web app, MCP shim, desktop main process, CLI
 * commands) stamps its own version onto every request to the local server, so
 * a future server can refuse an incompatible peer and tell it to update or
 * respawn. The server does not read these today; "send now, read later" is
 * safe because unknown request headers are ignored by every current handler and
 * the auth-token schema is `.loose()` (unknown fields pass through).
 *
 * **This shape is a one-way door — append-only from the first release.** Once a
 * released client emits it, the future server-read logic must accept this exact
 * shape from every released/beta client forever; changes are additive only.
 *
 * Two transport-appropriate carriers, each chosen by where the future server
 * refusal will read it:
 *
 * | Transport            | Carrier                          | Builder                       |
 * | -------------------- | -------------------------------- | ----------------------------- |
 * | HTTP (browser + Node)| request headers (`x-ok-client-*`)| `clientVersionHeaders`        |
 * | Hocuspocus `/collab` | auth-token JSON fields           | `clientVersionTokenFields`    |
 *
 * The keepalive WS deliberately carries no version metadata: it has no
 * refusable requests (idle-shutdown signal only), and HTTP already covers the
 * same clients. A query-param carrier is left as additive future work rather
 * than locked into v1.
 *
 * Both dimensions travel: `protocol` (integer, the pure {@link PROTOCOL_VERSION}
 * constant — same across every package in an install) and `runtime` (the
 * install's semver — distinct from protocol so the server can validate them
 * independently). `runtimeVersion` is supplied by the caller because its source
 * differs per environment: Node clients read `RUNTIME_VERSION` from the adjacent
 * `@inkeep/open-knowledge-server` install; the browser reads a build-time-
 * injected value (it cannot read its own `package.json` at runtime).
 */
import { PROTOCOL_VERSION } from './protocol-version.ts';

/**
 * Which client originated a request. The desktop *renderer* sends `web` — it is
 * the identical bundle and transport to the web app; only the desktop *main*
 * (Node) process is `desktop-main`. `cli` covers `ok sync`/`pull`/`push`.
 */
export type ClientKind = 'web' | 'mcp' | 'desktop-main' | 'cli';

/**
 * Sentinel for an unresolved runtime semver. Matches the server's
 * `readRuntimeVersion()` fallback so server and client speak the same
 * "unknown" on the wire.
 *
 * It means "version unknown", NOT a literal `0.0.0-unknown` release. The
 * follow-up server-read spec must special-case it BEFORE any semver compare:
 * the value is valid semver, so e.g. `satisfies('0.0.0-unknown', '>=0.8.0')`
 * is `false` and a naive compare would refuse a client that simply couldn't
 * resolve its version rather than one that is actually incompatible.
 */
export const CLIENT_RUNTIME_VERSION_FALLBACK = '0.0.0-unknown';

/** HTTP header names. Lowercase `x-ok-*`, matching the existing convention. */
export const CLIENT_VERSION_HEADER = {
  protocol: 'x-ok-client-protocol',
  runtime: 'x-ok-client-runtime',
  kind: 'x-ok-client-kind',
} as const;

/** Inputs every builder needs: who the client is + its resolved runtime semver. */
export interface ClientVersionInput {
  readonly kind: ClientKind;
  readonly runtimeVersion: string;
}

/** Hocuspocus auth-token fields. `clientProtocolVersion` is a JSON number. */
export interface ClientVersionTokenFields {
  readonly clientProtocolVersion: number;
  readonly clientRuntimeVersion: string;
  readonly clientKind: ClientKind;
}

/** Build the three `x-ok-client-*` HTTP request headers. */
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

/** Build the Hocuspocus auth-token version fields (merged into the existing claim). */
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
