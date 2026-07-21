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
import { getLogger } from './logger.ts';
import { getMachineId } from './machine-id.ts';
import { isProcessAlive, isValidLockPid } from './process-alive.ts';
import { PROTOCOL_VERSION, RUNTIME_VERSION } from './version-constants.ts';

const log = getLogger('process-lock');

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
  /**
   * Display/diagnostic only — NOT an identity signal. `os.hostname()` follows
   * macOS network renames, so hostname comparison misclassifies same-machine
   * locks as foreign after a rename. Identity checks use `machineId`;
   * hostname comparison survives only as the legacy fallback for locks
   * written by binaries that predate `machineId`.
   */
  hostname: string;
  /** HTTP/WebSocket port. 0 means "starting — port not yet bound". */
  port: number;
  startedAt: string;
  worktreeRoot: string;
  /**
   * Stable machine identity from `~/.ok/machine-id` (see `machine-id.ts`).
   * Absent on locks written by older binaries — readers fall back to the
   * hostname comparison, and ambiguous cases resolve fail-closed on local
   * pid liveness.
   */
  machineId?: string;
  /**
   * Set when the holder has begun teardown. The holder still OWNS the lock —
   * the file is unlinked only when the process actually exits — but the
   * advertised port is no longer safe to dial and supervisors should wait
   * for pid death rather than lock disappearance. Absent means "serving".
   */
  draining?: boolean;
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

/**
 * Machine-identity test for lock ownership judgments. `machineId` is the
 * primary signal; the hostname comparison survives only for locks written by
 * binaries that predate `machineId`. Callers must treat a `false` result as
 * "unknown provenance" and fall back to LOCAL pid liveness with fail-closed
 * semantics (collision, not stale-replace) — a foreign-looking lock can be a
 * same-machine lock written under a renamed hostname or another OS user
 * account's `~/.ok/machine-id`.
 */
function isSameMachine(existing: ProcessLockMetadata): boolean {
  if (typeof existing.machineId === 'string') return existing.machineId === getMachineId();
  return existing.hostname === hostname();
}

/**
 * Locks owned by this process that must be unlinked when the process
 * actually exits. One shared `'exit'` listener over a registry — a listener
 * per lockPath would trip Node's MaxListeners warning under the test runner,
 * which acquires thousands of per-test lock paths in one process.
 *
 * The handler is ownership-guarded (pid + machine), so a path that was
 * already released early, or re-acquired by another process, is left alone.
 * SIGKILL bypasses `'exit'`; the dead-pid stale detection in
 * `acquireProcessLock`/`readProcessLock` is the backstop for that case.
 */
const exitUnlinkPaths = new Set<string>();
let exitUnlinkHandlerRegistered = false;

function registerExitUnlink(lockPath: string): void {
  exitUnlinkPaths.add(lockPath);
  if (exitUnlinkHandlerRegistered) return;
  exitUnlinkHandlerRegistered = true;
  process.on('exit', () => {
    for (const path of exitUnlinkPaths) {
      try {
        const parsed = JSON.parse(readFileSync(path, 'utf-8')) as Partial<ProcessLockMetadata>;
        if (parsed?.pid !== process.pid) continue;
        if (typeof parsed.machineId === 'string' && parsed.machineId !== getMachineId()) continue;
        if (
          parsed.machineId === undefined &&
          typeof parsed.hostname === 'string' &&
          parsed.hostname !== hostname()
        ) {
          continue;
        }
        unlinkSync(path);
      } catch {
        // Missing or corrupt — nothing of ours to clean.
      }
    }
  });
}

function parseLock(lockPath: string, logPrefix: string): ProcessLockMetadata | null {
  try {
    const parsed = JSON.parse(readFileSync(lockPath, 'utf-8'));
    if (parsed && typeof parsed === 'object' && isValidLockPid((parsed as { pid?: unknown }).pid)) {
      return parsed as ProcessLockMetadata;
    }
    log.warn({ lockPath }, `${logPrefix} Corrupt lock file at ${lockPath} — replacing`);
    return null;
  } catch {
    log.warn({ lockPath }, `${logPrefix} Corrupt lock file at ${lockPath} — replacing`);
    return null;
  }
}

/**
 * Acquire an exclusive process lock.
 *
 * - No existing lock → write ours atomically via O_CREAT|O_EXCL.
 * - Our own pid (same machine) → idempotent rewrite (refreshes
 *   port/startedAt, clears any draining flag).
 * - Pid alive on THIS host → throw ProcessLockCollisionError — regardless of
 *   the lock's recorded machineId/hostname. Fail closed: a "foreign-looking"
 *   lock can be this very machine under a renamed hostname (macOS renames
 *   follow the network) or another OS user account; replacing it would start
 *   a duplicate server against a live one. The cost is a rare false
 *   collision on a shared volume (another machine's lock whose pid number
 *   coincides with a live local process) — a loud, self-explanatory error,
 *   preferred over a silent split-brain.
 * - Pid dead locally → stale → replace with warning. This preserves the
 *   availability posture for shared volumes: a genuinely-remote holder's
 *   lock (pid meaningless here, almost always dead-looking) never blocks a
 *   local start.
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
    machineId: getMachineId(),
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
        registerExitUnlink(lockPath);
        return buildHandle({ lockName, lockDir, lockPath });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
        // EEXIST — another acquire raced us; fall through to re-inspect.
      }
    }

    const existing = parseLock(lockPath, logPrefix);
    if (existing) {
      if (isSameMachine(existing) && existing.pid === process.pid) {
        // Idempotent rewrite — our own lock. Safe to overwrite in place;
        // O_EXCL is not needed here (we can't race ourselves). Bumps the
        // refcount so the corresponding releaseProcessLock decrement
        // doesn't unlink the file out from under the prior holder. See
        // `activeLockRefs` doc for the Vite-restart scenario this
        // protects against. The fresh payload carries no `draining` flag, so
        // a same-process re-acquire after a prior teardown (restartable test
        // servers) returns the lock to the serving state.
        writeFileSync(lockPath, payload, { encoding: 'utf-8', mode: 0o600 });
        bumpActiveLockRef(lockPath);
        registerExitUnlink(lockPath);
        return buildHandle({ lockName, lockDir, lockPath });
      }
      // Fail closed on ANY live local pid — deliberately not gated on
      // machineId/hostname. See the function docstring for why replacing a
      // foreign-looking live lock is the duplicate-server bug, not a cleanup.
      if (isProcessAlive(existing.pid)) {
        throw new ProcessLockCollisionError(existing, lockPath, lockName);
      }
      log.warn(
        { pid: existing.pid, host: existing.hostname },
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
    log.warn(
      { lockPath },
      `${logPrefix} Lock file missing at ${lockPath} during port update — skipping`,
    );
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
      log.warn(
        { lockPath },
        `${logPrefix} Corrupt lock at ${lockPath} during port update — skipping`,
      );
      return;
    }
    existing = parsed as ProcessLockMetadata;
  } catch {
    log.warn(
      { lockPath },
      `${logPrefix} Unreadable lock at ${lockPath} during port update — skipping`,
    );
    return;
  }
  if (existing.pid !== process.pid) return;
  // Match the cross-machine guard in releaseProcessLock — pid alone can
  // collide across machines on a shared content volume (NFS, etc.).
  if (!isSameMachine(existing)) return;

  existing.port = port;
  try {
    // `mode: 0o600` — owner-only readable. Matches `acquireProcessLock`'s
    // atomic-create mode so port updates don't drop back to default (0644).
    writeFileSync(lockPath, JSON.stringify(existing, null, 2), {
      encoding: 'utf-8',
      mode: 0o600,
    });
  } catch (err) {
    log.warn(
      { lockPath, err },
      `${logPrefix} Failed to update port in ${lockPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Mark our own lock as draining — teardown has begun, the advertised port is
 * no longer safe to dial, but the process still owns the lock until it
 * actually exits. No-op (with a warning) when the lock is missing, corrupt,
 * or not ours — a supervisor may legitimately have replaced it already.
 *
 * Idempotent; preserves every other field.
 */
export function markProcessLockDraining(opts: { lockName: LockName; lockDir: string }): void {
  const { lockName, lockDir } = opts;
  const logPrefix = `[${lockName}-lock]`;
  const lockPath = lockFilePath(lockDir, lockName);

  // Refcount-aware: draining means "the LAST holder is tearing down". When
  // another in-process acquire is still active (Vite restart: pass-2 serves
  // while pass-1 destroys), the lock must keep advertising a live server —
  // marking it draining here would make discovery refuse a healthy one.
  if ((activeLockRefs.get(lockPath) ?? 0) > 1) return;

  let existing: ProcessLockMetadata;
  try {
    const parsed = JSON.parse(readFileSync(lockPath, 'utf-8'));
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      !isValidLockPid((parsed as { pid?: unknown }).pid)
    ) {
      log.warn(
        { lockPath },
        `${logPrefix} Corrupt lock at ${lockPath} during draining mark — skipping`,
      );
      return;
    }
    existing = parsed as ProcessLockMetadata;
  } catch (err) {
    // Missing file is a normal double-release/error-path case — stay quiet.
    // Anything else (unreadable, corrupt JSON) has the same consequence as a
    // failed WRITE (server keeps looking live during teardown), so it must be
    // as attributable as the write-failure warn below.
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      log.warn(
        { lockPath, err },
        `${logPrefix} Unreadable lock at ${lockPath} during draining mark — skipping: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return;
  }
  if (existing.pid !== process.pid) return;
  if (!isSameMachine(existing)) return;
  if (existing.draining === true) return;

  existing.draining = true;
  try {
    writeFileSync(lockPath, JSON.stringify(existing, null, 2), {
      encoding: 'utf-8',
      mode: 0o600,
    });
  } catch (err) {
    log.warn(
      { lockPath, err },
      `${logPrefix} Failed to mark ${lockPath} draining: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Read the lock if it exists and the holder is alive on this host.
 * Returns null for missing, stale, cross-machine, or corrupt locks. Cleans
 * up a stale lock as a side effect (same machine, dead pid only).
 *
 * A returned lock may carry `draining: true` — the holder is alive but
 * tearing down. Callers that dial the port or treat the holder as
 * attachable MUST check `draining`; callers that only need "is someone
 * alive holding this" can ignore it.
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

  if (!isSameMachine(existing)) return null;
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
    machineId: typeof r.machineId === 'string' ? r.machineId : undefined,
    draining: r.draining === true ? true : undefined,
    protocolVersion: typeof r.protocolVersion === 'number' ? r.protocolVersion : undefined,
    runtimeVersion: typeof r.runtimeVersion === 'string' ? r.runtimeVersion : undefined,
  };

  if (!isSameMachine(lock)) return { status: 'stale', lock };
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
 * Wait for a draining holder to finish exiting before proceeding.
 *
 * Spawners (CLI `ok start`, the MCP shim's auto-start, the desktop's
 * detached spawn) call this before acquiring: a draining lock means the
 * previous server is seconds from exit, and racing it either collides
 * loudly or, worse, dials a dying port. Polls until the lock is gone or
 * replaced by a non-draining one.
 *
 * Returns:
 * - `'no-drain'`  — no lock, or a live non-draining holder. Proceed to the
 *                   normal acquire/attach logic immediately.
 * - `'released'`  — a draining holder was present and has since exited
 *                   (lock gone or dead-pid-cleaned). Safe to acquire.
 * - `'timeout'`   — the draining holder outlived `timeoutMs`. Proceed to
 *                   the normal logic; acquire will collide loudly, which is
 *                   the correct fail-closed outcome for a wedged teardown.
 */
export async function waitForProcessLockDrain(opts: {
  lockName: LockName;
  lockDir: string;
  timeoutMs?: number;
  pollIntervalMs?: number;
  /** Injectable for tests. */
  readLock?: () => ProcessLockMetadata | null;
  sleep?: (ms: number) => Promise<void>;
}): Promise<'no-drain' | 'released' | 'timeout'> {
  const { lockName, lockDir } = opts;
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const pollIntervalMs = opts.pollIntervalMs ?? 100;
  const readLock = opts.readLock ?? (() => readProcessLock({ lockName, lockDir }));
  const sleep =
    opts.sleep ??
    ((ms: number) => new Promise<void>((resolveSleep) => setTimeout(resolveSleep, ms)));

  const initial = readLock();
  if (initial === null || initial.draining !== true) return 'no-drain';

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(pollIntervalMs);
    const lock = readLock();
    if (lock === null) return 'released';
    if (lock.draining !== true) return 'no-drain';
  }
  return 'timeout';
}

/**
 * Release the lock. Safe to call multiple times. Only removes the lock if
 * we own it (pid AND machine match; hostname for legacy locks) — prevents a
 * rogue process from unlinking a real server's lock. The machine check
 * matters on shared content directories (NFS-mounted home, remote content
 * volumes) where two machines can legitimately run processes with the same
 * pid — without the check we'd unlink a peer's lock.
 *
 * Refcount-aware: when this process holds multiple active acquires for the
 * same lockPath (Vite plugin per-`configureServer` createServer lifecycle),
 * release decrements the in-process refcount; the file is only unlinked
 * when the LAST active acquire releases. See `activeLockRefs` for the bug
 * class this protects against.
 *
 * `deferUnlinkToExit` — the teardown-to-exit contract. When set and the
 * refcount reaches zero, the file is NOT unlinked now: it stays on disk
 * marked `draining` and the process-exit handler (registered at acquire)
 * removes it when the process actually dies. This closes the window where
 * a released lock made a still-alive server invisible, so supervisors and
 * discovery spawned a duplicate alongside it. Callers whose process keeps
 * living after the release (error-path cleanup, the Vite dev plugin's
 * restart cycle) MUST leave this unset — deferring there would leave a
 * live-pid draining lock that blocks every future start until the dev
 * process dies.
 */
export function releaseProcessLock(opts: {
  lockName: LockName;
  lockDir: string;
  deferUnlinkToExit?: boolean;
}): void {
  const { lockName, lockDir, deferUnlinkToExit = false } = opts;
  const logPrefix = `[${lockName}-lock]`;
  const lockPath = lockFilePath(lockDir, lockName);
  if (!dropActiveLockRef(lockPath)) {
    // Other active acquires in this process still hold the lock — preserve
    // the file so cross-process collision detection keeps working.
    return;
  }
  if (deferUnlinkToExit) {
    // Ensure the draining flag is visible to readers between now and exit;
    // the exit handler owns the actual unlink.
    markProcessLockDraining({ lockName, lockDir });
    return;
  }
  if (!existsSync(lockPath)) return;
  try {
    const parsed = JSON.parse(readFileSync(lockPath, 'utf-8'));
    if (!parsed || typeof parsed !== 'object' || typeof parsed.pid !== 'number') return;
    if (parsed.pid !== process.pid) return;
    if (!isSameMachine(parsed as ProcessLockMetadata)) return;
    unlinkSync(lockPath);
    exitUnlinkPaths.delete(lockPath);
  } catch (err) {
    log.warn(
      { lockPath, err },
      `${logPrefix} Failed to release ${lockPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
