import { randomUUID } from 'node:crypto';
import {
  type KeepaliveHandle,
  type KeepaliveLogger,
  startKeepalive,
} from '@inkeep/open-knowledge-core/keepalive';
import type { DesktopLogger } from './desktop-logger.ts';
import { lockWsOrigin, type ServerLockMetadataLike } from './window-manager.ts';

export function toKeepaliveLogger(logger: DesktopLogger): KeepaliveLogger {
  return {
    info: (msg, ctx) => logger.info(ctx ?? {}, msg),
    warn: (msg, ctx) => logger.warn(ctx ?? {}, msg),
    error: (msg, ctx) => logger.error(ctx ?? {}, msg),
    debug: (msg, ctx) => logger.debug(ctx ?? {}, msg),
  };
}

export interface CreateDesktopKeepaliveDeps {
  readServerLock(lockDir: string): ServerLockMetadataLike | null;
  logger: KeepaliveLogger;
}

export interface CreateDesktopKeepaliveOpts {
  lockDir: string;
}

export function resolveKeepaliveWsOrigin(lock: ServerLockMetadataLike | null): string | undefined {
  if (!lock) return undefined;
  if (typeof lock.port !== 'number' || lock.port <= 0) return undefined;
  return lockWsOrigin(lock);
}

export function createDesktopKeepaliveFactory(
  deps: CreateDesktopKeepaliveDeps,
): (opts: CreateDesktopKeepaliveOpts) => KeepaliveHandle {
  return (opts) => {
    const connectionId = randomUUID();
    return startKeepalive({
      resolveWsUrl: async () => resolveKeepaliveWsOrigin(deps.readServerLock(opts.lockDir)),
      connectionId,
      pid: process.pid,
      logger: deps.logger,
    });
  };
}
