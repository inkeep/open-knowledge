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
import { errnoCode } from './http/handler-utils.ts';
import { getLogger } from './logger.ts';
import { getMachineId } from './machine-id.ts';
import { isProcessAlive, isValidLockPid } from './process-alive.ts';
import { PROTOCOL_VERSION, RUNTIME_VERSION } from './version-constants.ts';

const log = getLogger('process-lock');

export type LockName = 'server';

export type LockKind = 'interactive' | 'mcp-spawned';

export interface ProcessLockMetadata {
  pid: number;
  hostname: string;
  port: number;
  url?: string;
  startedAt: string;
  worktreeRoot: string;
  machineId?: string;
  draining?: boolean;
  kind?: LockKind;
  parentPid?: number;
  capabilities?: string[];
  protocolVersion?: number;
  runtimeVersion?: string;
}

export interface ProcessLockHandle {
  lockPath: string;
  release: () => void;
  updatePort: (port: number, url?: string) => void;
}

export class ProcessLockCollisionError extends Error {
  readonly existing: ProcessLockMetadata;
  readonly lockPath: string;
  readonly lockName: LockName;
  constructor(existing: ProcessLockMetadata, lockPath: string, lockName: LockName) {
    super(
      `OpenKnowledge ${lockName} already running at ${existing.url ?? `port ${existing.port}`} ` +
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

function isSameMachine(existing: ProcessLockMetadata): boolean {
  if (typeof existing.machineId === 'string') return existing.machineId === getMachineId();
  return existing.hostname === hostname();
}

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
      } catch {}
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

export function acquireProcessLock(opts: {
  lockName: LockName;
  lockDir: string;
  metadata: {
    port: number;
    url?: string;
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
    ...(init.url !== undefined && { url: init.url }),
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
        if (errnoCode(err) !== 'EEXIST') throw err;
      }
    }

    const existing = parseLock(lockPath, logPrefix);
    if (existing) {
      if (isSameMachine(existing) && existing.pid === process.pid) {
        writeFileSync(lockPath, payload, { encoding: 'utf-8', mode: 0o600 });
        bumpActiveLockRef(lockPath);
        registerExitUnlink(lockPath);
        return buildHandle({ lockName, lockDir, lockPath });
      }
      if (isProcessAlive(existing.pid)) {
        throw new ProcessLockCollisionError(existing, lockPath, lockName);
      }
      log.warn(
        { pid: existing.pid, host: existing.hostname },
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
    updatePort: (port, url) => updateProcessLockPort({ lockName, lockDir, port, url }),
  };
}

function dialableLockOrigin(raw: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  const host = parsed.hostname;
  const loopback =
    host === 'localhost' || host === '[::1]' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
  if (!loopback) return null;
  return parsed.origin;
}

export function lockBaseUrl(
  lock: Pick<ProcessLockMetadata, 'port' | 'url'>,
  opts?: { fallbackHost?: string },
): string | null {
  if (typeof lock.url === 'string' && lock.url.length > 0) {
    const origin = dialableLockOrigin(lock.url);
    if (origin !== null) return origin;
  }
  if (lock.port > 0) {
    const host = opts?.fallbackHost ?? 'localhost';
    const formatted =
      host === '0.0.0.0' || host === '::'
        ? 'localhost'
        : host.includes(':') && !host.startsWith('[')
          ? `[${host}]`
          : host;
    return `http://${formatted}:${lock.port}`;
  }
  return null;
}

export function updateProcessLockPort(opts: {
  lockName: LockName;
  lockDir: string;
  port: number;
  url?: string;
}): void {
  const { lockName, lockDir, port, url } = opts;
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
  if (!isSameMachine(existing)) return;

  existing.port = port;
  if (url !== undefined) {
    existing.url = url;
  } else {
    delete existing.url;
  }
  try {
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

export function markProcessLockDraining(opts: { lockName: LockName; lockDir: string }): void {
  const { lockName, lockDir } = opts;
  const logPrefix = `[${lockName}-lock]`;
  const lockPath = lockFilePath(lockDir, lockName);

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
    if (errnoCode(err) !== 'ENOENT') {
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
    url: typeof r.url === 'string' ? r.url : undefined,
    startedAt: r.startedAt,
    worktreeRoot: r.worktreeRoot,
    machineId: typeof r.machineId === 'string' ? r.machineId : undefined,
    draining: r.draining === true ? true : undefined,
    capabilities:
      Array.isArray(r.capabilities) && r.capabilities.every((c) => typeof c === 'string')
        ? r.capabilities
        : undefined,
    protocolVersion: typeof r.protocolVersion === 'number' ? r.protocolVersion : undefined,
    runtimeVersion: typeof r.runtimeVersion === 'string' ? r.runtimeVersion : undefined,
  };

  if (!isSameMachine(lock)) return { status: 'stale', lock };
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

export async function waitForProcessLockDrain(opts: {
  lockName: LockName;
  lockDir: string;
  timeoutMs?: number;
  pollIntervalMs?: number;
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

export function releaseProcessLock(opts: {
  lockName: LockName;
  lockDir: string;
  deferUnlinkToExit?: boolean;
}): void {
  const { lockName, lockDir, deferUnlinkToExit = false } = opts;
  const logPrefix = `[${lockName}-lock]`;
  const lockPath = lockFilePath(lockDir, lockName);
  if (!dropActiveLockRef(lockPath)) {
    return;
  }
  if (deferUnlinkToExit) {
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
