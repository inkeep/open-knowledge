export const DEV_SHM_PATH = '/dev/shm';
export const MIN_AVAILABLE_SHARED_MEMORY_BYTES = 512 * 1024 * 1024;
export const DISABLE_DEV_SHM_USAGE_SWITCH = 'disable-dev-shm-usage';

type DevShmDecision =
  | 'not-linux'
  | 'dev-shm-sufficient'
  | 'redirect-to-tmpdir'
  | 'keep-dev-shm-tmpdir-unreadable'
  | 'keep-dev-shm-tmpdir-too-small';

const DEV_SHM_LOG_LEVELS = {
  'not-linux': null,
  'dev-shm-sufficient': 'info',
  'redirect-to-tmpdir': 'info',
  'keep-dev-shm-tmpdir-unreadable': 'warn',
  'keep-dev-shm-tmpdir-too-small': 'warn',
} satisfies Record<DevShmDecision, 'info' | 'warn' | null>;

export interface FsSpace {
  bavail: number;
  bsize: number;
  blocks: number;
}

export interface DevShmPostureDeps {
  platform: NodeJS.Platform;
  statfs: (path: string) => FsSpace;
  tmpDir: string;
}

export interface DevShmPosture {
  decision: DevShmDecision;
  event: 'desktop.linux-dev-shm-posture';
  thresholdBytes: number;
  devShmAvailableBytes: number | null;
  devShmTotalBytes: number | null;
  tmpDir: string;
  tmpDirAvailableBytes: number | null;
  tmpDirMinAvailableBytes: number;
  devShmErrorCode: string | null;
  tmpDirErrorCode: string | null;
}

type MeasuredSpace =
  | { available: number; total: number; errorCode: null }
  | { available: null; total: null; errorCode: string };

function measure(statfs: DevShmPostureDeps['statfs'], path: string): MeasuredSpace {
  try {
    const space = statfs(path);
    return {
      available: space.bavail * space.bsize,
      total: space.blocks * space.bsize,
      errorCode: null,
    };
  } catch (error) {
    const errorCode =
      error !== null &&
      typeof error === 'object' &&
      'code' in error &&
      typeof error.code === 'string'
        ? error.code
        : 'UNKNOWN';
    return { available: null, total: null, errorCode };
  }
}

export function decideDevShmPosture(deps: DevShmPostureDeps): DevShmPosture {
  const posture: DevShmPosture = {
    decision: 'not-linux',
    event: 'desktop.linux-dev-shm-posture',
    thresholdBytes: MIN_AVAILABLE_SHARED_MEMORY_BYTES,
    devShmAvailableBytes: null,
    devShmTotalBytes: null,
    tmpDir: deps.tmpDir,
    tmpDirAvailableBytes: null,
    tmpDirMinAvailableBytes: MIN_AVAILABLE_SHARED_MEMORY_BYTES,
    devShmErrorCode: null,
    tmpDirErrorCode: null,
  };
  if (deps.platform !== 'linux') return posture;

  const devShm = measure(deps.statfs, DEV_SHM_PATH);
  posture.devShmAvailableBytes = devShm.available;
  posture.devShmTotalBytes = devShm.total;
  posture.devShmErrorCode = devShm.errorCode;
  if (devShm.available !== null && devShm.available >= MIN_AVAILABLE_SHARED_MEMORY_BYTES) {
    posture.decision = 'dev-shm-sufficient';
    return posture;
  }

  const tmp = measure(deps.statfs, deps.tmpDir);
  posture.tmpDirAvailableBytes = tmp.available;
  posture.tmpDirErrorCode = tmp.errorCode;
  if (tmp.available === null) {
    posture.decision = 'keep-dev-shm-tmpdir-unreadable';
    return posture;
  }
  if (tmp.available < MIN_AVAILABLE_SHARED_MEMORY_BYTES) {
    posture.decision = 'keep-dev-shm-tmpdir-too-small';
    return posture;
  }
  posture.decision = 'redirect-to-tmpdir';
  return posture;
}

export function applyDevShmPosture(
  deps: Omit<DevShmPostureDeps, 'tmpDir'> & {
    env: NodeJS.ProcessEnv;
    appendSwitch: (name: string) => void;
    log: (level: 'info' | 'warn', facts: DevShmPosture) => void;
  },
): DevShmPosture {
  const posture = decideDevShmPosture({ ...deps, tmpDir: deps.env.TMPDIR || '/tmp' });
  if (posture.decision === 'not-linux') return posture;
  if (posture.decision === 'redirect-to-tmpdir') {
    deps.appendSwitch(DISABLE_DEV_SHM_USAGE_SWITCH);
  }
  const level = DEV_SHM_LOG_LEVELS[posture.decision];
  deps.log(level, posture);
  return posture;
}
