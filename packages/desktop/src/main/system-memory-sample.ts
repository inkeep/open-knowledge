import { execFile } from 'node:child_process';

type MemoryPressureLevel = 'normal' | 'warn' | 'critical';

type PressureUnreadableCause = 'timeout' | 'signal' | 'exit' | 'spawn' | 'unparsed';

export interface SystemMemorySample {
  totalKb: number;
  freeKb: number;
  swapTotalKb?: number;
  swapFreeKb?: number;
  swapUsedKb?: number;
  pressure?: MemoryPressureLevel | 'unreadable';
  pressureReadAt?: string;
  pressureUnreadableCause?: PressureUnreadableCause;
}

export interface ElectronSystemMemoryInfo {
  total: number;
  free: number;
  swapTotal?: number;
  swapFree?: number;
}

interface MacMemoryReading {
  pressure: MemoryPressureLevel | 'unreadable';
  swapUsedKb: number | null;
  unreadableCause?: PressureUnreadableCause;
  readAt: string;
}

export interface MacMemoryPressureProbe {
  latest(): MacMemoryReading | null;
  refresh(): void;
}

const PRESSURE_LEVELS: Readonly<Record<string, MemoryPressureLevel>> = {
  '1': 'normal',
  '2': 'warn',
  '4': 'critical',
};

const SWAP_UNIT_KB: Readonly<Record<string, number>> = { K: 1, M: 1024, G: 1024 * 1024 };

const MAC_MEMORY_SYSCTL_ARGS = ['-n', 'kern.memorystatus_vm_pressure_level', 'vm.swapusage'];

const MAC_MEMORY_SYSCTL_TIMEOUT_MS = 2_000;

function runMacMemorySysctl(): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      '/usr/sbin/sysctl',
      MAC_MEMORY_SYSCTL_ARGS,
      { timeout: MAC_MEMORY_SYSCTL_TIMEOUT_MS, windowsHide: true },
      (err, stdout) => (err ? reject(err) : resolve(stdout)),
    );
  });
}

export function parseMacMemorySysctl(stdout: string): Omit<MacMemoryReading, 'readAt'> {
  const [levelLine = '', swapLine = ''] = stdout.split('\n');
  const used = /\bused = ([\d.]+)([KMG])\b/.exec(swapLine);
  const swapUsedKb =
    used === null
      ? null
      : Math.round(Number(used[1]) * (SWAP_UNIT_KB[used[2] ?? ''] ?? Number.NaN));
  const pressure = PRESSURE_LEVELS[levelLine.trim()];
  return {
    pressure: pressure ?? 'unreadable',
    swapUsedKb: swapUsedKb !== null && Number.isFinite(swapUsedKb) ? swapUsedKb : null,
    ...(pressure === undefined ? { unreadableCause: 'unparsed' as const } : {}),
  };
}

function classifySysctlFailure(err: unknown): PressureUnreadableCause {
  const failure = err as { killed?: unknown; code?: unknown; signal?: unknown } | null;
  if (failure?.killed === true) return 'timeout';
  if (typeof failure?.code === 'number') return 'exit';
  return typeof failure?.signal === 'string' ? 'signal' : 'spawn';
}

export function createMacMemoryPressureProbe(deps: {
  runSysctl?(): Promise<string>;
  now(): Date;
}): MacMemoryPressureProbe {
  const runSysctl = deps.runSysctl ?? runMacMemorySysctl;
  let latest: MacMemoryReading | null = null;
  let inFlight = false;
  return {
    latest: () => latest,
    refresh() {
      if (inFlight) return;
      inFlight = true;
      runSysctl()
        .then(
          (stdout) => parseMacMemorySysctl(stdout),
          (err: unknown) => ({
            pressure: 'unreadable' as const,
            swapUsedKb: null,
            unreadableCause: classifySysctlFailure(err),
          }),
        )
        .then((reading) => {
          latest = { ...reading, readAt: deps.now().toISOString() };
        })
        .finally(() => {
          inFlight = false;
        });
    },
  };
}

export function readSystemMemorySample(
  info: ElectronSystemMemoryInfo,
  mac: MacMemoryReading | null,
): SystemMemorySample {
  const swapUsedKb =
    mac?.swapUsedKb ??
    (info.swapTotal !== undefined && info.swapFree !== undefined
      ? info.swapTotal - info.swapFree
      : undefined);
  return {
    totalKb: info.total,
    freeKb: info.free,
    ...(info.swapTotal === undefined ? {} : { swapTotalKb: info.swapTotal }),
    ...(info.swapFree === undefined ? {} : { swapFreeKb: info.swapFree }),
    ...(swapUsedKb === undefined ? {} : { swapUsedKb }),
    ...(mac === null ? {} : { pressure: mac.pressure, pressureReadAt: mac.readAt }),
    ...(mac?.unreadableCause === undefined ? {} : { pressureUnreadableCause: mac.unreadableCause }),
  };
}
