/**
 * Desktop main-process `/collab/keepalive` WS factory.
 *
 * Builds a presence-invisible keepalive (no `clientName`/`displayName`/
 * `colorSeed`) against the project's running server, so the server's
 * idle-shutdown counter sees the desktop as an active WS client for as
 * long as a project window is open. When the window closes, the
 * `KeepaliveHandle.close()` call drops the WS and the idle counter falls
 * back to whatever MCP clients (if any) are still connected.
 *
 * The user IS the desktop. Rendering the desktop as a peer entry in the
 * agent-presence bar is redundant, so the identity fields are intentionally
 * omitted. The wired keepalive still counts toward `attachIdleShutdown`'s
 * `/collab*` upgrade tally (per `idle-shutdown.ts`'s
 * `req.url?.startsWith('/collab')` filter) — that's the only signal the
 * desktop needs to keep the server alive.
 *
 * The keepalive re-reads `server.lock` on each connect attempt via the
 * injected `readServerLock`, so a server restart on a different port is
 * picked up transparently after the configured backoff.
 */

import { randomUUID } from 'node:crypto';
import {
  type KeepaliveHandle,
  type KeepaliveLogger,
  startKeepalive,
} from '@inkeep/open-knowledge-core/keepalive';
import type { DesktopLogger } from './desktop-logger.ts';
import type { ServerLockMetadataLike } from './window-manager.ts';

/**
 * Adapt a pino-style `DesktopLogger` (`(data, msg)`) to the core
 * `KeepaliveLogger` (`(msg, ctx)`) — the two disagree on argument order.
 *
 * Load-bearing: without a logger the desktop keepalive runs silent, so its
 * connect / disconnect / backoff-retry lifecycle leaves no trace. When the
 * keepalive fails to hold the server's `/collab` socket, the server idle-
 * shuts-down while a window is open and there is nothing in the logs to say
 * why. This adapter is what makes that path observable.
 */
export function toKeepaliveLogger(logger: DesktopLogger): KeepaliveLogger {
  return {
    info: (msg, ctx) => logger.info(ctx ?? {}, msg),
    warn: (msg, ctx) => logger.warn(ctx ?? {}, msg),
    error: (msg, ctx) => logger.error(ctx ?? {}, msg),
    debug: (msg, ctx) => logger.debug(ctx ?? {}, msg),
  };
}

export interface CreateDesktopKeepaliveDeps {
  /**
   * Read `<lockDir>/server.lock` and return the parsed metadata, or `null`
   * when absent / corrupt. Same shape the WindowManager uses for the
   * attach-mode probe.
   */
  readServerLock(lockDir: string): ServerLockMetadataLike | null;
  /**
   * Required — the keepalive's connect / disconnect / backoff lifecycle is only
   * observable through this. Mandatory (not optional) so a future caller can't
   * silently revert to the pre-observability silent mode this module now closes.
   */
  logger: KeepaliveLogger;
}

export interface CreateDesktopKeepaliveOpts {
  /** `<contentDir>/.ok/local` — the project's lock directory. */
  lockDir: string;
}

/**
 * Pure factory — returns a `createKeepalive` callback compatible with
 * `WindowManagerDeps.createKeepalive`. Production wiring captures
 * `readServerLock` from the server package; tests inject a stub.
 */
export function createDesktopKeepaliveFactory(
  deps: CreateDesktopKeepaliveDeps,
): (opts: CreateDesktopKeepaliveOpts) => KeepaliveHandle {
  return (opts) => {
    const connectionId = randomUUID();
    return startKeepalive({
      resolveWsUrl: async () => {
        const lock = deps.readServerLock(opts.lockDir);
        if (!lock) return undefined;
        if (typeof lock.port !== 'number' || lock.port <= 0) return undefined;
        return `ws://localhost:${lock.port}`;
      },
      connectionId,
      pid: process.pid,
      // Presence-invisibility: intentionally omit displayName, clientName,
      // colorSeed. The desktop is the user, not a peer. The shared
      // `startKeepalive` only attaches identity params when ALL THREE are
      // present (see `packages/core/src/keepalive/keepalive.ts`).
      logger: deps.logger,
    });
  };
}
