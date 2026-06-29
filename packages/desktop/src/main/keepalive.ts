
import { randomUUID } from 'node:crypto';
import {
  type KeepaliveHandle,
  type KeepaliveLogger,
  startKeepalive,
} from '@inkeep/open-knowledge-core/keepalive';
import type { ServerLockMetadataLike } from './window-manager.ts';

export interface CreateDesktopKeepaliveDeps {
  readServerLock(lockDir: string): ServerLockMetadataLike | null;
  logger?: KeepaliveLogger;
}

export interface CreateDesktopKeepaliveOpts {
  lockDir: string;
}

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
      ...(deps.logger ? { logger: deps.logger } : {}),
    });
  };
}
