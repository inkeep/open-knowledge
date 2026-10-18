import { type ExecFileSyncOptionsWithStringEncoding, execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { hostname } from 'node:os';
import {
  LOCAL_OP_PIPE_STDIO_OPTIONS,
  withHiddenWindowsConsole,
} from './child-process-windows-hide.ts';
import { getLogger } from './logger.ts';
import { getMachineId } from './machine-id.ts';
import { isProcessAlive } from './process-alive.ts';

const log = getLogger('process-identity');

export interface ProcessStart {
  startedAtMs: number;
  clock: 'creation' | 'boot-derived';
  startTicks?: number;
  bootId?: string;
}

export type ProcessStartToken = { bootId: string; startTicks: number } | { startedAtMs: number };

export type ProcessStartReader = (pid: number) => ProcessStart | null;

export type LockHolderVerdict = 'writer' | 'replaced' | 'gone' | 'unverified';

export type UnverifiedLockHolderCause =
  | 'process-start-unreadable'
  | 'process-start-incomparable'
  | 'process-start-mismatch'
  | 'process-started-after-lock'
  | 'recorded-start-in-future'
  | 'writer-identity-unrecorded'
  | 'foreign-host'
  | 'unverified-owner';

export type ProcessStartCause = Exclude<
  UnverifiedLockHolderCause,
  'foreign-host' | 'unverified-owner'
>;

type LockHolderComparison =
  | { readonly verdict: 'writer' | 'replaced' }
  | { readonly verdict: 'unverified'; readonly cause: ProcessStartCause };

export type LockHolderAssessment =
  | { readonly verdict: 'writer' | 'replaced' | 'gone' }
  | { readonly verdict: 'unverified'; readonly cause: UnverifiedLockHolderCause };

export interface LockOwnerFields {
  readonly machineId?: unknown;
  readonly hostname?: unknown;
}

export interface LockHolderIdentity {
  pid: number;
  startedAt?: string;
  processStart?: unknown;
  machineId?: string;
  hostname?: string;
}

export type NativeProcessStartReader = (pid: number) => number | null;

type PsRunner = (
  command: string,
  args: string[],
  options: ExecFileSyncOptionsWithStringEncoding,
) => string;

export interface PsProcessStartOptions {
  run?: PsRunner;
  env?: NodeJS.ProcessEnv;
}

export interface ReadProcessStartOptions {
  platform?: NodeJS.Platform;
  readFile?: (path: string) => string;
  readNative?: NativeProcessStartReader;
}

export interface RecentProcessStartReaderOptions {
  maxAgeMs: number;
  read?: ProcessStartReader;
  now?: () => number;
}

export interface ClassifyLockHolderOptions {
  isAlive?: (pid: number) => boolean;
  readProcessStart?: ProcessStartReader;
  sameMachine?: boolean;
  formatRecordsMachineId?: boolean;
  refuseHolderStartedAfterLock?: boolean;
}

const TOKEN_TOLERANCE_MS = 1000;
const LEGACY_MARGIN_CREATION_MS = 10_000;
const LEGACY_MARGIN_BOOT_DERIVED_MS = 300_000;

const MAX_PROCESS_ID = 0xffff_ffff;
const MAX_BOOT_ID_LENGTH = 64;
const MS_PER_USER_HZ_TICK = 10;
const PROC_STAT_START_TICKS_INDEX_AFTER_COMM = 19;
const BOOT_ID_PATH = '/proc/sys/kernel/random/boot_id';
const PS_PROCESS_START_QUERY_TIMEOUT_MS = 5000;
const PS_LSTART_PATTERN = /^\w{3}\s+\w{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4}$/;

const NATIVE_PROCESS_START_READER: unique symbol = Symbol.for(
  '@inkeep/open-knowledge/native-process-start-reader',
);

const nativeReaderHost = globalThis as typeof globalThis & {
  [NATIVE_PROCESS_START_READER]?: NativeProcessStartReader;
};

let ownProcessStart: ProcessStart | undefined;
let ownBootId: string | undefined;
let missingReaderWarned = false;

function isReadableProcessId(pid: number): boolean {
  return Number.isSafeInteger(pid) && pid > 0 && pid <= MAX_PROCESS_ID;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isBootId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_BOOT_ID_LENGTH;
}

function readFileUtf8(path: string): string {
  return readFileSync(path, 'utf8');
}

export function readPsProcessStart(
  pid: number,
  options: PsProcessStartOptions = {},
): number | null {
  if (!isReadableProcessId(pid)) return null;
  const env = options.env ?? process.env;
  const run = options.run ?? execFileSync;
  const commandOptions: ExecFileSyncOptionsWithStringEncoding = withHiddenWindowsConsole({
    encoding: 'utf8',
    ...LOCAL_OP_PIPE_STDIO_OPTIONS,
    timeout: PS_PROCESS_START_QUERY_TIMEOUT_MS,
    env: { ...env, LC_ALL: 'C', TZ: 'UTC0' },
  });
  try {
    const raw = run('ps', ['-p', String(pid), '-o', 'lstart='], commandOptions).trim();
    if (!PS_LSTART_PATTERN.test(raw)) return null;
    const startedAt = Date.parse(`${raw} UTC`);
    return Number.isFinite(startedAt) ? startedAt : null;
  } catch {
    return null;
  }
}

export function registerNativeProcessStartReader(read: NativeProcessStartReader): () => void {
  nativeReaderHost[NATIVE_PROCESS_START_READER] = read;
  return () => {
    if (nativeReaderHost[NATIVE_PROCESS_START_READER] === read) {
      delete nativeReaderHost[NATIVE_PROCESS_START_READER];
      missingReaderWarned = false;
    }
  };
}

function parseProcStatStartTicks(stat: string): number | null {
  const commEnd = stat.lastIndexOf(')');
  if (commEnd < 0) return null;
  const fields = stat
    .slice(commEnd + 1)
    .trim()
    .split(/\s+/);
  const raw = fields[PROC_STAT_START_TICKS_INDEX_AFTER_COMM];
  if (raw === undefined || !/^\d+$/.test(raw)) return null;
  const ticks = Number(raw);
  return Number.isSafeInteger(ticks) ? ticks : null;
}

function parseBootTimeSeconds(stat: string): number | null {
  const match = /^btime\s+(\d+)\s*$/m.exec(stat);
  if (!match?.[1]) return null;
  const seconds = Number(match[1]);
  return Number.isSafeInteger(seconds) ? seconds : null;
}

function readBootId(readFile: (path: string) => string): string | undefined {
  const memoize = readFile === readFileUtf8;
  if (memoize && ownBootId !== undefined) return ownBootId;
  let bootId: string;
  try {
    bootId = readFile(BOOT_ID_PATH).trim();
  } catch {
    return undefined;
  }
  if (!isBootId(bootId)) return undefined;
  if (memoize) ownBootId = bootId;
  return bootId;
}

function readLinuxProcessStart(
  pid: number,
  readFile: (path: string) => string,
): ProcessStart | null {
  const startTicks = parseProcStatStartTicks(readFile(`/proc/${pid}/stat`));
  if (startTicks === null) return null;
  const bootSeconds = parseBootTimeSeconds(readFile('/proc/stat'));
  if (bootSeconds === null) return null;
  const start: ProcessStart = {
    startedAtMs: bootSeconds * 1000 + startTicks * MS_PER_USER_HZ_TICK,
    clock: 'boot-derived',
    startTicks,
  };
  const bootId = readBootId(readFile);
  return bootId === undefined ? start : { ...start, bootId };
}

function readWindowsProcessStart(
  pid: number,
  readNative: NativeProcessStartReader | undefined,
): ProcessStart | null {
  const read = readNative ?? nativeReaderHost[NATIVE_PROCESS_START_READER];
  if (read === undefined) {
    if (!missingReaderWarned) {
      missingReaderWarned = true;
      log.warn(
        { event: 'process-start-reader-missing' },
        '[process-identity] no Windows process-start reader is registered, so lock holders cannot be verified; later reads are not recorded again while it stays missing',
      );
    }
    return null;
  }
  const startedAtMs = read(pid);
  return isNonNegativeSafeInteger(startedAtMs) ? { startedAtMs, clock: 'creation' } : null;
}

function readUncachedProcessStart(
  pid: number,
  platform: NodeJS.Platform,
  readFile: (path: string) => string,
  readNative: NativeProcessStartReader | undefined,
): ProcessStart | null {
  try {
    if (platform === 'linux') return readLinuxProcessStart(pid, readFile);
    if (platform === 'darwin') {
      const startedAtMs = readPsProcessStart(pid);
      return startedAtMs === null ? null : { startedAtMs, clock: 'creation' };
    }
    if (platform === 'win32') return readWindowsProcessStart(pid, readNative);
    return null;
  } catch {
    return null;
  }
}

export function readProcessStart(
  pid: number,
  options: ReadProcessStartOptions = {},
): ProcessStart | null {
  if (!isReadableProcessId(pid)) return null;
  const usesHost =
    options.platform === undefined &&
    options.readFile === undefined &&
    options.readNative === undefined;
  if (usesHost && pid === process.pid && ownProcessStart !== undefined) return ownProcessStart;
  const start = readUncachedProcessStart(
    pid,
    options.platform ?? process.platform,
    options.readFile ?? readFileUtf8,
    options.readNative,
  );
  if (usesHost && pid === process.pid && start !== null) ownProcessStart = start;
  return start;
}

export function createRecentProcessStartReader(
  options: RecentProcessStartReaderOptions,
): ProcessStartReader {
  const read = options.read ?? readProcessStart;
  const now = options.now ?? (() => performance.now());
  const failedReadHoldMs = Math.max(options.maxAgeMs, PS_PROCESS_START_QUERY_TIMEOUT_MS);
  const recent = new Map<number, { expiresAtMs: number; start: ProcessStart | null }>();
  return (pid) => {
    const at = now();
    for (const [cachedPid, entry] of recent) {
      if (at >= entry.expiresAtMs) recent.delete(cachedPid);
    }
    const cached = recent.get(pid);
    if (cached !== undefined) return cached.start;
    const start = read(pid);
    const holdMs = start === null ? failedReadHoldMs : options.maxAgeMs;
    recent.set(pid, { expiresAtMs: now() + holdMs, start });
    return start;
  };
}

export function processStartToken(
  start: ProcessStart | null | undefined,
): ProcessStartToken | undefined {
  if (!start) return undefined;
  if (start.bootId !== undefined && start.startTicks !== undefined) {
    return { bootId: start.bootId, startTicks: start.startTicks };
  }
  if (start.clock === 'creation') return { startedAtMs: start.startedAtMs };
  return undefined;
}

export function parseProcessStartToken(value: unknown): ProcessStartToken | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const { bootId, startTicks, startedAtMs } = value as Record<string, unknown>;
  if (isBootId(bootId) && isNonNegativeSafeInteger(startTicks)) return { bootId, startTicks };
  if (isNonNegativeSafeInteger(startedAtMs)) return { startedAtMs };
  return undefined;
}

export function recordsLockOwner(lock: LockOwnerFields): boolean {
  return typeof lock.machineId === 'string' || typeof lock.hostname === 'string';
}

export function isLockFromThisMachine(
  lock: LockOwnerFields,
  local: { readonly machineId?: string; readonly host?: string } = {},
): boolean {
  if (typeof lock.machineId === 'string') {
    return lock.machineId === (local.machineId ?? getMachineId());
  }
  return typeof lock.hostname === 'string' && lock.hostname === (local.host ?? hostname());
}

const INCOMPARABLE: LockHolderComparison = {
  verdict: 'unverified',
  cause: 'process-start-incomparable',
};
const MISMATCH: LockHolderComparison = { verdict: 'unverified', cause: 'process-start-mismatch' };
const RECORDED_IN_FUTURE: LockHolderComparison = {
  verdict: 'unverified',
  cause: 'recorded-start-in-future',
};
const WRITER_IDENTITY_UNRECORDED: LockHolderComparison = {
  verdict: 'unverified',
  cause: 'writer-identity-unrecorded',
};
const STARTED_AFTER_LOCK: LockHolderComparison = {
  verdict: 'unverified',
  cause: 'process-started-after-lock',
};

function compareWithStartedAt(
  startedAt: string | undefined,
  live: ProcessStart,
  refuseHolderStartedAfterLock: boolean,
): LockHolderComparison {
  const writtenAtMs = typeof startedAt === 'string' ? Date.parse(startedAt) : Number.NaN;
  if (!Number.isFinite(writtenAtMs)) return INCOMPARABLE;
  const margin =
    live.clock === 'creation' ? LEGACY_MARGIN_CREATION_MS : LEGACY_MARGIN_BOOT_DERIVED_MS;
  if (writtenAtMs - Date.now() > margin) return RECORDED_IN_FUTURE;
  const startedAfterLockMs = live.startedAtMs - writtenAtMs;
  if (startedAfterLockMs > margin) return { verdict: 'replaced' };
  if (refuseHolderStartedAfterLock && startedAfterLockMs > 0) return STARTED_AFTER_LOCK;
  return { verdict: 'writer' };
}

function compareLockHolderStart(
  lock: LockHolderIdentity,
  live: ProcessStart | null,
  refuseHolderStartedAfterLock: boolean,
): LockHolderComparison {
  if (live === null) return { verdict: 'unverified', cause: 'process-start-unreadable' };
  const token = parseProcessStartToken(lock.processStart);
  if (token === undefined) {
    return compareWithStartedAt(lock.startedAt, live, refuseHolderStartedAfterLock);
  }
  if ('bootId' in token) {
    if (live.bootId === undefined || live.startTicks === undefined) return INCOMPARABLE;
    if (token.bootId !== live.bootId) return { verdict: 'replaced' };
    if (live.startTicks === token.startTicks) return { verdict: 'writer' };
    return live.startTicks > token.startTicks ? { verdict: 'replaced' } : MISMATCH;
  }
  if (live.clock !== 'creation') return INCOMPARABLE;
  const drift = live.startedAtMs - token.startedAtMs;
  if (Math.abs(drift) <= TOKEN_TOLERANCE_MS) return { verdict: 'writer' };
  return drift > 0 ? { verdict: 'replaced' } : MISMATCH;
}

function recordsProcessStart(lock: LockHolderIdentity): boolean {
  return parseProcessStartToken(lock.processStart) !== undefined;
}

export function assessLockHolder(
  lock: LockHolderIdentity,
  options: ClassifyLockHolderOptions = {},
): LockHolderAssessment {
  const isAlive = options.isAlive ?? isProcessAlive;
  if (!isAlive(lock.pid)) return { verdict: 'gone' };
  const sameMachine = options.sameMachine ?? isLockFromThisMachine(lock);
  if (!sameMachine && !recordsLockOwner(lock))
    return { verdict: 'unverified', cause: 'unverified-owner' };
  const read = options.readProcessStart ?? readProcessStart;
  const start = read(lock.pid);
  if (start === null && !isAlive(lock.pid)) return { verdict: 'gone' };
  const comparison = compareLockHolderStart(
    lock,
    start,
    options.refuseHolderStartedAfterLock ?? false,
  );
  if (!sameMachine) {
    return comparison.verdict === 'writer' && recordsProcessStart(lock)
      ? comparison
      : { verdict: 'unverified', cause: 'foreign-host' };
  }
  if (
    comparison.verdict === 'writer' &&
    (options.formatRecordsMachineId ?? true) &&
    !recordsProcessStart(lock) &&
    typeof lock.machineId !== 'string'
  ) {
    return WRITER_IDENTITY_UNRECORDED;
  }
  return comparison;
}

export function verdictHoldsLock(verdict: LockHolderVerdict): boolean {
  switch (verdict) {
    case 'writer':
    case 'unverified':
      return true;
    case 'replaced':
    case 'gone':
      return false;
    default: {
      const exhaustive: never = verdict;
      return exhaustive;
    }
  }
}

export function classifyLockHolder(
  lock: LockHolderIdentity,
  options: ClassifyLockHolderOptions = {},
): LockHolderVerdict {
  return assessLockHolder(lock, options).verdict;
}
