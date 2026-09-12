import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, describe, expect, test } from 'vitest';
import {
  classifyPreviousLiveness,
  computeWatchdogTick,
  createMainThreadWatchdog,
  livenessLogFields,
  type MainThreadWatchdogHandle,
  parseWatchdogRecord,
  STALL_THRESHOLD_TICKS,
  stallThresholdMs,
  WATCHDOG_TICK_MS,
  type WatchdogRecord,
  type WatchdogTickState,
} from './main-thread-watchdog.ts';

const tmpDirs: string[] = [];
const handles: MainThreadWatchdogHandle[] = [];

afterEach(() => {
  for (const handle of handles.splice(0)) handle.stop();
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeDir(): string {
  const dir = mkdtempSync(resolve(tmpdir(), 'ok-main-thread-watchdog-'));
  tmpDirs.push(dir);
  return dir;
}

function record(overrides: Partial<WatchdogRecord> = {}): WatchdogRecord {
  return {
    schemaVersion: 1,
    bootId: 'boot-1',
    writtenAt: '2026-07-10T00:00:00.000Z',
    tickMs: WATCHDOG_TICK_MS,
    blockedForMs: 0,
    mainTicksObserved: 12,
    ...overrides,
  };
}

describe('classifyPreviousLiveness', () => {
  test('a witness that kept hearing the main thread says the session died', () => {
    const liveness = classifyPreviousLiveness(
      { kind: 'record', record: record({ blockedForMs: 4_000 }) },
      'boot-1',
      null,
    );

    expect(liveness).toEqual({
      kind: 'died',
      blockedForMs: 4_000,
      stallThresholdMs: 15_000,
      writtenAt: '2026-07-10T00:00:00.000Z',
    });
  });

  test('a witness that outlived a silent main thread says it was blocked', () => {
    const liveness = classifyPreviousLiveness(
      { kind: 'record', record: record({ blockedForMs: 14_320_118 }) },
      'boot-1',
      null,
    );

    expect(liveness).toEqual({
      kind: 'blocked',
      blockedForMs: 14_320_118,
      stallThresholdMs: 15_000,
      writtenAt: '2026-07-10T00:00:00.000Z',
    });
  });

  test('the stall threshold is three ticks and is inclusive', () => {
    expect(stallThresholdMs(record())).toBe(15_000);
    expect(
      classifyPreviousLiveness(
        { kind: 'record', record: record({ blockedForMs: 15_000 }) },
        'boot-1',
        null,
      ).kind,
    ).toBe('blocked');
    expect(
      classifyPreviousLiveness(
        { kind: 'record', record: record({ blockedForMs: 14_999 }) },
        'boot-1',
        null,
      ).kind,
    ).toBe('died');
  });

  test('the threshold tracks the tick cadence the record was written at', () => {
    expect(stallThresholdMs(record({ tickMs: 20 }))).toBe(60);
  });

  test('a missing or torn file is no evidence rather than a verdict', () => {
    expect(classifyPreviousLiveness({ kind: 'absent' }, 'boot-1', null)).toEqual({
      kind: 'no-evidence',
      why: 'absent',
    });
    expect(classifyPreviousLiveness({ kind: 'unreadable' }, 'boot-1', null)).toEqual({
      kind: 'no-evidence',
      why: 'unreadable',
    });
  });

  test('a record from another session is no evidence about this one', () => {
    expect(
      classifyPreviousLiveness(
        { kind: 'record', record: record({ blockedForMs: 60_000 }) },
        'boot-2',
        null,
      ),
    ).toEqual({ kind: 'no-evidence', why: 'boot-mismatch' });
  });

  test('an unidentifiable previous session cannot claim the record', () => {
    expect(
      classifyPreviousLiveness(
        { kind: 'record', record: record({ blockedForMs: 60_000 }) },
        null,
        null,
      ),
    ).toEqual({ kind: 'no-evidence', why: 'no-previous-boot' });
  });

  test('a record that never heard the main thread cannot vouch for a death', () => {
    expect(
      classifyPreviousLiveness(
        { kind: 'record', record: record({ blockedForMs: 4_000, mainTicksObserved: 0 }) },
        'boot-1',
        null,
      ),
    ).toEqual({ kind: 'no-evidence', why: 'unwitnessed-main' });
  });

  test('a record that never heard the main thread can still prove a hang', () => {
    expect(
      classifyPreviousLiveness(
        { kind: 'record', record: record({ blockedForMs: 60_000, mainTicksObserved: 0 }) },
        'boot-1',
        null,
      ),
    ).toEqual({
      kind: 'blocked',
      blockedForMs: 60_000,
      stallThresholdMs: 15_000,
      writtenAt: record().writtenAt,
    });
  });

  test('a witness that stopped writing long before the last heartbeat is not trusted', () => {
    const writtenAt = '2026-07-10T00:00:00.000Z';
    const lastAliveMs = Date.parse(writtenAt) + 20_000;

    expect(
      classifyPreviousLiveness(
        { kind: 'record', record: record({ blockedForMs: 4_000, writtenAt }) },
        'boot-1',
        lastAliveMs,
      ),
    ).toEqual({ kind: 'no-evidence', why: 'stale-witness' });
  });

  test('a heartbeat that only slightly outran the witness still yields a verdict', () => {
    const writtenAt = '2026-07-10T00:00:00.000Z';
    const lastAliveMs = Date.parse(writtenAt) + 3_000;

    expect(
      classifyPreviousLiveness(
        { kind: 'record', record: record({ blockedForMs: 4_000, writtenAt }) },
        'boot-1',
        lastAliveMs,
      ).kind,
    ).toBe('died');
  });
});

describe('computeWatchdogTick', () => {
  function tickState(overrides: Partial<WatchdogTickState> = {}): WatchdogTickState {
    return { lastMainAt: 1_000, lastTickAt: 90, mainTicksObserved: 5, ...overrides };
  }

  test('reports the gap since the last ping when the worker kept its own schedule', () => {
    const state = tickState();

    const rec = computeWatchdogTick(state, 5_000, 100, 20, STALL_THRESHOLD_TICKS, 'boot-x', 'W');

    expect(rec.blockedForMs).toBe(4_000);
    expect(rec.mainTicksObserved).toBe(5);
    expect(rec.bootId).toBe('boot-x');
    expect(rec.tickMs).toBe(20);
    expect(state.lastTickAt).toBe(100);
  });

  test('re-baselines instead of blaming the main thread when the worker itself was descheduled', () => {
    const state = tickState({ lastTickAt: 0 });

    const rec = computeWatchdogTick(
      state,
      2_000,
      30_000_000,
      20,
      STALL_THRESHOLD_TICKS,
      'boot-x',
      'W',
    );

    expect(rec.blockedForMs).toBe(0);
    expect(rec.mainTicksObserved).toBe(0);
    expect(state.lastMainAt).toBe(2_000);
  });
});

describe('parseWatchdogRecord', () => {
  test('a written record round-trips', () => {
    const written = record({ blockedForMs: 7, mainTicksObserved: 3 });

    expect(parseWatchdogRecord(`${JSON.stringify(written)}\n`)).toEqual(written);
  });

  test('every truncation of a record reads as unparseable without throwing', () => {
    const raw = JSON.stringify(record());

    for (let end = 0; end < raw.length; end += 1) {
      expect(parseWatchdogRecord(raw.slice(0, end)), `truncated at ${end}`).toBeNull();
    }
  });

  test('a record from an unknown schema version is rejected', () => {
    expect(parseWatchdogRecord(JSON.stringify({ ...record(), schemaVersion: 2 }))).toBeNull();
  });

  test('a record without a usable bootId is rejected', () => {
    expect(parseWatchdogRecord(JSON.stringify({ ...record(), bootId: undefined }))).toBeNull();
    expect(parseWatchdogRecord(JSON.stringify({ ...record(), bootId: '' }))).toBeNull();
    expect(parseWatchdogRecord(JSON.stringify({ ...record(), bootId: 7 }))).toBeNull();
  });

  test('a record whose timestamp is not a date is rejected', () => {
    expect(
      parseWatchdogRecord(JSON.stringify({ ...record(), writtenAt: 'not-a-date' })),
    ).toBeNull();
  });

  test('non-finite and negative durations are rejected', () => {
    expect(
      parseWatchdogRecord(
        '{"schemaVersion":1,"bootId":"b","writtenAt":"2026-07-10T00:00:00.000Z","tickMs":1e999,"blockedForMs":0,"mainTicksObserved":0}',
      ),
    ).toBeNull();
    expect(parseWatchdogRecord(JSON.stringify({ ...record(), blockedForMs: -1 }))).toBeNull();
    expect(
      parseWatchdogRecord(JSON.stringify({ ...record(), mainTicksObserved: null })),
    ).toBeNull();
  });

  test('a non-positive tick cadence is rejected so a stall threshold of zero cannot invert the verdict', () => {
    expect(parseWatchdogRecord(JSON.stringify({ ...record(), tickMs: 0 }))).toBeNull();
    expect(parseWatchdogRecord(JSON.stringify({ ...record(), tickMs: -5 }))).toBeNull();
  });

  test('a JSON value that is not an object is rejected', () => {
    expect(parseWatchdogRecord('null')).toBeNull();
    expect(parseWatchdogRecord('[]')).toBeNull();
  });
});

describe('livenessLogFields', () => {
  test('a verdict names the witness that carried it', () => {
    expect(
      livenessLogFields({
        kind: 'blocked',
        blockedForMs: 90_000,
        stallThresholdMs: 15_000,
        writtenAt: 'W',
      }),
    ).toStrictEqual({
      livenessVerdict: 'blocked',
      mainThreadBlockedForMs: 90_000,
      mainThreadStallThresholdMs: 15_000,
      livenessWitnessAt: 'W',
      livenessEvidence: 'matched',
    });
    expect(
      livenessLogFields({
        kind: 'died',
        blockedForMs: 12,
        stallThresholdMs: 15_000,
        writtenAt: 'W',
      }),
    ).toStrictEqual({
      livenessVerdict: 'died',
      mainThreadBlockedForMs: 12,
      mainThreadStallThresholdMs: 15_000,
      livenessWitnessAt: 'W',
      livenessEvidence: 'matched',
    });
  });

  test('absent evidence spells its nulls out rather than omitting the keys', () => {
    for (const why of [
      'absent',
      'unreadable',
      'no-previous-boot',
      'boot-mismatch',
      'stale-witness',
      'unwitnessed-main',
    ] as const) {
      const fields = livenessLogFields({ kind: 'no-evidence', why });

      expect(Object.keys(fields).sort()).toEqual([
        'livenessEvidence',
        'livenessVerdict',
        'livenessWitnessAt',
        'mainThreadBlockedForMs',
        'mainThreadStallThresholdMs',
      ]);
      expect(fields).toStrictEqual({
        livenessVerdict: null,
        mainThreadBlockedForMs: null,
        mainThreadStallThresholdMs: null,
        livenessWitnessAt: null,
        livenessEvidence: why,
      });
    }
  });
});

describe('the worker witness', () => {
  test('it records the running session and the pings it heard from main', async () => {
    const path = join(makeDir(), 'nested', 'watchdog.json');
    const warnings: Record<string, unknown>[] = [];
    const watchdog = createMainThreadWatchdog({
      path,
      logger: {
        warn: (payload) => {
          warnings.push(payload);
        },
      },
      tickMs: 20,
    });

    expect(watchdog.readPrevious()).toEqual({ kind: 'absent' });

    const handle = watchdog.start('boot-x');
    handles.push(handle);

    let written: WatchdogRecord | null = null;
    const deadline = Date.now() + 10_000;
    while (written === null && Date.now() < deadline) {
      await delay(20);
      const observed = watchdog.readPrevious();
      written = observed.kind === 'record' ? observed.record : null;
      if (written !== null && written.mainTicksObserved < 1) written = null;
    }

    expect(written).not.toBeNull();
    expect(written?.bootId).toBe('boot-x');
    expect(written?.tickMs).toBe(20);
    expect(written?.mainTicksObserved).toBeGreaterThanOrEqual(1);
    expect(written?.blockedForMs).toBeLessThan(1_000);
    expect(Number.isFinite(Date.parse(written?.writtenAt ?? ''))).toBe(true);

    handle.stop();
    handle.stop();

    await delay(200);

    expect(warnings).toEqual([]);
  });

  test('a witness file it cannot write warns once and keeps trying', async () => {
    const parentAsFile = join(makeDir(), 'not-a-directory');
    writeFileSync(parentAsFile, '');
    const warnings: Record<string, unknown>[] = [];
    const watchdog = createMainThreadWatchdog({
      path: join(parentAsFile, 'watchdog.json'),
      logger: {
        warn: (payload) => {
          warnings.push(payload);
        },
      },
      tickMs: 20,
    });

    const handle = watchdog.start('boot-y');
    handles.push(handle);
    await delay(400);
    handle.stop();

    expect(warnings.map((w) => w.event)).toEqual(['main-thread-watchdog.write-failed']);
  });

  test('an unreadable file reads as unreadable rather than absent', () => {
    const dir = makeDir();
    const watchdog = createMainThreadWatchdog({ path: dir, logger: { warn: () => {} } });

    expect(watchdog.readPrevious()).toEqual({ kind: 'unreadable' });
  });
});
