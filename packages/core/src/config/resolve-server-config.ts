/**
 * Resolve the effective `server.*` runtime settings from a merged `Config`.
 *
 * The one job no zod `.default()` can do: **derived defaults.** `openBrowser`
 * and `idleShutdown` default off the resolved bind: a loopback-only server pops
 * the UI and idles out after {@link DEFAULT_LOOPBACK_IDLE_SHUTDOWN}; an exposed
 * or containerized server is headless and stays up. The local/hosted split is
 * emergent from these values — there is deliberately no mode key to branch on.
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
  externalUrl: string | undefined;
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
 * when THE SERVER'S OWN BIND reaches beyond this machine — i.e. a non-loopback
 * `server.bind`. `server.externalUrl` deliberately does NOT trip it on its own:
 * externalUrl is a project-scoped, committed, SHARED key (a team deploying to a
 * VPS legitimately commits `https://notes.example.com`), so refusing to boot
 * whenever it is set would lock out every teammate who clones that repo and
 * opens it locally (loopback bind) — especially in desktop, where
 * config-derived consent is forced off. Under a loopback bind a committed
 * externalUrl is inert metadata: nothing external reaches the server directly,
 * and a same-box reverse proxy's forwarded requests are still gated at request
 * time (the forwarded-header tripwire refuses them without consent). Only the
 * actual bind exposing the port is a boot-time consent question; externalUrl's
 * consent need surfaces at request time where a proxy actually appears.
 *
 * The boot path that enforces this MUST resolve `allowExternal`
 * scope-correctly — through `mergeLayered` over all three layers (which skips
 * the committed project layer for the project-local consent leaf), or by
 * reading the leaf from the project-local layer directly.
 */
export function requiresExternalConsent(
  resolved: Pick<ServerRuntimeConfig, 'loopbackOnly'>,
): boolean {
  return !resolved.loopbackOnly;
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

  const bind =
    server?.bind === undefined || server.bind.length === 0 ? DEFAULT_SERVER_BIND : server.bind;
  const loopbackOnly = isLoopbackOnlyBind(bind);

  const port = server?.port;
  const externalUrl = server?.externalUrl;

  return {
    port,
    bind,
    externalUrl,
    allowExternal: server?.allowExternal ?? false,
    openBrowser: server?.openBrowser ?? loopbackOnly,
    idleShutdown: server?.idleShutdown ?? (loopbackOnly ? DEFAULT_LOOPBACK_IDLE_SHUTDOWN : 'off'),
    loopbackOnly,
  };
}
