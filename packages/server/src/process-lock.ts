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

export type LockKind = 'interactive' | 'mcp-spawned';

export interface ProcessLockMetadata {
  pid: number;
  hostname: string;
  port: number;
  startedAt: string;
  worktreeRoot: string;
  kind?: LockKind;
  parentPid?: number;
  capabilities?: string[];
  protocolVersion?: number;
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

const activeLockRefs = new Map<string, number>();

function bumpActiveLockRef(lockPath: string): void {
  activeLockRefs.set(lockPath, (activeLockRefs.get(lockPath) ?? 0) + 1);
}

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

export function acquireProcessLock(opts: {
  lockName: LockName;
  lockDir: string;
  metadata: {
    port: number;
    worktreeRoot: string;
    kind?: LockKind;
    parentPid?: number;
    capabilities?: string[];
    protocolVersion?: number;
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
      }
    }

    const existing = parseLock(lockPath, logPrefix);
    if (existing) {
      const sameHost = existing.hostname === hostname();
      if (sameHost && existing.pid === process.pid) {
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

    try {
      unlinkSync(lockPath);
    } catch {}
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
  if (typeof existing.hostname === 'string' && existing.hostname !== hostname()) return;

  existing.port = port;
  try {
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
    } catch {}
    return null;
  }

  return existing;
}

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
    } catch {}
    return { status: 'stale', lock };
  }

  if (lock.protocolVersion === undefined || lock.runtimeVersion === undefined) {
    return { status: 'incompatible', reason: 'missing-fields', raw };
  }

  return { status: 'live', lock };
}

export function releaseProcessLock(opts: { lockName: LockName; lockDir: string }): void {
  const { lockName, lockDir } = opts;
  const logPrefix = `[${lockName}-lock]`;
  const lockPath = lockFilePath(lockDir, lockName);
  if (!dropActiveLockRef(lockPath)) {
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
