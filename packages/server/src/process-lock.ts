/**
 * Process lock factory — shared primitive for per-project process ownership.
 *
 * Only one OpenKnowledge process with a given `lockName` may own a lockDir
 * at a time. `lockDir` is `<contentDir>/.ok/local` by convention; the
 * lock file sits at `<lockDir>/<lockName>.lock` and contains JSON metadata
 * used for stale detection and port discovery.
 *
 * Used by both `server-lock.ts` (server.lock) and `ui-lock.ts` (ui.lock).
 */

import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { hostname } from 'node:os';
import { resolve } from 'node:path';
import { isProcessAlive, isValidLockPid } from './process-alive.ts';
import { PROTOCOL_VERSION, RUNTIME_VERSION } from './version-constants.ts';

export type LockName = 'server' | 'ui';

/**
 * Who started this server. `interactive` means a user-facing CLI/Electron
 * boot; `mcp-spawned` means an MCP-driven detach-spawn (see
 * `packages/cli/src/mcp/server-discovery.ts`). Desktop attach validation
 * uses this to refuse non-collab-capable peers.
 */
export type LockKind = 'interactive' | 'mcp-spawned';

export interface ProcessLockMetadata {
  pid: number;
  hostname: string;
  /** HTTP/WebSocket port. 0 means "starting — port not yet bound". */
  port: number;
  startedAt: string;
  worktreeRoot: string;
  /**
   * Optional — absent on locks written by older binaries. Readers MUST
   * tolerate `undefined` and fall through to conservative paths
   * (e.g., the desktop refuses to attach when kind is missing).
   */
  kind?: LockKind;
  /**
   * Pid of the *spawner* — not `process.ppid` (which gets reparented to
   * launchd when the spawn is detached). For `mcp-spawned`: the MCP server's
   * pid. For `interactive`: the user-facing host (CLI shell, Electron main).
   * Optional for legacy-lock tolerance.
   */
  parentPid?: number;
  /**
   * Protocol/feature surfaces this server exposes. v1: `["http", "ws"]`
   * for any server booted via `bootServer`. Forward-compat for variants
   * that lack one or the other.
   */
  capabilities?: string[];
  /**
   * Cross-process contract version. Optional in the type to support locks
   * written by binaries predating the field; the MCP protocol gate uses
   * `readProcessLockDetailed` to classify missing-field locks as
   * `'incompatible'`.
   *
   * Always present in locks written by binaries:
   * `acquireProcessLock` defaults to the current `PROTOCOL_VERSION` constant.
   */
  protocolVersion?: number;
  /**
   * Semver of the binary that wrote the lock. Used for diagnostic messages on
   * protocol mismatch. Optional for the same reason as `protocolVersion`.
   */
  runtimeVersion?: string;
}

export interface ProcessLockHandle {
  lockPath: string;
  release: () => void;
  updatePort: (port: number) => void;
}

export class ProcessLockCollisionError extends Error {
  readonly existing: ProcessLockMetadata;
  readonly lockPath: string;
  readonly lockName: LockName;
  constructor(existing: ProcessLockMetadata, lockPath: string, lockName: LockName) {
    super(
      `OpenKnowledge ${lockName} already running on port ${existing.port} ` +
        `(pid ${existing.pid}, started ${existing.startedAt}). ` +
        `Stop it first or use a different directory. Lock: ${lockPath}`,
    );
    this.name = 'ProcessLockCollisionError';
    this.existing = existing;
    this.lockPath = lockPath;
    this.lockName = lockName;
  }
}

export function lockFilePath(lockDir: string, lockName: LockName): string {
  return resolve(lockDir, `${lockName}.lock`);
}

/**
 * Per-process active-acquire refcount keyed by lockPath. Bumped on every
 * successful `acquireProcessLock` (path 1: atomic create, path 2: same-pid
 * idempotent rewrite, path 3: stale replacement). Decremented by
 * `releaseProcessLock`, which only unlinks the lock file when the count
 * reaches zero.
 *
 * Why this matters: the Vite dev plugin (`packages/app/src/server/
 * hocuspocus-plugin.ts`) calls `createServer()` per `configureServer`
 * invocation. A `vite.config.ts` edit triggers Vite's `restartServer`,
 * which fires `_createServer` (acquiring lock #2 idempotently) BEFORE
 * `await server.close()` (firing pass-1's close handler → destroy →
 * `releaseServerLock`). Without refcounting, pass-1's release would
 * `unlinkSync` the lock file out from under the still-running pass-2
 * srv, silently breaking the cross-process `ServerLockCollisionError`
 * guarantee until the developer kills + restarts `bun run dev`.
 *
 * The map is process-local (in-memory). Stale entries from crashed
 * processes are not relevant — those processes are dead, so their
 * refcounts cease to matter; the next process's `acquireProcessLock`
 * detects the orphaned lock file via `isProcessAlive` and replaces it.
 */
const activeLockRefs = new Map<string, number>();

function bumpActiveLockRef(lockPath: string): void {
  activeLockRefs.set(lockPath, (activeLockRefs.get(lockPath) ?? 0) + 1);
}

/**
 * Decrement the refcount. Returns `true` when the count reaches zero (the
 * caller should proceed with `unlinkSync`); returns `false` when other
 * active acquires still hold the lock (caller MUST NOT unlink).
 *
 * Untracked release (no prior acquire in this process — e.g. a process-exit
 * fallback after the close-handler path already drained refs) returns `true`
 * so the original ownership-guarded unlink path runs; that path is itself
 * idempotent and a missing-file is a no-op.
 */
function dropActiveLockRef(lockPath: string): boolean {
  const current = activeLockRefs.get(lockPath);
  if (current === undefined || current <= 1) {
    activeLockRefs.delete(lockPath);
    return true;
  }
  activeLockRefs.set(lockPath, current - 1);
  return false;
}

function parseLock(lockPath: string, logPrefix: string): ProcessLockMetadata | null {
  try {
    const parsed = JSON.parse(readFileSync(lockPath, 'utf-8'));
    if (parsed && typeof parsed === 'object' && isValidLockPid((parsed as { pid?: unknown }).pid)) {
      return parsed as ProcessLockMetadata;
    }
    console.warn(`${logPrefix} Corrupt lock file at ${lockPath} — replacing`);
    return null;
  } catch {
    console.warn(`${logPrefix} Corrupt lock file at ${lockPath} — replacing`);
    return null;
  }
}

/**
 * Acquire an exclusive process lock.
 *
 * - No existing lock → write ours atomically via O_CREAT|O_EXCL.
 * - Stale lock (dead pid OR foreign host) → replace with warning.
 * - Our own pid → idempotent rewrite (refreshes port/startedAt).
 * - Live foreign pid on same host → throw ProcessLockCollisionError.
 * - Corrupt lock file → treat as stale.
 *
 * Create uses `openSync(path, 'wx')` (O_CREAT|O_EXCL) rather than a
 * check-then-write pattern so two concurrent `ok start` invocations cannot
 * both succeed via last-writer-wins. If we lose the create race, we
 * re-inspect the winner's lock (bounded retry) and classify it as any other
 * existing lock.
 *
 * Written with mode `0o600` — on shared multi-user hosts the lockfile
 * contents (pid, hostname, port, worktreeRoot) are owner-only.
 */
export function acquireProcessLock(opts: {
  lockName: LockName;
  lockDir: string;
  metadata: {
    port: number;
    worktreeRoot: string;
    kind?: LockKind;
    parentPid?: number;
    capabilities?: string[];
    /** Override the auto-populated protocolVersion. Primarily for tests. */
    protocolVersion?: number;
    /** Override the auto-populated runtimeVersion. Primarily for tests. */
    runtimeVersion?: string;
  };
}): ProcessLockHandle {
  const { lockName, lockDir, metadata: init } = opts;
  const logPrefix = `[${lockName}-lock]`;

  mkdirSync(lockDir, { recursive: true });
  const lockPath = lockFilePath(lockDir, lockName);

  const record: ProcessLockMetadata = {
    pid: process.pid,
    hostname: hostname(),
    port: init.port,
    startedAt: new Date().toISOString(),
    worktreeRoot: init.worktreeRoot,
    ...(init.kind !== undefined && { kind: init.kind }),
    ...(init.parentPid !== undefined && { parentPid: init.parentPid }),
    ...(init.capabilities !== undefined && { capabilities: init.capabilities }),
    protocolVersion: init.protocolVersion ?? PROTOCOL_VERSION,
    runtimeVersion: init.runtimeVersion ?? RUNTIME_VERSION,
  };
  const payload = JSON.stringify(record, null, 2);

  const MAX_ATTEMPTS = 3;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (!existsSync(lockPath)) {
      // Atomic create — only one writer wins the race against a concurrent
      // acquire attempting to grab the same file.
      try {
        const fd = openSync(lockPath, 'wx', 0o600);
        try {
          writeSync(fd, payload);
        } finally {
          closeSync(fd);
        }
        bumpActiveLockRef(lockPath);
        return buildHandle({ lockName, lockDir, lockPath });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
        // EEXIST — another acquire raced us; fall through to re-inspect.
      }
    }

    const existing = parseLock(lockPath, logPrefix);
    if (existing) {
      const sameHost = existing.hostname === hostname();
      if (sameHost && existing.pid === process.pid) {
        // Idempotent rewrite — our own lock. Safe to overwrite in place;
        // O_EXCL is not needed here (we can't race ourselves). Bumps the
        // refcount so the corresponding releaseProcessLock decrement
        // doesn't unlink the file out from under the prior holder. See
        // `activeLockRefs` doc for the Vite-restart scenario this
        // protects against.
        writeFileSync(lockPath, payload, { encoding: 'utf-8', mode: 0o600 });
        bumpActiveLockRef(lockPath);
        return buildHandle({ lockName, lockDir, lockPath });
      }
      if (sameHost && isProcessAlive(existing.pid)) {
        throw new ProcessLockCollisionError(existing, lockPath, lockName);
      }
      console.warn(
        `${logPrefix} Stale lock detected (pid=${existing.pid}, host=${existing.hostname}) — replacing`,
      );
    }

    // Stale or corrupt lock — unlink and retry the atomic create. Bounded so a
    // pathological loser (whose stale unlink keeps racing against a concurrent
    // create) can't spin forever.
    try {
      unlinkSync(lockPath);
    } catch {
      // Another acquire already unlinked — fine, fall through and retry.
    }
  }

  throw new Error(
    `${logPrefix} Failed to acquire ${lockPath} after ${MAX_ATTEMPTS} attempts (concurrent acquire contention).`,
  );
}

function buildHandle(args: {
  lockName: LockName;
  lockDir: string;
  lockPath: string;
}): ProcessLockHandle {
  const { lockName, lockDir, lockPath } = args;
  return {
    lockPath,
    release: () => releaseProcessLock({ lockName, lockDir }),
    updatePort: (port) => updateProcessLockPort({ lockName, lockDir, port }),
  };
}

/**
 * Update only the port field of our own lock. Preserves all other fields.
 * No-op if the lock file is missing, corrupt, or not ours.
 */
export function updateProcessLockPort(opts: {
  lockName: LockName;
  lockDir: string;
  port: number;
}): void {
  const { lockName, lockDir, port } = opts;
  const logPrefix = `[${lockName}-lock]`;
  const lockPath = lockFilePath(lockDir, lockName);

  if (!existsSync(lockPath)) {
    console.warn(`${logPrefix} Lock file missing at ${lockPath} during port update — skipping`);
    return;
  }

  let existing: ProcessLockMetadata;
  try {
    const parsed = JSON.parse(readFileSync(lockPath, 'utf-8'));
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      !isValidLockPid((parsed as { pid?: unknown }).pid)
    ) {
      console.warn(`${logPrefix} Corrupt lock at ${lockPath} during port update — skipping`);
      return;
    }
    existing = parsed as ProcessLockMetadata;
  } catch {
    console.warn(`${logPrefix} Unreadable lock at ${lockPath} during port update — skipping`);
    return;
  }
  if (existing.pid !== process.pid) return;
  // Match the cross-host guard in releaseProcessLock — pid alone can collide
  // across hosts on a shared content volume (NFS, etc.).
  if (typeof existing.hostname === 'string' && existing.hostname !== hostname()) return;

  existing.port = port;
  try {
    // `mode: 0o600` — owner-only readable. Matches `acquireProcessLock`'s
    // atomic-create mode so port updates don't drop back to default (0644).
    writeFileSync(lockPath, JSON.stringify(existing, null, 2), {
      encoding: 'utf-8',
      mode: 0o600,
    });
  } catch (err) {
    console.warn(
      `${logPrefix} Failed to update port in ${lockPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Read the lock if it exists and the holder is alive on this host.
 * Returns null for missing, stale, cross-host, or corrupt locks. Cleans
 * up a stale lock as a side effect (same host, dead pid only).
 *
 * Locks missing the version fields (`protocolVersion` / `runtimeVersion`)
 * are returned as-is — the legacy callers (`tryAttachExistingServer` in the
 * desktop, `discoverServerUrl` in the CLI MCP) treat them the same as locks
 * with version fields. Use `readProcessLockDetailed` to classify version-blind
 * locks as `'incompatible'` (the MCP protocol gate path).
 */
export function readProcessLock(opts: {
  lockName: LockName;
  lockDir: string;
}): ProcessLockMetadata | null {
  const { lockName, lockDir } = opts;
  const lockPath = lockFilePath(lockDir, lockName);
  if (!existsSync(lockPath)) return null;

  let existing: ProcessLockMetadata;
  try {
    const parsed = JSON.parse(readFileSync(lockPath, 'utf-8'));
    if (!parsed || typeof parsed !== 'object' || !isValidLockPid((parsed as { pid?: unknown }).pid))
      return null;
    existing = parsed as ProcessLockMetadata;
  } catch {
    return null;
  }

  if (existing.hostname !== hostname()) return null;
  if (!isProcessAlive(existing.pid)) {
    try {
      unlinkSync(lockPath);
    } catch {
      // Raced another cleanup — fine
    }
    return null;
  }

  return existing;
}

/**
 * Tagged-union read for callers that need to distinguish "no lock" from
 * "live lock with missing version fields" (the MCP protocol gate).
 *
 * Statuses:
 * - `absent` — no lock file exists at all.
 * - `stale` — lock present + parseable, but holder is dead OR on a foreign
 *   host. The file is unlinked on the dead-pid path as a side effect; cross-
 *   host locks are NOT unlinked (they may be owned by a live process on
 *   another machine sharing the contentDir over NFS / shared volume).
 * - `live` — lock present, parseable, holder alive on this host, ALL version
 *   fields present. Compatible with the MCP gate's `protocolVersion` check.
 * - `incompatible` — lock present, parseable, holder alive, but missing one
 *   or both version fields (`protocolVersion` / `runtimeVersion`) OR the
 *   payload itself is corrupt/unparseable. The MCP gate refuses to attach
 *   in this state.
 */
export type ReadProcessLockResult =
  | { status: 'absent' }
  | { status: 'stale'; lock: ProcessLockMetadata }
  | { status: 'live'; lock: ProcessLockMetadata }
  | { status: 'incompatible'; reason: 'missing-fields' | 'corrupt'; raw: unknown };

export function readProcessLockDetailed(opts: {
  lockName: LockName;
  lockDir: string;
}): ReadProcessLockResult {
  const { lockName, lockDir } = opts;
  const lockPath = lockFilePath(lockDir, lockName);
  if (!existsSync(lockPath)) return { status: 'absent' };

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(lockPath, 'utf-8'));
  } catch {
    return { status: 'incompatible', reason: 'corrupt', raw: undefined };
  }

  if (!raw || typeof raw !== 'object') {
    return { status: 'incompatible', reason: 'corrupt', raw };
  }
  const r = raw as Partial<ProcessLockMetadata>;
  if (
    !isValidLockPid(r.pid) ||
    typeof r.hostname !== 'string' ||
    typeof r.port !== 'number' ||
    typeof r.startedAt !== 'string' ||
    typeof r.worktreeRoot !== 'string'
  ) {
    return { status: 'incompatible', reason: 'corrupt', raw };
  }

  const lock: ProcessLockMetadata = {
    pid: r.pid,
    hostname: r.hostname,
    port: r.port,
    startedAt: r.startedAt,
    worktreeRoot: r.worktreeRoot,
    protocolVersion: typeof r.protocolVersion === 'number' ? r.protocolVersion : undefined,
    runtimeVersion: typeof r.runtimeVersion === 'string' ? r.runtimeVersion : undefined,
  };

  if (lock.hostname !== hostname()) return { status: 'stale', lock };
  if (!isProcessAlive(lock.pid)) {
    try {
      unlinkSync(lockPath);
    } catch {
      // Raced another cleanup — fine
    }
    return { status: 'stale', lock };
  }

  if (lock.protocolVersion === undefined || lock.runtimeVersion === undefined) {
    return { status: 'incompatible', reason: 'missing-fields', raw };
  }

  return { status: 'live', lock };
}

/**
 * Release the lock. Safe to call multiple times. Only removes the lock if
 * we own it (pid AND hostname match) — prevents a rogue process from
 * unlinking a real server's lock. The hostname check matters on shared
 * content directories (NFS-mounted home, remote content volumes) where two
 * hosts can legitimately run processes with the same pid — without the
 * check we'd unlink a peer's lock.
 *
 * Refcount-aware: when this process holds multiple active acquires for the
 * same lockPath (Vite plugin per-`configureServer` createServer lifecycle),
 * release decrements the in-process refcount; the file is only unlinked
 * when the LAST active acquire releases. See `activeLockRefs` for the bug
 * class this protects against.
 */
export function releaseProcessLock(opts: { lockName: LockName; lockDir: string }): void {
  const { lockName, lockDir } = opts;
  const logPrefix = `[${lockName}-lock]`;
  const lockPath = lockFilePath(lockDir, lockName);
  if (!dropActiveLockRef(lockPath)) {
    // Other active acquires in this process still hold the lock — preserve
    // the file so cross-process collision detection keeps working.
    return;
  }
  if (!existsSync(lockPath)) return;
  try {
    const parsed = JSON.parse(readFileSync(lockPath, 'utf-8'));
    if (!parsed || typeof parsed !== 'object' || typeof parsed.pid !== 'number') return;
    if (parsed.pid !== process.pid) return;
    if (typeof parsed.hostname === 'string' && parsed.hostname !== hostname()) return;
    unlinkSync(lockPath);
  } catch (err) {
    console.warn(
      `${logPrefix} Failed to release ${lockPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
