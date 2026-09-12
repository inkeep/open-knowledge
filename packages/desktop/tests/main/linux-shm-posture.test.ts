import { describe, expect, test } from 'vitest';
import {
  applyDevShmPosture,
  DEV_SHM_PATH,
  type DevShmPosture,
  DISABLE_DEV_SHM_USAGE_SWITCH,
  decideDevShmPosture,
  type FsSpace,
  MIN_AVAILABLE_SHARED_MEMORY_BYTES,
} from '../../src/main/linux-shm-posture.ts';

const MiB = 1024 * 1024;
const GiB = 1024 * MiB;
const BSIZE = 4096;
const TMP = '/tmp';

function space(availableBytes: number, totalBytes = availableBytes): FsSpace {
  return { bsize: BSIZE, bavail: availableBytes / BSIZE, blocks: totalBytes / BSIZE };
}

function statfsFrom(table: Record<string, FsSpace | Error>) {
  const calls: string[] = [];
  const statfs = (path: string): FsSpace => {
    calls.push(path);
    const entry = table[path];
    if (entry === undefined) throw new Error(`ENOENT: ${path}`);
    if (entry instanceof Error) throw entry;
    return entry;
  };
  return { statfs, calls };
}

describe('decideDevShmPosture', () => {
  test('non-linux platforms never apply the switch and never touch the filesystem', () => {
    const { statfs, calls } = statfsFrom({});
    for (const platform of ['darwin', 'win32'] as const) {
      const posture = decideDevShmPosture({ platform, statfs, tmpDir: TMP });
      expect(posture.decision).toBe('not-linux');
    }
    expect(calls).toEqual([]);
  });

  test('a roomy /dev/shm keeps chromium on /dev/shm and never reads the tmpdir', () => {
    const { statfs, calls } = statfsFrom({
      [DEV_SHM_PATH]: space(2 * GiB),
      [TMP]: space(100 * GiB),
    });
    const posture = decideDevShmPosture({ platform: 'linux', statfs, tmpDir: TMP });
    expect(posture.decision).toBe('dev-shm-sufficient');
    expect(posture.devShmAvailableBytes).toBe(2 * GiB);
    expect(posture.tmpDirAvailableBytes).toBeNull();
    expect(calls).toEqual([DEV_SHM_PATH]);
  });

  test('exactly the threshold counts as sufficient', () => {
    const { statfs } = statfsFrom({ [DEV_SHM_PATH]: space(MIN_AVAILABLE_SHARED_MEMORY_BYTES) });
    const posture = decideDevShmPosture({ platform: 'linux', statfs, tmpDir: TMP });
    expect(posture.decision).toBe('dev-shm-sufficient');
    expect(posture.thresholdBytes).toBe(512 * MiB);
  });

  test('a 64 MiB /dev/shm with a roomier tmpdir redirects chromium to the tmpdir', () => {
    const { statfs } = statfsFrom({
      [DEV_SHM_PATH]: space(64 * MiB),
      [TMP]: space(20 * GiB, 40 * GiB),
    });
    const posture = decideDevShmPosture({ platform: 'linux', statfs, tmpDir: TMP });
    expect(posture.decision).toBe('redirect-to-tmpdir');
    expect(posture).toMatchObject({
      devShmAvailableBytes: 64 * MiB,
      devShmTotalBytes: 64 * MiB,
      tmpDir: TMP,
      tmpDirAvailableBytes: 20 * GiB,
    });
  });

  test('available space decides, not mount size: a large but nearly full /dev/shm redirects', () => {
    const { statfs } = statfsFrom({
      [DEV_SHM_PATH]: space(100 * MiB, 8 * GiB),
      [TMP]: space(20 * GiB),
    });
    const posture = decideDevShmPosture({ platform: 'linux', statfs, tmpDir: TMP });
    expect(posture.decision).toBe('redirect-to-tmpdir');
    expect(posture.devShmTotalBytes).toBe(8 * GiB);
  });

  test('two 64 MiB filesystems retain /dev/shm with a capacity warning', () => {
    const { statfs } = statfsFrom({ [DEV_SHM_PATH]: space(64 * MiB), [TMP]: space(64 * MiB) });
    const posture = decideDevShmPosture({ platform: 'linux', statfs, tmpDir: TMP });
    expect(posture.decision).toBe('keep-dev-shm-tmpdir-too-small');
  });

  test('a missing /dev/shm redirects when the tmpdir is readable', () => {
    const { statfs } = statfsFrom({ [TMP]: space(20 * GiB) });
    const posture = decideDevShmPosture({ platform: 'linux', statfs, tmpDir: TMP });
    expect(posture.decision).toBe('redirect-to-tmpdir');
    expect(posture.devShmAvailableBytes).toBeNull();
    expect(posture.devShmTotalBytes).toBeNull();
  });

  test('an unreadable tmpdir keeps chromium on /dev/shm', () => {
    const { statfs } = statfsFrom({ [DEV_SHM_PATH]: space(64 * MiB), [TMP]: new Error('EACCES') });
    const posture = decideDevShmPosture({ platform: 'linux', statfs, tmpDir: TMP });
    expect(posture.decision).toBe('keep-dev-shm-tmpdir-unreadable');
    expect(posture.tmpDirAvailableBytes).toBeNull();
  });
});

describe('fallback capacity and diagnostics', () => {
  test.each([0, 32, 65, 165, 511])(
    'a %i MiB target is not viable even with a smaller /dev/shm',
    (mib) => {
      const { statfs } = statfsFrom({ [DEV_SHM_PATH]: space(0), [TMP]: space(mib * MiB) });
      const posture = decideDevShmPosture({ platform: 'linux', statfs, tmpDir: TMP });
      expect(posture.decision).toBe('keep-dev-shm-tmpdir-too-small');
      expect(posture.tmpDirMinAvailableBytes).toBe(MIN_AVAILABLE_SHARED_MEMORY_BYTES);
      expect(posture.tmpDirAvailableBytes).toBe(mib * MiB);
    },
  );

  test('exactly 512 MiB at the fallback destination permits redirecting a 64 MiB /dev/shm', () => {
    const { statfs } = statfsFrom({ [DEV_SHM_PATH]: space(64 * MiB), [TMP]: space(512 * MiB) });
    const posture = decideDevShmPosture({ platform: 'linux', statfs, tmpDir: TMP });
    expect(posture.decision).toBe('redirect-to-tmpdir');
    expect(posture.tmpDirMinAvailableBytes).toBe(512 * MiB);
  });

  test.each(['ENOENT', 'EACCES', 'ENOSYS'])(
    'preserves the /dev/shm %s error in the diagnostic',
    (code) => {
      const { statfs } = statfsFrom({
        [DEV_SHM_PATH]: Object.assign(new Error('statfs failed'), { code }),
        [TMP]: space(GiB),
      });
      const posture = decideDevShmPosture({ platform: 'linux', statfs, tmpDir: TMP });
      expect(posture).toMatchObject({
        decision: 'redirect-to-tmpdir',
        devShmAvailableBytes: null,
        devShmErrorCode: code,
        tmpDirErrorCode: null,
      });
    },
  );

  test('preserves the temp directory measurement error', () => {
    const { statfs } = statfsFrom({
      [DEV_SHM_PATH]: space(64 * MiB),
      [TMP]: Object.assign(new Error('statfs failed'), { code: 'EACCES' }),
    });
    const posture = decideDevShmPosture({ platform: 'linux', statfs, tmpDir: TMP });
    expect(posture).toMatchObject({
      decision: 'keep-dev-shm-tmpdir-unreadable',
      devShmErrorCode: null,
      tmpDirErrorCode: 'EACCES',
    });
  });

  test('an unclassified thrown value does not crash startup', () => {
    const posture = decideDevShmPosture({
      platform: 'linux',
      statfs: () => {
        throw null;
      },
      tmpDir: TMP,
    });
    expect(posture).toMatchObject({
      decision: 'keep-dev-shm-tmpdir-unreadable',
      devShmErrorCode: 'UNKNOWN',
      tmpDirErrorCode: 'UNKNOWN',
    });
  });
});

describe('applyDevShmPosture', () => {
  function effects() {
    const switches: string[] = [];
    const logs: Array<{ level: 'info' | 'warn'; facts: DevShmPosture }> = [];
    return {
      switches,
      logs,
      appendSwitch: (name: string) => {
        switches.push(name);
      },
      log: (level: 'info' | 'warn', facts: DevShmPosture) => {
        logs.push({ level, facts });
      },
    };
  }

  test('applies the Chromium switch before logging its diagnostic', () => {
    const { statfs } = statfsFrom({ [DEV_SHM_PATH]: space(64 * MiB), [TMP]: space(750 * MiB) });
    const recorded = effects();
    const posture = applyDevShmPosture({
      platform: 'linux',
      statfs,
      env: {},
      appendSwitch: recorded.appendSwitch,
      log: (level, facts) => {
        expect(recorded.switches).toEqual([DISABLE_DEV_SHM_USAGE_SWITCH]);
        recorded.log(level, facts);
      },
    });
    expect(recorded.logs).toEqual([
      {
        level: 'info',
        facts: {
          event: 'desktop.linux-dev-shm-posture',
          decision: 'redirect-to-tmpdir',
          thresholdBytes: 512 * MiB,
          devShmAvailableBytes: 64 * MiB,
          devShmTotalBytes: 64 * MiB,
          tmpDir: TMP,
          tmpDirAvailableBytes: 750 * MiB,
          tmpDirMinAvailableBytes: 512 * MiB,
          devShmErrorCode: null,
          tmpDirErrorCode: null,
        },
      },
    ]);
    expect(posture.decision).toBe('redirect-to-tmpdir');
  });

  test.each(['darwin', 'win32'] as const)(
    '%s performs no measurement, switch change, or logging',
    (platform) => {
      const { statfs, calls } = statfsFrom({});
      const recorded = effects();
      applyDevShmPosture({ platform, statfs, env: {}, ...recorded });
      expect(calls).toEqual([]);
      expect(recorded.switches).toEqual([]);
      expect(recorded.logs).toEqual([]);
    },
  );

  test('sufficient shared memory is logged at info without adding a switch', () => {
    const { statfs } = statfsFrom({ [DEV_SHM_PATH]: space(512 * MiB) });
    const recorded = effects();
    const posture = applyDevShmPosture({ platform: 'linux', statfs, env: {}, ...recorded });
    expect(recorded.switches).toEqual([]);
    expect(recorded.logs).toEqual([{ level: 'info', facts: posture }]);
  });

  test.each([undefined, ''])('ignores TMP and TEMP when TMPDIR is %s', (tmpdir) => {
    const { statfs, calls } = statfsFrom({
      [DEV_SHM_PATH]: space(64 * MiB),
      [TMP]: space(165 * MiB),
      '/other-mount': space(20 * GiB),
    });
    const recorded = effects();
    const posture = applyDevShmPosture({
      platform: 'linux',
      statfs,
      env: { TMPDIR: tmpdir, TMP: '/other-mount', TEMP: '/other-mount' },
      ...recorded,
    });
    expect(calls).toEqual([DEV_SHM_PATH, TMP]);
    expect(recorded.switches).toEqual([]);
    expect(posture).toMatchObject({ tmpDir: TMP, decision: 'keep-dev-shm-tmpdir-too-small' });
    expect(recorded.logs).toEqual([{ level: 'warn', facts: posture }]);
  });

  test("measures Chromium's explicit TMPDIR destination", () => {
    const { statfs, calls } = statfsFrom({
      [DEV_SHM_PATH]: space(64 * MiB),
      [TMP]: space(165 * MiB),
      '/other-mount': space(750 * MiB),
    });
    const recorded = effects();
    const posture = applyDevShmPosture({
      platform: 'linux',
      statfs,
      env: { TMPDIR: '/other-mount' },
      ...recorded,
    });
    expect(calls).toEqual([DEV_SHM_PATH, '/other-mount']);
    expect(posture.tmpDir).toBe('/other-mount');
    expect(recorded.switches).toEqual([DISABLE_DEV_SHM_USAGE_SWITCH]);
  });

  test.each([
    { tmp: space(165 * MiB), expected: 'keep-dev-shm-tmpdir-too-small' },
    { tmp: new Error('unreadable'), expected: 'keep-dev-shm-tmpdir-unreadable' },
  ])('logs $expected at warn without adding a switch', ({ tmp, expected }) => {
    const { statfs } = statfsFrom({ [DEV_SHM_PATH]: space(64 * MiB), [TMP]: tmp });
    const recorded = effects();
    const posture = applyDevShmPosture({
      platform: 'linux',
      statfs,
      env: {},
      ...recorded,
    });
    expect(posture.decision).toBe(expected);
    expect(recorded.switches).toEqual([]);
    expect(recorded.logs).toEqual([{ level: 'warn', facts: posture }]);
  });
});
