/**
 * Shared raw lockfile inspector for `ok stop` / `ok clean` / `ok status`.
 *
 * Unlike `readProcessLock` (which auto-removes a stale same-host lock as a
 * side effect), `inspectLock` is a pure peek — it classifies the lock state
 * but never mutates the filesystem. `ok clean` specifically needs this so it
 * can report the number of pruned locks rather than discovering them already
 * gone after a read.
 */

import { existsSync, readFileSync } from 'node:fs';
import { hostname } from 'node:os';
import {
  isProcessAlive,
  isValidLockPid,
  type LockName,
  lockFilePath,
  type ProcessLockMetadata,
} from '@inkeep/open-knowledge-server';

export type LockState =
  | { status: 'missing'; lockPath: string }
  | { status: 'corrupt'; lockPath: string }
  | { status: 'foreign-host'; lockPath: string; lock: ProcessLockMetadata }
  | { status: 'dead-pid'; lockPath: string; lock: ProcessLockMetadata }
  | { status: 'alive'; lockPath: string; lock: ProcessLockMetadata };

interface InspectLockOptions {
  /** Override for tests. Defaults to `isProcessAlive` from the server package. */
  isAlive?: (pid: number) => boolean;
  /** Override for tests. Defaults to `os.hostname()`. */
  host?: string;
}

export function inspectLock(
  lockDir: string,
  lockName: LockName,
  opts: InspectLockOptions = {},
): LockState {
  const lockPath = lockFilePath(lockDir, lockName);
  if (!existsSync(lockPath)) return { status: 'missing', lockPath };

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(lockPath, 'utf-8'));
  } catch {
    return { status: 'corrupt', lockPath };
  }
  if (!parsed || typeof parsed !== 'object' || !isValidLockPid((parsed as { pid?: unknown }).pid)) {
    // Reject hostile lock values (pid 0/1, NaN, non-integers, > 0x7fffffff)
    // before they reach `isProcessAlive` / `process.kill`. Lock files live
    // under user-writable `.ok/local/`, so the validator is the trust
    // boundary between disk-supplied data and signal-delivery code paths.
    return { status: 'corrupt', lockPath };
  }
  const lock = parsed as ProcessLockMetadata;

  // Liveness gate runs first — a dead PID classifies as `dead-pid` regardless
  // of hostname, so hostname-drifted stale locks (macOS BonjourName ↔ FQDN
  // across DHCP/VPN/sleep) can be pruned by `ok clean` and hidden by `ok ps`.
  // The previous order short-circuited on hostname mismatch, leaving dead
  // foreign-host locks stuck visible forever. Trade-off: a true cross-host
  // lock whose PID happens not to exist on this machine reclassifies from
  // `foreign-host` → `dead-pid`, but OK lock files don't span machines
  // (filesystem isn't shared in OK's deployment model), so a hostname-
  // mismatched lock with no local PID is overwhelmingly drift, not a real
  // remote server. `foreign-host` now means specifically "different hostname
  // AND PID exists locally" — i.e., the genuine same-machine drift case.
  const aliveProbe = opts.isAlive ?? isProcessAlive;
  if (!aliveProbe(lock.pid)) {
    return { status: 'dead-pid', lockPath, lock };
  }
  const localHost = opts.host ?? hostname();
  if (lock.hostname !== localHost) {
    return { status: 'foreign-host', lockPath, lock };
  }
  return { status: 'alive', lockPath, lock };
}
