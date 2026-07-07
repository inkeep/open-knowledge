/**
 * Server-level process lock — exclusive per-project server ownership.
 *
 * Thin adapter around `acquireProcessLock` in `process-lock.ts`. Only one
 * OpenKnowledge server process may own a given contentDir at a time. The
 * lock file at `<lockDir>/server.lock` contains JSON metadata used for
 * stale detection and for MCP port discovery.
 *
 * `lockDir` is `<contentDir>/.ok/local` by convention.
 *
 * Sibling of `shadow-lock.ts` (guards a shadow repo) and `ui-lock.ts`
 * (guards the UI process). All three share `process-lock.ts` for the lock
 * acquisition/release/port-update plumbing and `process-alive.ts` for
 * liveness checks.
 */

import {
  acquireProcessLock,
  type LockKind,
  ProcessLockCollisionError,
  type ProcessLockMetadata,
  readProcessLock,
  releaseProcessLock,
  updateProcessLockPort,
} from './process-lock.ts';

export type ServerLockMetadata = ProcessLockMetadata;

export class ServerLockCollisionError extends ProcessLockCollisionError {
  constructor(existing: ServerLockMetadata, lockPath: string) {
    super(existing, lockPath, 'server');
    this.name = 'ServerLockCollisionError';
  }
}

export function acquireServerLock(
  lockDir: string,
  init: {
    port: number;
    worktreeRoot: string;
    kind?: LockKind;
    parentPid?: number;
    capabilities?: string[];
  },
): string {
  try {
    const handle = acquireProcessLock({ lockName: 'server', lockDir, metadata: init });
    return handle.lockPath;
  } catch (err) {
    // Re-brand generic collision as ServerLockCollisionError for backward compat.
    if (err instanceof ProcessLockCollisionError && err.lockName === 'server') {
      throw new ServerLockCollisionError(err.existing, err.lockPath);
    }
    throw err;
  }
}

export function updateServerLockPort(lockDir: string, port: number): void {
  updateProcessLockPort({ lockName: 'server', lockDir, port });
}

export function readServerLock(lockDir: string): ServerLockMetadata | null {
  return readProcessLock({ lockName: 'server', lockDir });
}

export function releaseServerLock(lockDir: string): void {
  releaseProcessLock({ lockName: 'server', lockDir });
}
