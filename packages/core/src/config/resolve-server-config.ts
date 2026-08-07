/**
 * Resolve the effective `server.*` runtime settings from a merged `Config`.
 *
 * Two jobs no zod `.default()` can do:
 *
 *  1. **Alias-read of the superseded `remote.*` keys.** `remote.url` is read
 *     only while `server.publicUrl` is absent; `remote.port` only while
 *     `server.port` is absent — the same shape as the `autoSync.enabled` →
 *     `autoSync.mode` alias. This resolver is the single alias-read point;
 *     no other reader should consult `remote.*` for these values.
 *
 *  2. **Derived defaults.** `openBrowser` and `idleShutdown` default off the
 *     resolved bind: a loopback-only server pops the UI and idles out after
 *     {@link DEFAULT_LOOPBACK_IDLE_SHUTDOWN}; an exposed or containerized
 *     server is headless and stays up. The local/hosted split is emergent
 *     from these values — there is deliberately no mode key to branch on.
 *
 * Enforcing the exposure interlock (refusing to boot when
 * {@link requiresExternalConsent} is true and `allowExternal` is not) is the
 * boot pipeline's job, not this resolver's — this module only computes the
 * predicate.
 */

import type { Config } from './schema.ts';
import { DEFAULT_SERVER_BIND, IDLE_SHUTDOWN_DURATION_RE } from './schema.ts';

/** Derived `idleShutdown` for a loopback-only server; exposed binds derive `'off'`. */
export const DEFAULT_LOOPBACK_IDLE_SHUTDOWN = '30m';

export interface ServerRuntimeConfig {
  /**
   * Explicit listener port; `undefined` means dynamic (the caller picks a
   * free port, or the platform's PORT environment decides).
   */
  port: number | undefined;
  /** Bind addresses; defaults to loopback-only (`DEFAULT_SERVER_BIND`). */
  bind: readonly string[];
  /**
   * Canonical external origin; `undefined` means derive
   * `http://localhost:<port>` for a loopback server.
   */
  publicUrl: string | undefined;
  /** Exposure consent interlock (see `requiresExternalConsent`). */
  allowExternal: boolean;
  /** Open the UI in a browser at start. Derived when not set explicitly. */
  openBrowser: boolean;
  /** `'off'`, or a duration like `'30m'`. Derived when not set explicitly. */
  idleShutdown: string;
  /** True when every bind address is loopback — the derivation input. */
  loopbackOnly: boolean;
}

/** A valid 0–255 IPv4 octet, so `127.999.0.1` doesn't read as loopback. */
const IPV4_OCTET = '(25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)';
const LOOPBACK_V4_RE = new RegExp(`^127\\.${IPV4_OCTET}\\.${IPV4_OCTET}\\.${IPV4_OCTET}$`);

/**
 * True for addresses that stay on this machine: `localhost`, the whole
 * 127.0.0.0/8 IPv4 block (octet-validated), and IPv6 `::1` (bracketed or
 * bare). `0.0.0.0` and `::` are NOT loopback — they are the classic
 * all-interfaces exposure. Anything malformed (`127.999.0.1`) is treated as
 * non-loopback, the fail-closed direction for the consent interlock: it errs
 * toward requiring consent, and an unbindable address fails at bind() anyway.
 */
export function isLoopbackBindAddress(address: string): boolean {
  const normalized = address.trim().toLowerCase();
  if (normalized === 'localhost' || normalized === '::1' || normalized === '[::1]') return true;
  return LOOPBACK_V4_RE.test(normalized);
}

/** True when every address in the bind list is loopback. */
export function isLoopbackOnlyBind(bind: readonly string[]): boolean {
  return bind.every(isLoopbackBindAddress);
}

/**
 * The single predicate behind the exposure interlock: consent is required
 * when the server is reachable beyond this machine — a non-loopback bind
 * address, or a declared external origin (`publicUrl`, including one
 * alias-read from `remote.url`).
 *
 * Wave 4 wiring requirement: the boot path that enforces this MUST resolve
 * `allowExternal` scope-correctly — through `mergeLayered` over all three
 * layers (which fills the project-local default so a committed project-file
 * value can't win), or by reading the leaf from the project-local layer
 * directly. The CLI's `loader.ts` currently merges only user + project with a
 * scope-blind deep merge, so consuming its `Config` here would let a
 * hand-edited committed `server.allowExternal: true` arm exposure on a
 * cloner's machine — the exact leak the project-local scope exists to prevent.
 */
export function requiresExternalConsent(
  resolved: Pick<ServerRuntimeConfig, 'loopbackOnly' | 'publicUrl'>,
): boolean {
  return !resolved.loopbackOnly || resolved.publicUrl !== undefined;
}

/**
 * Convert a validated `idleShutdown` value to milliseconds; `null` for
 * `'off'`. Throws on a string the schema would have rejected — callers hold
 * schema-validated config, so a mismatch here is a programming error, not a
 * user error.
 */
export function idleShutdownToMs(value: string): number | null {
  if (value === 'off') return null;
  // Validate against the single canonical grammar (shared with the schema
  // leaf), then split: the match guarantees a trailing s/m/h with a positive
  // integer before it.
  if (!IDLE_SHUTDOWN_DURATION_RE.test(value)) {
    throw new Error(`invalid idleShutdown duration: ${JSON.stringify(value)}`);
  }
  const amount = Number(value.slice(0, -1));
  switch (value.at(-1)) {
    case 's':
      return amount * 1000;
    case 'm':
      return amount * 60_000;
    default:
      return amount * 3_600_000;
  }
}

export function resolveServerRuntimeConfig(config: Config | undefined): ServerRuntimeConfig {
  const server = config?.server;
  const remote = config?.remote;

  const bind =
    server?.bind === undefined || server.bind.length === 0 ? DEFAULT_SERVER_BIND : server.bind;
  const loopbackOnly = isLoopbackOnlyBind(bind);

  // Alias-reads: the successor key wins whenever present; an empty-string
  // `remote.url` reads as unset (matching `resolveRemoteAccess`).
  const port = server?.port ?? remote?.port;
  const legacyUrl = remote?.url === '' ? undefined : remote?.url;
  const publicUrl = server?.publicUrl ?? legacyUrl;

  return {
    port,
    bind,
    publicUrl,
    allowExternal: server?.allowExternal ?? false,
    openBrowser: server?.openBrowser ?? loopbackOnly,
    idleShutdown: server?.idleShutdown ?? (loopbackOnly ? DEFAULT_LOOPBACK_IDLE_SHUTDOWN : 'off'),
    loopbackOnly,
  };
}
