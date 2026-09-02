import {
  acquireProcessLock,
  type LockKind,
  markProcessLockDraining,
  ProcessLockCollisionError,
  type ProcessLockMetadata,
  readProcessLock,
  releaseProcessLock,
  updateProcessLockPort,
  waitForProcessLockDrain,
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
    url?: string;
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

export function updateServerLockPort(lockDir: string, port: number, url?: string): void {
  updateProcessLockPort({ lockName: 'server', lockDir, port, url });
}

export function readServerLock(lockDir: string): ServerLockMetadata | null {
  return readProcessLock({ lockName: 'server', lockDir });
}

export function lockAdvertisesUi(lock: Pick<ServerLockMetadata, 'capabilities'>): boolean {
  return !Array.isArray(lock.capabilities) || lock.capabilities.includes('ui');
}

export function releaseServerLock(lockDir: string, opts?: { deferUnlinkToExit?: boolean }): void {
  releaseProcessLock({ lockName: 'server', lockDir, ...opts });
}

export function markServerLockDraining(lockDir: string): void {
  markProcessLockDraining({ lockName: 'server', lockDir });
}

export function waitForServerLockDrain(
  lockDir: string,
  opts?: { timeoutMs?: number; pollIntervalMs?: number },
): Promise<'no-drain' | 'released' | 'timeout'> {
  return waitForProcessLockDrain({ lockName: 'server', lockDir, ...opts });
}
