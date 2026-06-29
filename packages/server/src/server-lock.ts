
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
