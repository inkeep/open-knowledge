/**
 * UI-level process lock — exclusive per-project UI process ownership.
 *
 * Thin adapter around `acquireProcessLock` in `process-lock.ts`. Only one
 * `ok ui` process may own a given contentDir at a time. The lock file at
 * `<lockDir>/ui.lock` contains JSON metadata used for stale detection and
 * for MCP tool preview-url discovery (see `preview-url.ts`).
 *
 * `lockDir` is `<contentDir>/.ok` by convention.
 *
 * Sibling of `server-lock.ts` (guards the Hocuspocus collab server) and
 * `shadow-lock.ts` (guards the shadow repo). All three share
 * `process-lock.ts` for the acquisition/release/port-update plumbing.
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

export type UiLockMetadata = ProcessLockMetadata;

export class UiLockCollisionError extends ProcessLockCollisionError {
  constructor(existing: UiLockMetadata, lockPath: string) {
    super(existing, lockPath, 'ui');
    this.name = 'UiLockCollisionError';
  }
}

export function acquireUiLock(
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
    const handle = acquireProcessLock({ lockName: 'ui', lockDir, metadata: init });
    return handle.lockPath;
  } catch (err) {
    if (err instanceof ProcessLockCollisionError && err.lockName === 'ui') {
      throw new UiLockCollisionError(err.existing, err.lockPath);
    }
    throw err;
  }
}

export function updateUiLockPort(lockDir: string, port: number): void {
  updateProcessLockPort({ lockName: 'ui', lockDir, port });
}

export function readUiLock(lockDir: string): UiLockMetadata | null {
  return readProcessLock({ lockName: 'ui', lockDir });
}

export function releaseUiLock(lockDir: string): void {
  releaseProcessLock({ lockName: 'ui', lockDir });
}
