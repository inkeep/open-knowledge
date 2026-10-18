import { type ExecFileSyncOptionsWithStringEncoding, execFileSync } from 'node:child_process';
import { hostname } from 'node:os';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  processStartTokenFromOs,
  readProcessStartFromOs,
} from '../../../test-support/os-process-start.test-helper.ts';
import {
  lockWrittenBeforeProcessStarted,
  lockWrittenByRunningProcess,
  type OwnedProcess,
  startOwnedProcess,
  stopOwnedProcess,
} from '../../../test-support/owned-process.test-helper.ts';
import { getLogger } from './logger.ts';
import { getMachineId } from './machine-id.ts';
import {
  assessLockHolder,
  classifyLockHolder,
  createRecentProcessStartReader,
  isLockFromThisMachine,
  type LockHolderIdentity,
  type LockHolderVerdict,
  type ProcessStart,
  parseProcessStartToken,
  processStartToken,
  readProcessStart,
  readPsProcessStart,
  registerNativeProcessStartReader,
  type UnverifiedLockHolderCause,
} from './process-identity.ts';

const WRITTEN_AT = '2026-10-01T12:00:00.000Z';
const WRITTEN_AT_MS = Date.parse(WRITTEN_AT);
const THIRTY_SIX_HOURS_MS = 36 * 60 * 60 * 1000;
const HOLDER_PID = 4242;
const THIRTY_SIX_HOURS_BEFORE_WRITTEN_AT = new Date(
  WRITTEN_AT_MS - THIRTY_SIX_HOURS_MS,
).toISOString();

function lockWrittenAt(extra: Partial<LockHolderIdentity> = {}): LockHolderIdentity {
  return { pid: HOLDER_PID, startedAt: WRITTEN_AT, ...extra };
}

function creationStart(offsetFromWrittenMs: number): ProcessStart {
  return { startedAtMs: WRITTEN_AT_MS + offsetFromWrittenMs, clock: 'creation' };
}

function bootDerivedStart(
  offsetFromWrittenMs: number,
  pair?: { bootId: string; startTicks: number },
): ProcessStart {
  return { startedAtMs: WRITTEN_AT_MS + offsetFromWrittenMs, clock: 'boot-derived', ...pair };
}

interface ComparatorRow {
  name: string;
  lock: LockHolderIdentity;
  live: ProcessStart | null;
  expected: Exclude<LockHolderVerdict, 'gone'>;
  cause?: UnverifiedLockHolderCause;
  refuseHolderStartedAfterLock?: boolean;
}

const BOOT_PAIR_TOKEN = { bootId: 'boot-a', startTicks: 5_000 };

const comparatorRows: ComparatorRow[] = [
  {
    name: 'no reading of the holder is unverified',
    lock: lockWrittenAt(),
    live: null,
    expected: 'unverified',
    cause: 'process-start-unreadable',
  },
  {
    name: 'a boot pair from another boot is replaced',
    lock: lockWrittenAt({ processStart: BOOT_PAIR_TOKEN }),
    live: bootDerivedStart(0, { bootId: 'boot-b', startTicks: 5_000 }),
    expected: 'replaced',
  },
  {
    name: 'equal ticks on the same boot are the writer even when startedAt is 36 h old',
    lock: lockWrittenAt({ processStart: BOOT_PAIR_TOKEN }),
    live: bootDerivedStart(THIRTY_SIX_HOURS_MS, { bootId: 'boot-a', startTicks: 5_000 }),
    expected: 'writer',
  },
  {
    name: 'later ticks on the same boot are replaced even when startedAt looks current',
    lock: lockWrittenAt({ processStart: BOOT_PAIR_TOKEN }),
    live: bootDerivedStart(0, { bootId: 'boot-a', startTicks: 5_001 }),
    expected: 'replaced',
  },
  {
    name: 'earlier ticks on the same boot are unverified',
    lock: lockWrittenAt({ processStart: BOOT_PAIR_TOKEN }),
    live: bootDerivedStart(0, { bootId: 'boot-a', startTicks: 4_999 }),
    expected: 'unverified',
    cause: 'process-start-mismatch',
  },
  {
    name: 'a creation start 1000 ms after the token is the writer even when startedAt is 36 h old',
    lock: lockWrittenAt({
      startedAt: THIRTY_SIX_HOURS_BEFORE_WRITTEN_AT,
      processStart: { startedAtMs: WRITTEN_AT_MS },
    }),
    live: creationStart(1_000),
    expected: 'writer',
  },
  {
    name: 'a creation start 1000 ms before the token is the writer even when startedAt is 36 h old',
    lock: lockWrittenAt({
      startedAt: THIRTY_SIX_HOURS_BEFORE_WRITTEN_AT,
      processStart: { startedAtMs: WRITTEN_AT_MS },
    }),
    live: creationStart(-1_000),
    expected: 'writer',
  },
  {
    name: 'a creation start 1001 ms after the token is replaced even when startedAt looks current',
    lock: lockWrittenAt({ processStart: { startedAtMs: WRITTEN_AT_MS - 2_000 } }),
    live: creationStart(-2_000 + 1_001),
    expected: 'replaced',
  },
  {
    name: 'a creation start 1001 ms before the token is unverified',
    lock: lockWrittenAt({ processStart: { startedAtMs: WRITTEN_AT_MS } }),
    live: creationStart(-1_001),
    expected: 'unverified',
    cause: 'process-start-mismatch',
  },
  {
    name: 'a legacy lock whose creation-clock holder started 9999 ms later is the writer',
    lock: lockWrittenAt(),
    live: creationStart(9_999),
    expected: 'writer',
  },
  {
    name: 'a legacy lock whose creation-clock holder started 10000 ms later is the writer',
    lock: lockWrittenAt(),
    live: creationStart(10_000),
    expected: 'writer',
  },
  {
    name: 'a legacy lock whose creation-clock holder started 10001 ms later is replaced',
    lock: lockWrittenAt(),
    live: creationStart(10_001),
    expected: 'replaced',
  },
  {
    name: 'a legacy lock whose boot-derived holder started 299999 ms later is the writer',
    lock: lockWrittenAt(),
    live: bootDerivedStart(299_999),
    expected: 'writer',
  },
  {
    name: 'a legacy lock whose boot-derived holder started 300001 ms later is replaced',
    lock: lockWrittenAt(),
    live: bootDerivedStart(300_001),
    expected: 'replaced',
  },
  {
    name: 'a legacy lock whose holder started before it was written is the writer',
    lock: lockWrittenAt(),
    live: creationStart(-60_000),
    expected: 'writer',
  },
  {
    name: 'refusing later holders, a legacy lock whose creation-clock holder started 1 ms later is unverified',
    lock: lockWrittenAt(),
    live: creationStart(1),
    expected: 'unverified',
    cause: 'process-started-after-lock',
    refuseHolderStartedAfterLock: true,
  },
  {
    name: 'refusing later holders, a legacy lock whose creation-clock holder started 9999 ms later is unverified',
    lock: lockWrittenAt(),
    live: creationStart(9_999),
    expected: 'unverified',
    cause: 'process-started-after-lock',
    refuseHolderStartedAfterLock: true,
  },
  {
    name: 'refusing later holders, a legacy lock whose creation-clock holder started 10001 ms later is replaced',
    lock: lockWrittenAt(),
    live: creationStart(10_001),
    expected: 'replaced',
    refuseHolderStartedAfterLock: true,
  },
  {
    name: 'refusing later holders, a legacy lock whose creation-clock holder started as it was written is the writer',
    lock: lockWrittenAt(),
    live: creationStart(0),
    expected: 'writer',
    refuseHolderStartedAfterLock: true,
  },
  {
    name: 'refusing later holders, a legacy lock whose boot-derived holder started 1 ms later is unverified',
    lock: lockWrittenAt(),
    live: bootDerivedStart(1),
    expected: 'unverified',
    cause: 'process-started-after-lock',
    refuseHolderStartedAfterLock: true,
  },
  {
    name: 'refusing later holders, a legacy lock whose boot-derived holder started 299999 ms later is unverified',
    lock: lockWrittenAt(),
    live: bootDerivedStart(299_999),
    expected: 'unverified',
    cause: 'process-started-after-lock',
    refuseHolderStartedAfterLock: true,
  },
  {
    name: 'refusing later holders, a legacy lock whose boot-derived holder started 300001 ms later is replaced',
    lock: lockWrittenAt(),
    live: bootDerivedStart(300_001),
    expected: 'replaced',
    refuseHolderStartedAfterLock: true,
  },
  {
    name: 'refusing later holders, a legacy lock whose boot-derived holder started before it was written is the writer',
    lock: lockWrittenAt(),
    live: bootDerivedStart(-60_000),
    expected: 'writer',
    refuseHolderStartedAfterLock: true,
  },
  {
    name: 'refusing later holders, a lock with a creation token is judged by the token alone even when its holder started after startedAt',
    lock: lockWrittenAt({ processStart: { startedAtMs: WRITTEN_AT_MS } }),
    live: creationStart(1_000),
    expected: 'writer',
    refuseHolderStartedAfterLock: true,
  },
  {
    name: 'a legacy lock with an unparseable startedAt is unverified',
    lock: lockWrittenAt({ startedAt: 'not a date' }),
    live: creationStart(THIRTY_SIX_HOURS_MS),
    expected: 'unverified',
    cause: 'process-start-incomparable',
  },
  {
    name: 'a legacy lock without startedAt is unverified',
    lock: { pid: HOLDER_PID },
    live: creationStart(THIRTY_SIX_HOURS_MS),
    expected: 'unverified',
    cause: 'process-start-incomparable',
  },
  {
    name: 'a millisecond token read against a boot-derived clock is unverified',
    lock: lockWrittenAt({ processStart: { startedAtMs: WRITTEN_AT_MS - THIRTY_SIX_HOURS_MS } }),
    live: bootDerivedStart(1_000),
    expected: 'unverified',
    cause: 'process-start-incomparable',
  },
  {
    name: 'a boot pair token read against a creation reading is unverified',
    lock: lockWrittenAt({ processStart: BOOT_PAIR_TOKEN }),
    live: creationStart(1_000),
    expected: 'unverified',
    cause: 'process-start-incomparable',
  },
  {
    name: 'a boot pair token read against a boot-derived reading without a boot id is unverified',
    lock: lockWrittenAt({ processStart: BOOT_PAIR_TOKEN }),
    live: bootDerivedStart(1_000),
    expected: 'unverified',
    cause: 'process-start-incomparable',
  },
  {
    name: 'a malformed token falls back to startedAt',
    lock: lockWrittenAt({ processStart: { startedAtMs: 'soon' } }),
    live: creationStart(10_001),
    expected: 'replaced',
  },
  {
    name: 'a token carrying both shapes is read as its boot pair',
    lock: lockWrittenAt({
      processStart: { startedAtMs: WRITTEN_AT_MS + 10_001, ...BOOT_PAIR_TOKEN },
    }),
    live: creationStart(10_001),
    expected: 'unverified',
    cause: 'process-start-incomparable',
  },
];

describe('assessLockHolder', () => {
  test.each(comparatorRows)(
    '$name, naming the comparison that decided it',
    ({ lock, live, expected, cause, refuseHolderStartedAfterLock }) => {
      expect(
        assessLockHolder(
          { machineId: getMachineId(), ...lock },
          {
            isAlive: () => true,
            readProcessStart: () => live,
            sameMachine: true,
            refuseHolderStartedAfterLock,
          },
        ),
      ).toEqual(expected === 'unverified' ? { verdict: expected, cause } : { verdict: expected });
    },
  );

  test('names another machine for its lock when the local start cannot be read either', () => {
    expect(
      assessLockHolder(lockWrittenAt({ machineId: 'another-machine-0000' }), {
        isAlive: () => true,
        readProcessStart: () => null,
      }),
    ).toEqual({ verdict: 'unverified', cause: 'foreign-host' });
  });

  test('names another machine for its lock when the recorded start contradicts the holder', () => {
    expect(
      assessLockHolder(
        lockWrittenAt({
          machineId: 'another-machine-0000',
          processStart: { startedAtMs: WRITTEN_AT_MS },
        }),
        { isAlive: () => true, readProcessStart: () => creationStart(-60_000) },
      ),
    ).toEqual({ verdict: 'unverified', cause: 'foreign-host' });
  });

  test('does not read the start of a holder named by a lock that records no owner', () => {
    const readPids: number[] = [];
    expect(
      assessLockHolder(lockWrittenAt(), {
        isAlive: () => true,
        readProcessStart: (pid) => {
          readPids.push(pid);
          return creationStart(-60_000);
        },
      }),
    ).toEqual({ verdict: 'unverified', cause: 'unverified-owner' });
    expect(readPids).toEqual([]);
  });

  test('a lock naming only another hostname with a startedAt in the future vouches for no holder', () => {
    expect(
      assessLockHolder(
        { pid: HOLDER_PID, hostname: 'elsewhere.invalid', startedAt: '2099-01-01T00:00:00.000Z' },
        {
          isAlive: () => true,
          readProcessStart: () => ({ startedAtMs: Date.now() - 60_000, clock: 'creation' }),
        },
      ),
    ).toEqual({ verdict: 'unverified', cause: 'foreign-host' });
  });

  test('a lock from this machine with a startedAt ahead of the clock is refused for that reason', () => {
    expect(
      assessLockHolder(
        { pid: HOLDER_PID, machineId: getMachineId(), startedAt: '2099-01-01T00:00:00.000Z' },
        {
          isAlive: () => true,
          readProcessStart: () => ({ startedAtMs: Date.now() - 60_000, clock: 'creation' }),
        },
      ),
    ).toEqual({ verdict: 'unverified', cause: 'recorded-start-in-future' });
  });

  test('a lock naming only this hostname cannot confirm an earlier-started holder', () => {
    expect(
      assessLockHolder(lockWrittenAt({ hostname: hostname() }), {
        isAlive: () => true,
        readProcessStart: () => creationStart(-60_000),
      }),
    ).toEqual({ verdict: 'unverified', cause: 'writer-identity-unrecorded' });
  });

  test('a lock whose format has no machine ID confirms an earlier-started holder on this hostname', () => {
    expect(
      assessLockHolder(lockWrittenAt({ hostname: hostname() }), {
        isAlive: () => true,
        readProcessStart: () => creationStart(-60_000),
        sameMachine: true,
        formatRecordsMachineId: false,
      }),
    ).toEqual({ verdict: 'writer' });
  });

  test('a lock naming only this hostname whose pid now belongs to a later process is replaced', () => {
    expect(
      assessLockHolder(lockWrittenAt({ hostname: hostname() }), {
        isAlive: () => true,
        readProcessStart: () => creationStart(THIRTY_SIX_HOURS_MS),
      }),
    ).toEqual({ verdict: 'replaced' });
  });

  test('a holder that exits while its start is read is gone', () => {
    const liveness = [true, false];
    expect(
      assessLockHolder(lockWrittenAt({ machineId: getMachineId() }), {
        isAlive: () => liveness.shift() ?? false,
        readProcessStart: () => null,
      }),
    ).toEqual({ verdict: 'gone' });
  });
});

describe('classifyLockHolder', () => {
  test('a holder that is no longer running is gone without reading its start', () => {
    const readPids: number[] = [];
    const verdict = classifyLockHolder(lockWrittenAt({ machineId: getMachineId() }), {
      isAlive: () => false,
      readProcessStart: (pid) => {
        readPids.push(pid);
        return creationStart(0);
      },
    });
    expect({ verdict, readPids }).toEqual({ verdict: 'gone', readPids: [] });
  });

  test('a running holder whose start cannot be read is unverified', () => {
    expect(
      classifyLockHolder(lockWrittenAt({ machineId: getMachineId() }), {
        isAlive: () => true,
        readProcessStart: () => null,
      }),
    ).toBe('unverified');
  });

  test('a later-started holder of a lock from this machine is replaced', () => {
    expect(
      classifyLockHolder(lockWrittenAt({ machineId: getMachineId() }), {
        isAlive: () => true,
        readProcessStart: () => creationStart(THIRTY_SIX_HOURS_MS),
      }),
    ).toBe('replaced');
  });

  test('a later-started holder of a lock from another machine is unverified', () => {
    expect(
      classifyLockHolder(lockWrittenAt({ machineId: 'another-machine-0000' }), {
        isAlive: () => true,
        readProcessStart: () => creationStart(THIRTY_SIX_HOURS_MS),
      }),
    ).toBe('unverified');
  });

  test('a caller that has established the lock is local keeps the replaced verdict', () => {
    expect(
      classifyLockHolder(lockWrittenAt({ machineId: 'another-machine-0000' }), {
        isAlive: () => true,
        readProcessStart: () => creationStart(THIRTY_SIX_HOURS_MS),
        sameMachine: true,
      }),
    ).toBe('replaced');
  });

  test('a caller that has established the lock is foreign downgrades replaced to unverified', () => {
    expect(
      classifyLockHolder(lockWrittenAt({ machineId: getMachineId() }), {
        isAlive: () => true,
        readProcessStart: () => creationStart(THIRTY_SIX_HOURS_MS),
        sameMachine: false,
      }),
    ).toBe('unverified');
  });

  test('an earlier-started holder of a lock from another machine id is unverified without a recorded start', () => {
    expect(
      classifyLockHolder(lockWrittenAt({ machineId: 'another-machine-0000' }), {
        isAlive: () => true,
        readProcessStart: () => creationStart(-60_000),
      }),
    ).toBe('unverified');
  });

  test('a holder matching the recorded start is the writer of a lock from another machine id', () => {
    expect(
      classifyLockHolder(
        lockWrittenAt({
          machineId: 'another-machine-0000',
          processStart: { startedAtMs: WRITTEN_AT_MS - 60_000 },
        }),
        { isAlive: () => true, readProcessStart: () => creationStart(-60_000) },
      ),
    ).toBe('writer');
  });

  test('an earlier-started holder of a lock naming only another hostname is unverified', () => {
    expect(
      classifyLockHolder(lockWrittenAt({ hostname: 'elsewhere.invalid' }), {
        isAlive: () => true,
        readProcessStart: () => creationStart(-60_000),
      }),
    ).toBe('unverified');
  });

  test('an earlier-started holder of a lock that records no owner is unverified', () => {
    expect(
      classifyLockHolder(lockWrittenAt(), {
        isAlive: () => true,
        readProcessStart: () => creationStart(-60_000),
      }),
    ).toBe('unverified');
  });

  test('a reader that has established the lock is local judges an ownerless lock by its start', () => {
    expect(
      classifyLockHolder(lockWrittenAt(), {
        isAlive: () => true,
        readProcessStart: () => creationStart(THIRTY_SIX_HOURS_MS),
        sameMachine: true,
      }),
    ).toBe('replaced');
  });
});

describe('createRecentProcessStartReader', () => {
  function recentReader(readings: Array<ProcessStart | null>, readTakesMs = 0) {
    let nowMs = 0;
    const readPids: number[] = [];
    const read = createRecentProcessStartReader({
      maxAgeMs: 1_000,
      read: (pid) => {
        readPids.push(pid);
        nowMs += readTakesMs;
        return readings.shift() ?? null;
      },
      now: () => nowMs,
    });
    return {
      read,
      readPids,
      advance: (ms: number) => {
        nowMs += ms;
      },
    };
  }

  test('answers a repeated read of a pid inside the maximum age without reading it again', () => {
    const recent = recentReader([creationStart(0), creationStart(THIRTY_SIX_HOURS_MS)]);
    expect(recent.read(HOLDER_PID)).toEqual(creationStart(0));
    recent.advance(999);
    expect(recent.read(HOLDER_PID)).toEqual(creationStart(0));
    expect(recent.readPids).toEqual([HOLDER_PID]);
  });

  test('reads the pid again once its reading reaches the maximum age', () => {
    const recent = recentReader([creationStart(0), creationStart(THIRTY_SIX_HOURS_MS)]);
    recent.read(HOLDER_PID);
    recent.advance(1_000);
    expect(recent.read(HOLDER_PID)).toEqual(creationStart(THIRTY_SIX_HOURS_MS));
    expect(recent.readPids).toEqual([HOLDER_PID, HOLDER_PID]);
  });

  test('does not retry a failed read inside the maximum age', () => {
    const recent = recentReader([null, creationStart(0)]);
    expect(recent.read(HOLDER_PID)).toBeNull();
    recent.advance(500);
    expect(recent.read(HOLDER_PID)).toBeNull();
    expect(recent.readPids).toEqual([HOLDER_PID]);
  });

  test('counts the age of a reading from when its read returned, however long the read took', () => {
    const recent = recentReader([creationStart(0), creationStart(THIRTY_SIX_HOURS_MS)], 1_500);
    expect(recent.read(HOLDER_PID)).toEqual(creationStart(0));
    recent.advance(999);
    expect(recent.read(HOLDER_PID)).toEqual(creationStart(0));
    expect(recent.readPids).toEqual([HOLDER_PID]);
  });

  test('holds a failed reading for as long as a timed-out ps read can block', () => {
    const recent = recentReader([null, creationStart(0)], 5_000);
    expect(recent.read(HOLDER_PID)).toBeNull();
    recent.advance(4_999);
    expect(recent.read(HOLDER_PID)).toBeNull();
    expect(recent.readPids).toEqual([HOLDER_PID]);
    recent.advance(1);
    expect(recent.read(HOLDER_PID)).toEqual(creationStart(0));
    expect(recent.readPids).toEqual([HOLDER_PID, HOLDER_PID]);
  });

  test('reads each pid on its own', () => {
    const recent = recentReader([creationStart(0), creationStart(1)]);
    recent.read(HOLDER_PID);
    expect(recent.read(HOLDER_PID + 1)).toEqual(creationStart(1));
    expect(recent.readPids).toEqual([HOLDER_PID, HOLDER_PID + 1]);
  });
});

describe('isLockFromThisMachine', () => {
  test('a matching machine id is this machine even when the hostname differs', () => {
    expect(
      isLockFromThisMachine({ machineId: getMachineId(), hostname: 'elsewhere.invalid' }),
    ).toBe(true);
  });

  test('a different machine id is another machine even when the hostname matches', () => {
    expect(isLockFromThisMachine({ machineId: 'another-machine-0000', hostname: hostname() })).toBe(
      false,
    );
  });

  test('without a machine id a matching hostname is this machine', () => {
    expect(isLockFromThisMachine({ hostname: hostname() })).toBe(true);
  });

  test('without a machine id a different hostname is another machine', () => {
    expect(isLockFromThisMachine({ hostname: 'elsewhere.invalid' })).toBe(false);
  });
});

describe('processStartToken', () => {
  test('a reading with a boot pair records the pair', () => {
    expect(
      processStartToken({
        startedAtMs: WRITTEN_AT_MS,
        clock: 'boot-derived',
        startTicks: 7_311,
        bootId: 'boot-a',
      }),
    ).toEqual({ bootId: 'boot-a', startTicks: 7_311 });
  });

  test('a creation reading records its milliseconds', () => {
    expect(processStartToken(creationStart(0))).toEqual({ startedAtMs: WRITTEN_AT_MS });
  });

  test('a boot-derived reading without a boot id records nothing', () => {
    expect(
      processStartToken({ startedAtMs: WRITTEN_AT_MS, clock: 'boot-derived', startTicks: 7_311 }),
    ).toBeUndefined();
    expect(processStartToken(bootDerivedStart(0))).toBeUndefined();
  });

  test('no reading records nothing', () => {
    expect(processStartToken(null)).toBeUndefined();
  });
});

describe('parseProcessStartToken', () => {
  test.each([
    { name: 'a boot pair', value: { bootId: 'boot-a', startTicks: 7_311 } },
    { name: 'a boot pair at tick zero', value: { bootId: 'boot-a', startTicks: 0 } },
    { name: 'a creation time', value: { startedAtMs: WRITTEN_AT_MS } },
    { name: 'a creation time at the epoch', value: { startedAtMs: 0 } },
  ])('accepts $name', ({ value }) => {
    expect(parseProcessStartToken(value)).toEqual(value);
  });

  test.each([
    { name: 'null', value: null },
    { name: 'a string', value: '{"startedAtMs":1}' },
    { name: 'a number', value: WRITTEN_AT_MS },
    { name: 'an array', value: [WRITTEN_AT_MS] },
    { name: 'an empty object', value: {} },
    { name: 'an empty boot id', value: { bootId: '', startTicks: 1 } },
    { name: 'an overlong boot id', value: { bootId: 'b'.repeat(65), startTicks: 1 } },
    { name: 'a non-string boot id', value: { bootId: 42, startTicks: 1 } },
    { name: 'negative ticks', value: { bootId: 'boot-a', startTicks: -1 } },
    { name: 'fractional ticks', value: { bootId: 'boot-a', startTicks: 1.5 } },
    { name: 'a boot id without ticks', value: { bootId: 'boot-a' } },
    { name: 'ticks without a boot id', value: { startTicks: 1 } },
    { name: 'negative milliseconds', value: { startedAtMs: -1 } },
    { name: 'unsafe milliseconds', value: { startedAtMs: 2 ** 53 } },
    { name: 'string milliseconds', value: { startedAtMs: String(WRITTEN_AT_MS) } },
    { name: 'only unknown fields', value: { pid: 1, creationTicks: 9 } },
  ])('rejects $name', ({ value }) => {
    expect(parseProcessStartToken(value)).toBeUndefined();
  });

  test.each([
    {
      name: 'a creation time with an extra field',
      value: { startedAtMs: WRITTEN_AT_MS, pid: 1 },
      token: { startedAtMs: WRITTEN_AT_MS },
    },
    {
      name: 'a boot pair with an extra field',
      value: { bootId: 'boot-a', startTicks: 7_311, namespace: 'pid:[4026531836]' },
      token: { bootId: 'boot-a', startTicks: 7_311 },
    },
    {
      name: 'both shapes at once, preferring the boot pair',
      value: { startedAtMs: WRITTEN_AT_MS, bootId: 'boot-a', startTicks: 1 },
      token: { bootId: 'boot-a', startTicks: 1 },
    },
    {
      name: 'both shapes with an invalid boot pair, falling back to the creation time',
      value: { startedAtMs: WRITTEN_AT_MS, bootId: '', startTicks: 1 },
      token: { startedAtMs: WRITTEN_AT_MS },
    },
  ])('reads $name and drops what it does not know', ({ value, token }) => {
    expect(parseProcessStartToken(value)).toEqual(token);
  });

  test('every token a writer records parses back to itself', () => {
    const readings: ProcessStart[] = [
      creationStart(0),
      { startedAtMs: WRITTEN_AT_MS, clock: 'boot-derived', startTicks: 0, bootId: 'boot-a' },
      {
        startedAtMs: WRITTEN_AT_MS,
        clock: 'boot-derived',
        startTicks: 7_311,
        bootId: 'b'.repeat(64),
      },
    ];
    for (const reading of readings) {
      const token = processStartToken(reading);
      expect(token).toBeDefined();
      expect(parseProcessStartToken(token)).toEqual(token);
    }
  });
});

const FIXTURE_PID = 4242;
const FIXTURE_START_TICKS = 98_765_432;
const FIXTURE_BTIME_SECONDS = 1_760_000_000;
const FIXTURE_BOOT_ID = '6f1c2a3b-0000-4000-8000-0123456789ab';
const FIXTURE_STAT_WITH_AWKWARD_COMM = `${FIXTURE_PID} (w) x (y) z) S 1 ${FIXTURE_PID} ${FIXTURE_PID} 0 -1 4194560 120 0 0 0 3 1 0 0 20 0 1 0 ${FIXTURE_START_TICKS} 1060864 220 18446744073709551615 1 1 0 0 0 0 0 0 0 0 0 0 17 3 0 0 0 0 0\n`;
const FIXTURE_PROC_STAT = `cpu  10 0 10 1000 0 0 0 0 0 0\ncpu0 10 0 10 1000 0 0 0 0 0 0\nintr 1 0\nctxt 123\nbtime ${FIXTURE_BTIME_SECONDS}\nprocesses 99\nprocs_running 1\n`;

function procFiles(files: Record<string, string>): (path: string) => string {
  return (path) => {
    const content = files[path];
    if (content === undefined) {
      throw Object.assign(new Error(`ENOENT: no such file or directory, open '${path}'`), {
        code: 'ENOENT',
      });
    }
    return content;
  };
}

function linuxProcFor(pid: number, overrides: Record<string, string | undefined> = {}) {
  const files: Record<string, string> = {
    [`/proc/${pid}/stat`]: FIXTURE_STAT_WITH_AWKWARD_COMM,
    '/proc/stat': FIXTURE_PROC_STAT,
    '/proc/sys/kernel/random/boot_id': `${FIXTURE_BOOT_ID}\n`,
  };
  for (const [path, content] of Object.entries(overrides)) {
    if (content === undefined) delete files[path];
    else files[path] = content;
  }
  return procFiles(files);
}

describe('readProcessStart on Linux', () => {
  test('reads start ticks after the last parenthesis of a comm containing spaces and parentheses', () => {
    expect(
      readProcessStart(FIXTURE_PID, { platform: 'linux', readFile: linuxProcFor(FIXTURE_PID) }),
    ).toEqual({
      startedAtMs: FIXTURE_BTIME_SECONDS * 1000 + FIXTURE_START_TICKS * 10,
      clock: 'boot-derived',
      startTicks: FIXTURE_START_TICKS,
      bootId: FIXTURE_BOOT_ID,
    });
  });

  test('a host whose boot id cannot be read yields a reading that records no token', () => {
    const start = readProcessStart(FIXTURE_PID, {
      platform: 'linux',
      readFile: linuxProcFor(FIXTURE_PID, { '/proc/sys/kernel/random/boot_id': undefined }),
    });
    expect(start).toEqual({
      startedAtMs: FIXTURE_BTIME_SECONDS * 1000 + FIXTURE_START_TICKS * 10,
      clock: 'boot-derived',
      startTicks: FIXTURE_START_TICKS,
    });
    expect(processStartToken(start)).toBeUndefined();
  });

  test('a pid without a /proc entry has no reading', () => {
    expect(
      readProcessStart(FIXTURE_PID + 1, {
        platform: 'linux',
        readFile: linuxProcFor(FIXTURE_PID),
      }),
    ).toBeNull();
  });

  test('a truncated stat line has no reading', () => {
    expect(
      readProcessStart(FIXTURE_PID, {
        platform: 'linux',
        readFile: linuxProcFor(FIXTURE_PID, {
          [`/proc/${FIXTURE_PID}/stat`]: `${FIXTURE_PID} (w) x (y) z) S 1 ${FIXTURE_PID}\n`,
        }),
      }),
    ).toBeNull();
  });

  test('a /proc/stat without btime has no reading', () => {
    expect(
      readProcessStart(FIXTURE_PID, {
        platform: 'linux',
        readFile: linuxProcFor(FIXTURE_PID, { '/proc/stat': 'cpu  10 0 10 1000\nctxt 123\n' }),
      }),
    ).toBeNull();
  });

  test.each([0, -1, 1.5, Number.NaN, 0x1_0000_0000])(
    'pid %s is not a process id and has no reading',
    (pid) => {
      const readFile = (path: string) =>
        path.endsWith('/stat') && path !== '/proc/stat'
          ? FIXTURE_STAT_WITH_AWKWARD_COMM
          : linuxProcFor(FIXTURE_PID)(path);
      expect(readProcessStart(pid, { platform: 'linux', readFile })).toBeNull();
    },
  );
});

describe('the registered native process-start reader', () => {
  const unregisters: Array<() => void> = [];

  afterEach(() => {
    for (const unregister of unregisters.splice(0)) unregister();
  });

  function register(read: (pid: number) => number | null): void {
    unregisters.push(registerNativeProcessStartReader(read));
  }

  test('is the Windows reading for the pid it is asked about', () => {
    const askedPids: number[] = [];
    register((pid) => {
      askedPids.push(pid);
      return 1_700_000_000_123;
    });
    expect(readProcessStart(FIXTURE_PID, { platform: 'win32' })).toEqual({
      startedAtMs: 1_700_000_000_123,
      clock: 'creation',
    });
    expect(askedPids).toEqual([FIXTURE_PID]);
  });

  test('is not consulted on Linux or on an unsupported platform', () => {
    const askedPids: number[] = [];
    register((pid) => {
      askedPids.push(pid);
      return 1_700_000_000_123;
    });
    expect(
      readProcessStart(FIXTURE_PID, { platform: 'linux', readFile: linuxProcFor(FIXTURE_PID) }),
    ).toMatchObject({ clock: 'boot-derived', startTicks: FIXTURE_START_TICKS });
    expect(readProcessStart(FIXTURE_PID, { platform: 'aix' })).toBeNull();
    expect(askedPids).toEqual([]);
  });

  test('leaves Windows without a reading once unregistered', () => {
    const unregister = registerNativeProcessStartReader(() => 1_700_000_000_123);
    expect(readProcessStart(FIXTURE_PID, { platform: 'win32' })).not.toBeNull();
    unregister();
    expect(readProcessStart(FIXTURE_PID, { platform: 'win32' })).toBeNull();
  });

  test('a reader that cannot identify the process leaves Windows without a reading', () => {
    register(() => null);
    expect(readProcessStart(FIXTURE_PID, { platform: 'win32' })).toBeNull();
  });

  test('gives way to a reader passed for the read', () => {
    register(() => 1_700_000_000_123);
    expect(
      readProcessStart(FIXTURE_PID, { platform: 'win32', readNative: () => 1_700_000_000_456 }),
    ).toEqual({ startedAtMs: 1_700_000_000_456, clock: 'creation' });
  });

  test('warns once while Windows has no reader to ask', () => {
    registerNativeProcessStartReader(() => null)();
    const warn = vi.spyOn(getLogger('process-identity'), 'warn');
    try {
      expect(readProcessStart(FIXTURE_PID, { platform: 'win32' })).toBeNull();
      expect(readProcessStart(FIXTURE_PID + 1, { platform: 'win32' })).toBeNull();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(
        { event: 'process-start-reader-missing' },
        expect.any(String),
      );
    } finally {
      warn.mockRestore();
    }
  });

  test('warns again when a withdrawn reader leaves Windows without one', () => {
    registerNativeProcessStartReader(() => null)();
    const warn = vi.spyOn(getLogger('process-identity'), 'warn');
    try {
      expect(readProcessStart(FIXTURE_PID, { platform: 'win32' })).toBeNull();
      const unregister = registerNativeProcessStartReader(() => 1_700_000_000_123);
      expect(readProcessStart(FIXTURE_PID, { platform: 'win32' })).not.toBeNull();
      unregister();
      expect(readProcessStart(FIXTURE_PID, { platform: 'win32' })).toBeNull();
      expect(warn).toHaveBeenCalledTimes(2);
    } finally {
      warn.mockRestore();
    }
  });
});

describe('readPsProcessStart', () => {
  test('queries ps in the C locale at UTC and parses lstart as UTC', () => {
    const calls: Array<{
      command: string;
      args: string[];
      options: ExecFileSyncOptionsWithStringEncoding;
    }> = [];
    const startedAtMs = readPsProcessStart(FIXTURE_PID, {
      env: { PATH: '/usr/bin', LC_ALL: 'de_DE.UTF-8', TZ: 'Europe/Berlin' },
      run: (command, args, options) => {
        calls.push({ command, args, options });
        return 'Tue Oct 13 17:27:40 2026\n';
      },
    });
    expect(startedAtMs).toBe(Date.UTC(2026, 9, 13, 17, 27, 40));
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      command: 'ps',
      args: ['-p', String(FIXTURE_PID), '-o', 'lstart='],
      options: {
        encoding: 'utf8',
        timeout: 5000,
        windowsHide: true,
        env: { PATH: '/usr/bin', LC_ALL: 'C', TZ: 'UTC0' },
      },
    });
  });

  test.each([
    '  PID TTY\n',
    '',
    'permission denied',
    'Tue Sep  8 20:21:34 2026\nTue Sep  8 20:21:34 2026',
  ])('output %j that is not one lstart date has no reading', (output) => {
    expect(readPsProcessStart(FIXTURE_PID, { run: () => output })).toBeNull();
  });

  test('a ps that cannot run or times out has no reading', () => {
    expect(
      readPsProcessStart(FIXTURE_PID, {
        run: () => {
          throw Object.assign(new Error('spawnSync ps ETIMEDOUT'), { code: 'ETIMEDOUT' });
        },
      }),
    ).toBeNull();
  });

  test('a ps that exits unsuccessfully has no reading', () => {
    expect(
      readPsProcessStart(FIXTURE_PID, {
        run: (_command, _args, options) =>
          execFileSync(process.execPath, ['-e', 'process.exit(1)'], options),
      }),
    ).toBeNull();
  });

  test.each([0, -1, Number.NaN, 12.5, 0x1_0000_0000])(
    'an invalid pid %j has no reading and runs nothing',
    (pid) => {
      const commands: string[] = [];
      expect(
        readPsProcessStart(pid, {
          run: (command) => {
            commands.push(command);
            return 'Tue Oct 13 17:27:40 2026\n';
          },
        }),
      ).toBeNull();
      expect(commands).toEqual([]);
    },
  );
});

const SECOND_TRUNCATION_PLUS_ONE_TICK_MS = 1_010;

describe.skipIf(process.platform === 'win32')('readProcessStart on this host', () => {
  const owned: OwnedProcess[] = [];

  afterEach(async () => {
    for (const holder of owned.splice(0)) await stopOwnedProcess(holder);
  });

  async function startHolder(): Promise<OwnedProcess> {
    const holder = await startOwnedProcess();
    owned.push(holder);
    return holder;
  }

  test('reads this process the way the operating system records it', () => {
    expect(readProcessStart(process.pid)).toEqual(readProcessStartFromOs(process.pid));
  });

  test('reads a child inside the window in which it was spawned', async () => {
    const holder = await startHolder();
    const start = readProcessStart(holder.pid);
    expect(start).toEqual(readProcessStartFromOs(holder.pid));
    expect(start?.startedAtMs).toBeGreaterThanOrEqual(
      holder.spawnRequestedAtMs - SECOND_TRUNCATION_PLUS_ONE_TICK_MS,
    );
    expect(start?.startedAtMs).toBeLessThanOrEqual(holder.readyAtMs);
  });

  test('classifies a child holding a lock written before it started as replaced', async () => {
    const holder = await startHolder();
    expect(
      classifyLockHolder({
        pid: holder.pid,
        startedAt: lockWrittenBeforeProcessStarted(holder),
        machineId: getMachineId(),
      }),
    ).toBe('replaced');
  });

  test('classifies a child holding the lock it wrote as the writer', async () => {
    const holder = await startHolder();
    expect(
      classifyLockHolder({
        pid: holder.pid,
        startedAt: lockWrittenByRunningProcess(holder),
        machineId: getMachineId(),
      }),
    ).toBe('writer');
  });

  test('classifies a child as the writer when its recorded start matches, whatever startedAt says', async () => {
    const holder = await startHolder();
    const recorded = processStartTokenFromOs(holder.pid);
    expect(
      classifyLockHolder({
        pid: holder.pid,
        startedAt: lockWrittenBeforeProcessStarted(holder),
        machineId: getMachineId(),
        processStart: recorded,
      }),
    ).toBe('writer');
  });
});
