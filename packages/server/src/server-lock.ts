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
 * Sibling of `shadow-lock.ts` (guards a shadow repo). Both share
 * `process-lock.ts` for the lock acquisition/release/port-update plumbing and
 * `process-alive.ts` for liveness checks.
 */

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
    // Re-brand generic collision as ServerLockCollisionError for backward compat.
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

/**
 * Does a server.lock advertise a navigable UI surface? The single source of
 * truth for the UI-capability decision, shared by every resolution + display
 * surface so none can disagree on the "no UI" boundary now that `ui.lock` no
 * longer backstops the sibling topology:
 *   - server package: `resolveUiInfo` (preview-url.ts), `resolveUiRedirectPort`
 *     (ui-redirect-port.ts), `serverExplicitlyLacksUi` (get-preview-url.ts),
 *     and `createOffCwdResolverDeps.inspect` (off-cwd-resolver.ts);
 *   - CLI (imported via the package export): `ok status`, `ok ps`, and
 *     `resolveServerReuse` (start.ts).
 *
 * A missing `capabilities` field (older writer) is indeterminate and treated
 * as ui-capable: wrongly refusing a healthy server is worse than an optimistic
 * navigate. An explicit array WITHOUT `ui` (`--only server`, or a degraded
 * API-only boot) is a definitive no.
 *
 * Capability only — liveness / draining / port are the caller's concern, since
 * each surface needs a different shape (a base URL, a port, a hint selector).
 */
export function lockAdvertisesUi(lock: Pick<ServerLockMetadata, 'capabilities'>): boolean {
  return !Array.isArray(lock.capabilities) || lock.capabilities.includes('ui');
}

export function releaseServerLock(lockDir: string, opts?: { deferUnlinkToExit?: boolean }): void {
  releaseProcessLock({ lockName: 'server', lockDir, ...opts });
}

/** Mark our server.lock draining — teardown began; unlink happens at exit. */
export function markServerLockDraining(lockDir: string): void {
  markProcessLockDraining({ lockName: 'server', lockDir });
}

/** Wait for a draining server holder to exit before acquiring/attaching. */
export function waitForServerLockDrain(
  lockDir: string,
  opts?: { timeoutMs?: number; pollIntervalMs?: number },
): Promise<'no-drain' | 'released' | 'timeout'> {
  return waitForProcessLockDrain({ lockName: 'server', lockDir, ...opts });
}
