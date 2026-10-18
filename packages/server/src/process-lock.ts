import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { hostname } from 'node:os';
import { resolve } from 'node:path';
import { resolveDesktopProductName } from '@inkeep/open-knowledge-core';
import { errnoCode } from './http/handler-utils.ts';
import { getLogger } from './logger.ts';
import { getMachineId } from './machine-id.ts';
import { isValidLockPid } from './process-alive.ts';
import {
  assessLockHolder,
  classifyLockHolder,
  createRecentProcessStartReader,
  isLockFromThisMachine,
  type ProcessStartToken,
  parseProcessStartToken,
  processStartToken,
  readProcessStart,
  verdictHoldsLock,
} from './process-identity.ts';
import { sleepSyncMs } from './sleep-sync.ts';
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
  processStart?: ProcessStartToken;
  draining?: boolean;
  kind?: LockKind;
  parentPid?: number;
  capabilities?: string[];
  protocolVersion?: number;
  runtimeVersion?: string;
  channel?: string;
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

export const LOCK_FILE_ACCESS_REMEDY = 'Restore file and parent-directory access, then retry.';
const LOCK_FILE_BUSY_REMEDY =
  'Another program has the lock file open; close it or wait, then retry.';
const LOCK_FILE_OTHER_REMEDY = 'Resolve that error, then retry.';
const LOCK_FILE_ACCESS_CODES = new Set(['EACCES', 'EPERM', 'EROFS']);

function lockFileRemedy(cause: unknown): string {
  const code = errnoCode(cause);
  if (code === 'EBUSY') return LOCK_FILE_BUSY_REMEDY;
  if (code !== undefined && LOCK_FILE_ACCESS_CODES.has(code)) return LOCK_FILE_ACCESS_REMEDY;
  return LOCK_FILE_OTHER_REMEDY;
}

type LockFileFailure = 'read' | 'stale' | 'corrupt' | 'dangling-link';

const LOCK_FILE_FAILURE_ACTIONS: Record<LockFileFailure, string> = {
  read: 'read the lock',
  stale: 'remove the stale lock',
  corrupt: 'remove the corrupt lock',
  'dangling-link': 'remove the broken symbolic link',
};

export class ProcessLockFileError extends Error {
  readonly lockPath: string;
  constructor(logPrefix: string, failure: LockFileFailure, lockPath: string, cause: unknown) {
    super(
      `${logPrefix} Could not ${LOCK_FILE_FAILURE_ACTIONS[failure]} at ${lockPath}: ${cause instanceof Error ? cause.message : String(cause)}. ${lockFileRemedy(cause)}`,
      { cause },
    );
    this.name = 'ProcessLockFileError';
    this.lockPath = lockPath;
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
  return isLockFromThisMachine(existing);
}

const LOCK_READ_HOLDER_START_MAX_AGE_MS = 1_000;
const readRecentHolderStart = createRecentProcessStartReader({
  maxAgeMs: LOCK_READ_HOLDER_START_MAX_AGE_MS,
});

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

export function toProcessLockMetadata(record: { pid: number }): ProcessLockMetadata {
  const { processStart, ...rest } = record as { pid: number; processStart?: unknown };
  const token = parseProcessStartToken(processStart);
  return { ...rest, ...(token !== undefined && { processStart: token }) } as ProcessLockMetadata;
}

function parseLockText(text: string): ProcessLockMetadata | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (parsed && typeof parsed === 'object' && isValidLockPid((parsed as { pid?: unknown }).pid)) {
    return toProcessLockMetadata(parsed as { pid: number });
  }
  return null;
}

export type LockRemoval = 'removed' | 'changed' | 'missing';

export function removeLockIfUnchanged(lockPath: string, assessedText: string): LockRemoval {
  try {
    if (readFileSync(lockPath, 'utf-8') !== assessedText) return 'changed';
    unlinkSync(lockPath);
    return 'removed';
  } catch (err) {
    if (errnoCode(err) === 'ENOENT') return 'missing';
    throw err;
  }
}

const WIN32_TRANSIENT_LOCK_FILE_CODES = new Set(['EBUSY', 'EPERM', 'EACCES']);
const WIN32_TRANSIENT_RETRY_PAUSE_MS = 100;

function isTransientLockFileError(err: unknown): boolean {
  const code = errnoCode(err);
  return (
    process.platform === 'win32' && code !== undefined && WIN32_TRANSIENT_LOCK_FILE_CODES.has(code)
  );
}

function removeExitedHolderLock(lockName: LockName, lockPath: string, assessedText: string): void {
  try {
    removeLockIfUnchanged(lockPath, assessedText);
  } catch (err) {
    log.debug(
      { lockPath, err },
      `[${lockName}-lock] Could not remove the lock at ${lockPath} left by an exited holder`,
    );
  }
}

function writerChannel(logPrefix: string): string | undefined {
  try {
    return resolveDesktopProductName();
  } catch (err) {
    log.warn(
      { err },
      `${logPrefix} Not recording a channel: ${err instanceof Error ? err.message : String(err)}`,
    );
    return undefined;
  }
}

function lockChannel(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
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

  const ownStart = readProcessStart(process.pid);
  const processStart = processStartToken(ownStart);
  if (processStart === undefined) {
    const reason = ownStart === null ? 'start-unreadable' : 'boot-id-unreadable';
    log.warn(
      { event: 'process-start-unrecorded', platform: process.platform, reason },
      `${logPrefix} Writing the lock without a processStart (${reason}); readers fall back to its startedAt margin`,
    );
  }
  const record: ProcessLockMetadata = {
    pid: process.pid,
    hostname: hostname(),
    port: init.port,
    ...(init.url !== undefined && { url: init.url }),
    startedAt: new Date().toISOString(),
    worktreeRoot: init.worktreeRoot,
    machineId: getMachineId(),
    ...(processStart !== undefined && { processStart }),
    ...(init.kind !== undefined && { kind: init.kind }),
    ...(init.parentPid !== undefined && { parentPid: init.parentPid }),
    ...(init.capabilities !== undefined && { capabilities: init.capabilities }),
    protocolVersion: init.protocolVersion ?? PROTOCOL_VERSION,
    runtimeVersion: init.runtimeVersion ?? RUNTIME_VERSION,
    channel: writerChannel(logPrefix),
  };
  const payload = JSON.stringify(record, null, 2);

  const MAX_ATTEMPTS = 3;
  const keepTransientFailure = (
    failure: LockFileFailure,
    err: unknown,
    attempt: number,
  ): ProcessLockFileError => {
    const error = new ProcessLockFileError(logPrefix, failure, lockPath, err);
    if (!isTransientLockFileError(err)) throw error;
    if (attempt < MAX_ATTEMPTS) {
      const code = errnoCode(err);
      log.warn(
        { lockPath, code, attempt },
        `${logPrefix} Could not ${LOCK_FILE_FAILURE_ACTIONS[failure]} at ${lockPath} (${code}); retrying, attempt ${attempt} of ${MAX_ATTEMPTS}`,
      );
      sleepSyncMs(WIN32_TRANSIENT_RETRY_PAUSE_MS * attempt);
    }
    return error;
  };
  const removeAssessedLock = (
    kind: 'stale' | 'corrupt',
    text: string,
    attempt: number,
  ): ProcessLockFileError | undefined => {
    try {
      removeLockIfUnchanged(lockPath, text);
      return undefined;
    } catch (err) {
      return keepTransientFailure(kind, err, attempt);
    }
  };
  const removeDanglingLink = (attempt: number): ProcessLockFileError | undefined => {
    try {
      if (!lstatSync(lockPath).isSymbolicLink()) return undefined;
      unlinkSync(lockPath);
      log.warn({ lockPath }, `${logPrefix} Removed a broken symbolic link at ${lockPath}`);
      return undefined;
    } catch (err) {
      if (errnoCode(err) === 'ENOENT') return undefined;
      return keepTransientFailure('dangling-link', err, attempt);
    }
  };

  let lastTransientFailure: ProcessLockFileError | undefined;
  for (let attempt = 1; ; attempt++) {
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
    if (attempt > MAX_ATTEMPTS) break;
    lastTransientFailure = undefined;

    let text: string;
    try {
      text = readFileSync(lockPath, 'utf-8');
    } catch (err) {
      lastTransientFailure =
        errnoCode(err) === 'ENOENT'
          ? removeDanglingLink(attempt)
          : keepTransientFailure('read', err, attempt);
      continue;
    }

    const existing = parseLockText(text);
    if (existing) {
      if (isSameMachine(existing) && existing.pid === process.pid) {
        writeFileSync(lockPath, payload, { encoding: 'utf-8', mode: 0o600 });
        bumpActiveLockRef(lockPath);
        registerExitUnlink(lockPath);
        return buildHandle({ lockName, lockDir, lockPath });
      }
      const assessment = assessLockHolder(existing);
      if (verdictHoldsLock(assessment.verdict)) {
        if (assessment.verdict === 'unverified') {
          log.warn(
            {
              lockPid: existing.pid,
              host: existing.hostname,
              holder: assessment.verdict,
              cause: assessment.cause,
            },
            `${logPrefix} Could not confirm that pid=${existing.pid} wrote ${lockPath}; refusing to replace it`,
          );
        }
        throw new ProcessLockCollisionError(existing, lockPath, lockName);
      }
      log.warn(
        { lockPid: existing.pid, host: existing.hostname, holder: assessment.verdict },
        `${logPrefix} Stale lock detected (pid=${existing.pid}, host=${existing.hostname}) — replacing`,
      );
      lastTransientFailure = removeAssessedLock('stale', text, attempt);
      continue;
    }

    log.warn({ lockPath }, `${logPrefix} Corrupt lock file at ${lockPath} — replacing`);
    lastTransientFailure = removeAssessedLock('corrupt', text, attempt);
  }

  throw (
    lastTransientFailure ??
    new Error(
      `${logPrefix} Failed to acquire ${lockPath} after ${MAX_ATTEMPTS} attempts (concurrent acquire contention).`,
    )
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
    existing = toProcessLockMetadata(parsed);
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
    existing = toProcessLockMetadata(parsed);
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

  let text: string;
  let existing: ProcessLockMetadata;
  try {
    text = readFileSync(lockPath, 'utf-8');
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || !isValidLockPid((parsed as { pid?: unknown }).pid))
      return null;
    existing = toProcessLockMetadata({ ...parsed, channel: lockChannel(parsed.channel) });
  } catch {
    return null;
  }

  if (!isSameMachine(existing)) return null;
  const holder = classifyLockHolder(existing, {
    sameMachine: true,
    readProcessStart: readRecentHolderStart,
  });
  if (!verdictHoldsLock(holder)) {
    if (holder === 'gone') removeExitedHolderLock(lockName, lockPath, text);
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

  let text: string;
  let raw: unknown;
  try {
    text = readFileSync(lockPath, 'utf-8');
    raw = JSON.parse(text);
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
    processStart: parseProcessStartToken(r.processStart),
    draining: r.draining === true ? true : undefined,
    capabilities:
      Array.isArray(r.capabilities) && r.capabilities.every((c) => typeof c === 'string')
        ? r.capabilities
        : undefined,
    protocolVersion: typeof r.protocolVersion === 'number' ? r.protocolVersion : undefined,
    runtimeVersion: typeof r.runtimeVersion === 'string' ? r.runtimeVersion : undefined,
    channel: lockChannel(r.channel),
  };

  if (!isSameMachine(lock)) return { status: 'stale', lock };
  const holder = classifyLockHolder(lock, {
    sameMachine: true,
    readProcessStart: readRecentHolderStart,
  });
  if (!verdictHoldsLock(holder)) {
    if (holder === 'gone') removeExitedHolderLock(lockName, lockPath, text);
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
