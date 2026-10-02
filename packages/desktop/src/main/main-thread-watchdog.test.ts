import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Worker } from 'node:worker_threads';
import { afterEach, describe, expect, test } from 'vitest';
import {
  boundStallFrames,
  classifyPreviousLiveness,
  classifyPreviousStall,
  computeWatchdogTick,
  createMainThreadWatchdog,
  livenessLogFields,
  type MainThreadWatchdog,
  type MainThreadWatchdogHandle,
  type PreviousSessionLiveness,
  parseStallSnapshot,
  parseWatchdogRecord,
  STALL_SNAPSHOT_MAX_CHARS,
  STALL_SNAPSHOT_MAX_FRAMES,
  STALL_THRESHOLD_TICKS,
  type StallSnapshot,
  stallLogFields,
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

function stallSnapshot(
  outcome: StallSnapshot['outcome'] = 'captured',
  overrides: Record<string, unknown> = {},
): StallSnapshot {
  const request = {
    schemaVersion: 1 as const,
    bootId: 'boot-1',
    stallStartedAt: '2026-07-09T23:59:40.000Z',
    requestedAt: '2026-07-09T23:59:55.000Z',
    blockedForMsAtRequest: 15_000,
  };
  const byOutcome: Record<StallSnapshot['outcome'], StallSnapshot> = {
    pending: { ...request, outcome: 'pending' },
    captured: {
      ...request,
      outcome: 'captured',
      capturedAt: '2026-07-09T23:59:55.030Z',
      pauseLatencyMs: 27,
      frames: [
        {
          functionName: 'rebuildIndex',
          url: 'file:///app/out/main/index.js',
          line: 812,
          column: 5,
        },
      ],
      framesTruncated: false,
    },
    failed: { ...request, outcome: 'failed', error: 'ERR_INSPECTOR_NOT_AVAILABLE: no inspector' },
  };
  return { ...byOutcome[outcome], ...overrides } as StallSnapshot;
}

function blockMainThreadFor(ms: number): void {
  const end = Date.now() + ms;
  while (Date.now() < end) {}
}

async function pollFor<T>(read: () => T | null, timeoutMs = 10_000): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = read();
    if (value !== null) return value;
    await delay(20);
  }
  return read();
}

function capturedStall(watchdog: MainThreadWatchdog, after = ''): StallSnapshot | null {
  const read = watchdog.readPreviousStall();
  if (read.kind !== 'record' || read.value.outcome !== 'captured') return null;
  return read.value.stallStartedAt > after ? read.value : null;
}

function witnessedPings(watchdog: MainThreadWatchdog): WatchdogRecord | null {
  const read = watchdog.readPrevious();
  return read.kind === 'record' && read.record.mainTicksObserved >= 1 ? read.record : null;
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

describe('boundStallFrames', () => {
  function cdpFrame(functionName: string, url: string, lineNumber = 0, columnNumber = 0) {
    return { functionName, url, location: { scriptId: '7', lineNumber, columnNumber } };
  }

  test('keeps names and script locations with one-based lines and columns', () => {
    const bounded = boundStallFrames(
      [cdpFrame('rebuildIndex', 'file:///app/out/main/index.js', 811, 4)],
      new Map(),
      STALL_SNAPSHOT_MAX_FRAMES,
      STALL_SNAPSHOT_MAX_CHARS,
    );

    expect(bounded).toStrictEqual({
      frames: [
        {
          functionName: 'rebuildIndex',
          url: 'file:///app/out/main/index.js',
          line: 812,
          column: 5,
        },
      ],
      framesTruncated: false,
    });
  });

  test('a deep stack keeps its innermost frames and says it was cut', () => {
    const deep = Array.from({ length: STALL_SNAPSHOT_MAX_FRAMES + 5 }, (_, i) =>
      cdpFrame(`frame${i}`, 'file:///app/x.js'),
    );

    const bounded = boundStallFrames(deep, new Map(), STALL_SNAPSHOT_MAX_FRAMES, 256);

    expect(bounded.frames).toHaveLength(STALL_SNAPSHOT_MAX_FRAMES);
    expect(bounded.frames[0]?.functionName).toBe('frame0');
    expect(bounded.framesTruncated).toBe(true);
  });

  test('a stack exactly at the cap is not marked as cut', () => {
    const full = Array.from({ length: STALL_SNAPSHOT_MAX_FRAMES }, () => cdpFrame('f', 'u'));

    expect(boundStallFrames(full, new Map(), STALL_SNAPSHOT_MAX_FRAMES, 256).framesTruncated).toBe(
      false,
    );
  });

  test('a frame without a url borrows the one its script was parsed with', () => {
    const bounded = boundStallFrames(
      [cdpFrame('anonymous', '')],
      new Map([['7', 'node:internal/timers']]),
      STALL_SNAPSHOT_MAX_FRAMES,
      256,
    );

    expect(bounded.frames[0]?.url).toBe('node:internal/timers');
  });

  test('long strings are clipped to the cap, keeping the end of a url', () => {
    const url = `file:///${'a'.repeat(400)}/index.js`;

    const bounded = boundStallFrames(
      [cdpFrame('f'.repeat(400), url)],
      new Map(),
      STALL_SNAPSHOT_MAX_FRAMES,
      64,
    );

    expect(bounded.frames[0]?.functionName).toHaveLength(64);
    expect(bounded.frames[0]?.url).toHaveLength(64);
    expect(bounded.frames[0]?.url.endsWith('/index.js')).toBe(true);
  });

  test('malformed frames degrade to empty fields instead of throwing', () => {
    const bounded = boundStallFrames([null, 7, { location: null }], new Map(), 24, 256);

    expect(bounded.frames).toStrictEqual([
      { functionName: '', url: '', line: 0, column: 0 },
      { functionName: '', url: '', line: 0, column: 0 },
      { functionName: '', url: '', line: 0, column: 0 },
    ]);
    expect(boundStallFrames('not frames', new Map(), 24, 256)).toStrictEqual({
      frames: [],
      framesTruncated: false,
    });
  });
});

describe('parseStallSnapshot', () => {
  test('every outcome round-trips', () => {
    for (const outcome of ['pending', 'captured', 'failed'] as const) {
      const written = stallSnapshot(outcome);

      expect(parseStallSnapshot(`${JSON.stringify(written)}\n`)).toStrictEqual(written);
    }
  });

  test('every truncation of a snapshot reads as unparseable without throwing', () => {
    const raw = JSON.stringify(stallSnapshot('captured'));

    for (let end = 0; end < raw.length; end += 1) {
      expect(parseStallSnapshot(raw.slice(0, end)), `truncated at ${end}`).toBeNull();
    }
  });

  test('a snapshot missing the request it answers is rejected', () => {
    for (const field of [
      'schemaVersion',
      'bootId',
      'stallStartedAt',
      'requestedAt',
      'blockedForMsAtRequest',
      'outcome',
    ]) {
      expect(
        parseStallSnapshot(JSON.stringify({ ...stallSnapshot('pending'), [field]: undefined })),
        field,
      ).toBeNull();
    }
    expect(
      parseStallSnapshot(JSON.stringify(stallSnapshot('pending', { outcome: 'paused' }))),
    ).toBeNull();
    expect(
      parseStallSnapshot(JSON.stringify(stallSnapshot('pending', { stallStartedAt: 'soon' }))),
    ).toBeNull();
    expect(
      parseStallSnapshot(JSON.stringify(stallSnapshot('pending', { blockedForMsAtRequest: -1 }))),
    ).toBeNull();
    expect(
      parseStallSnapshot(JSON.stringify(stallSnapshot('pending', { schemaVersion: 2 }))),
    ).toBeNull();
  });

  test('a captured snapshot must carry bounded frames and its pause latency', () => {
    for (const field of ['capturedAt', 'pauseLatencyMs', 'frames', 'framesTruncated']) {
      expect(
        parseStallSnapshot(JSON.stringify({ ...stallSnapshot('captured'), [field]: undefined })),
        field,
      ).toBeNull();
    }
    const tooMany = Array.from({ length: STALL_SNAPSHOT_MAX_FRAMES + 1 }, () => ({
      functionName: 'f',
      url: 'u',
      line: 1,
      column: 1,
    }));
    expect(
      parseStallSnapshot(JSON.stringify(stallSnapshot('captured', { frames: tooMany }))),
    ).toBeNull();
    const longUrl = 'u'.repeat(STALL_SNAPSHOT_MAX_CHARS + 1);
    expect(
      parseStallSnapshot(
        JSON.stringify(
          stallSnapshot('captured', {
            frames: [{ functionName: 'f', url: longUrl, line: 1, column: 1 }],
          }),
        ),
      ),
    ).toBeNull();
    expect(
      parseStallSnapshot(
        JSON.stringify(
          stallSnapshot('captured', {
            frames: [{ functionName: 'f', url: 'u', line: 1.5, column: 1 }],
          }),
        ),
      ),
    ).toBeNull();
    expect(
      parseStallSnapshot(JSON.stringify(stallSnapshot('captured', { pauseLatencyMs: -3 }))),
    ).toBeNull();
  });

  test('a failed snapshot must say why', () => {
    expect(parseStallSnapshot(JSON.stringify(stallSnapshot('failed', { error: '' })))).toBeNull();
    expect(parseStallSnapshot(JSON.stringify(stallSnapshot('failed', { error: 3 })))).toBeNull();
  });

  test('a JSON value that is not an object is rejected', () => {
    expect(parseStallSnapshot('null')).toBeNull();
    expect(parseStallSnapshot('[]')).toBeNull();
  });
});

describe('classifyPreviousStall', () => {
  const tickMs = 5_000;
  const witnessAt = '2026-07-10T00:00:00.000Z';

  function blockedFor(blockedForMs: number): PreviousSessionLiveness {
    return {
      kind: 'blocked',
      blockedForMs,
      stallThresholdMs: tickMs * STALL_THRESHOLD_TICKS,
      writtenAt: witnessAt,
    };
  }

  function stallStartingAt(offsetFromWitnessMs: number): StallSnapshot {
    return stallSnapshot('captured', {
      stallStartedAt: new Date(Date.parse(witnessAt) + offsetFromWitnessMs).toISOString(),
    });
  }

  test('a snapshot of the stall the witness saw last is the final episode', () => {
    const snapshot = stallStartingAt(-36_000);

    expect(
      classifyPreviousStall({ kind: 'record', value: snapshot }, 'boot-1', blockedFor(36_000)),
    ).toStrictEqual({ kind: 'matched', snapshot, episode: 'final' });
  });

  test('the final episode tolerates one tick of clock drift and no more', () => {
    const liveness = blockedFor(36_000);

    expect(
      classifyPreviousStall(
        { kind: 'record', value: stallStartingAt(-36_000 + tickMs) },
        'boot-1',
        liveness,
      ),
    ).toMatchObject({ episode: 'final' });
    expect(
      classifyPreviousStall(
        { kind: 'record', value: stallStartingAt(-36_000 - tickMs - 1) },
        'boot-1',
        liveness,
      ),
    ).toMatchObject({ episode: 'earlier' });
  });

  test('a snapshot of a stall that started before the final one is an earlier episode', () => {
    expect(
      classifyPreviousStall(
        { kind: 'record', value: stallStartingAt(-600_000) },
        'boot-1',
        blockedFor(36_000),
      ),
    ).toMatchObject({ kind: 'matched', episode: 'earlier' });
  });

  test('a session the witness did not see blocked at the end only had earlier stalls', () => {
    const snapshot = stallStartingAt(-36_000);

    expect(
      classifyPreviousStall({ kind: 'record', value: snapshot }, 'boot-1', {
        kind: 'died',
        blockedForMs: 6_000,
        stallThresholdMs: 15_000,
        writtenAt: witnessAt,
      }),
    ).toMatchObject({ episode: 'earlier' });
    expect(
      classifyPreviousStall({ kind: 'record', value: snapshot }, 'boot-1', {
        kind: 'no-evidence',
        why: 'absent',
      }),
    ).toMatchObject({ episode: 'earlier' });
  });

  test('a missing, torn, orphaned or foreign snapshot is no evidence', () => {
    const liveness = blockedFor(36_000);
    const snapshot = stallStartingAt(-36_000);

    expect(classifyPreviousStall({ kind: 'absent' }, 'boot-1', liveness)).toStrictEqual({
      kind: 'no-evidence',
      why: 'absent',
    });
    expect(classifyPreviousStall({ kind: 'unreadable' }, 'boot-1', liveness)).toStrictEqual({
      kind: 'no-evidence',
      why: 'unreadable',
    });
    expect(
      classifyPreviousStall({ kind: 'record', value: snapshot }, null, liveness),
    ).toStrictEqual({ kind: 'no-evidence', why: 'no-previous-boot' });
    expect(
      classifyPreviousStall({ kind: 'record', value: snapshot }, 'boot-2', liveness),
    ).toStrictEqual({ kind: 'no-evidence', why: 'boot-mismatch' });
  });
});

describe('stallLogFields', () => {
  test('a captured snapshot logs its frames, latency and episode', () => {
    const snapshot = stallSnapshot('captured');

    expect(stallLogFields({ kind: 'matched', snapshot, episode: 'final' })).toStrictEqual({
      mainThreadStall: {
        outcome: 'captured',
        episode: 'final',
        stallStartedAt: snapshot.stallStartedAt,
        requestedAt: snapshot.requestedAt,
        blockedForMsAtRequest: 15_000,
        capturedAt: '2026-07-09T23:59:55.030Z',
        pauseLatencyMs: 27,
        frames: [
          {
            functionName: 'rebuildIndex',
            url: 'file:///app/out/main/index.js',
            line: 812,
            column: 5,
          },
        ],
        framesTruncated: false,
        error: null,
      },
      mainThreadStallEvidence: 'matched',
    });
  });

  test('a pause that never landed logs as pending with its capture fields spelled out as null', () => {
    const fields = stallLogFields({
      kind: 'matched',
      snapshot: stallSnapshot('pending'),
      episode: 'final',
    });

    expect(fields.mainThreadStall).toStrictEqual({
      outcome: 'pending',
      episode: 'final',
      stallStartedAt: '2026-07-09T23:59:40.000Z',
      requestedAt: '2026-07-09T23:59:55.000Z',
      blockedForMsAtRequest: 15_000,
      capturedAt: null,
      pauseLatencyMs: null,
      frames: null,
      framesTruncated: null,
      error: null,
    });
  });

  test('a failed capture logs its reason', () => {
    const fields = stallLogFields({
      kind: 'matched',
      snapshot: stallSnapshot('failed'),
      episode: 'earlier',
    });

    expect(fields.mainThreadStall?.error).toBe('ERR_INSPECTOR_NOT_AVAILABLE: no inspector');
    expect(fields.mainThreadStall?.frames).toBeNull();
  });

  test('absent evidence spells its null out rather than omitting the key', () => {
    for (const why of ['absent', 'unreadable', 'no-previous-boot', 'boot-mismatch'] as const) {
      expect(stallLogFields({ kind: 'no-evidence', why })).toStrictEqual({
        mainThreadStall: null,
        mainThreadStallEvidence: why,
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
      stallPath: join(dirname(path), 'stall.json'),
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
      stallPath: join(parentAsFile, 'stall.json'),
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
    const watchdog = createMainThreadWatchdog({
      path: dir,
      stallPath: dir,
      logger: { warn: () => {} },
    });

    expect(watchdog.readPrevious()).toEqual({ kind: 'unreadable' });
    expect(watchdog.readPreviousStall()).toEqual({ kind: 'unreadable' });
  });

  test('a main thread blocked past the threshold leaves a stack naming the blocking function', async () => {
    const dir = makeDir();
    const warnings: Record<string, unknown>[] = [];
    const watchdog = createMainThreadWatchdog({
      path: join(dir, 'watchdog.json'),
      stallPath: join(dir, 'stall.json'),
      logger: {
        warn: (payload) => {
          warnings.push(payload);
        },
      },
      tickMs: 20,
    });
    handles.push(watchdog.start('boot-stall'));
    expect(await pollFor(() => witnessedPings(watchdog))).not.toBeNull();
    expect(watchdog.readPreviousStall()).toEqual({ kind: 'absent' });

    blockMainThreadFor(1_500);
    const first = await pollFor(() => capturedStall(watchdog));

    if (first?.outcome !== 'captured') throw new Error('no captured stall snapshot');
    expect(first.bootId).toBe('boot-stall');
    expect(first.frames[0]?.functionName).toBe('blockMainThreadFor');
    expect(first.frames[0]?.url).toContain('main-thread-watchdog.test');
    expect(first.frames[0]?.line).toBeGreaterThan(0);
    expect(first.blockedForMsAtRequest).toBeGreaterThanOrEqual(20 * STALL_THRESHOLD_TICKS);
    expect(first.pauseLatencyMs).toBeLessThan(1_000);

    await pollFor(() => {
      const read = watchdog.readPrevious();
      return read.kind === 'record' && read.record.blockedForMs < 20 ? read : null;
    });
    blockMainThreadFor(1_500);
    const second = await pollFor(() => capturedStall(watchdog, first.stallStartedAt));
    await delay(100);

    expect(second?.outcome).toBe('captured');
    expect(warnings.map((w) => w.event)).toEqual([
      'main-thread-watchdog.stall-captured',
      'main-thread-watchdog.stall-captured',
    ]);
    expect(warnings[0]?.snapshot).toStrictEqual(first);
  });

  test('a stall snapshot from the worker that does not validate leaves a warning', async () => {
    const dir = makeDir();
    const warnings: Record<string, unknown>[] = [];
    const watchdog = createMainThreadWatchdog({
      path: join(dir, 'watchdog.json'),
      stallPath: join(dir, 'stall.json'),
      logger: {
        warn: (payload) => {
          warnings.push(payload);
        },
      },
      tickMs: 20,
    });
    handles.push(watchdog.start(''));
    await delay(200);

    blockMainThreadFor(1_500);
    const warned = await pollFor(() =>
      warnings.some((w) => w.event === 'main-thread-watchdog.stall-message-invalid') ? true : null,
    );

    expect(warned).toBe(true);
    expect(warnings.map((w) => w.event)).not.toContain('main-thread-watchdog.stall-captured');
    expect(
      warnings.find((w) => w.event === 'main-thread-watchdog.stall-message-invalid'),
    ).toMatchObject({
      payloadType: 'object',
      keys: expect.arrayContaining(['bootId', 'outcome']),
      outcome: 'captured',
    });
  });

  test("a stall that is another debugger's pause is recorded as failed and never resumed", async () => {
    const dir = makeDir();
    const watchdog = createMainThreadWatchdog({
      path: join(dir, 'watchdog.json'),
      stallPath: join(dir, 'stall.json'),
      logger: { warn: () => {} },
      tickMs: 200,
    });
    handles.push(watchdog.start('boot-debugger'));
    expect(await pollFor(() => witnessedPings(watchdog))).not.toBeNull();

    let lastMainTickAt = Date.now();
    let longestMainGapMs = 0;
    const mainTicks = setInterval(() => {
      const now = Date.now();
      longestMainGapMs = Math.max(longestMainGapMs, now - lastMainTickAt);
      lastMainTickAt = now;
    }, 5);
    const developerDebugger = new Worker(
      `
      const { parentPort } = require('node:worker_threads');
      const inspector = require('node:inspector');
      const keepAlive = setInterval(() => {}, 1_000);
      const session = new inspector.Session();
      session.connectToMainThread();
      let held = false;
      session.on('Debugger.paused', () => {
        if (held) return;
        held = true;
        setTimeout(() => {
          parentPort.postMessage('released');
          session.post('Debugger.resume', () => {
            session.post('Debugger.disable', () => {
              session.disconnect();
              clearInterval(keepAlive);
            });
          });
        }, 2_000);
      });
      session.post('Debugger.enable', () => parentPort.postMessage('armed'));
      `,
      { eval: true },
    );
    await new Promise((resolve) => {
      developerDebugger.on('message', (message) => {
        if (message === 'armed') {
          lastMainTickAt = Date.now();
          longestMainGapMs = 0;
          // biome-ignore lint/suspicious/noDebugger: This test deliberately pauses its owned main thread.
          debugger; // oxlint-disable-line no-debugger -- Pause the test-owned main thread.
          return;
        }
        resolve(message);
      });
    });
    longestMainGapMs = Math.max(longestMainGapMs, Date.now() - lastMainTickAt);
    clearInterval(mainTicks);
    await developerDebugger.terminate();
    const read = await pollFor(() => {
      const stall = watchdog.readPreviousStall();
      return stall.kind === 'record' && stall.value.outcome !== 'pending' ? stall.value : null;
    });

    expect(longestMainGapMs, JSON.stringify(read)).toBeGreaterThanOrEqual(1_900);
    expect(read).toMatchObject({
      outcome: 'failed',
      error: 'the main thread was already paused by another debugger session',
    });
  });

  test.skipIf(process.platform === 'win32')(
    'a stall in native code is on disk as pending before the pause lands, which records how late it landed',
    async () => {
      const dir = makeDir();
      const stallPath = join(dir, 'stall.json');
      const watchdog = createMainThreadWatchdog({
        path: join(dir, 'watchdog.json'),
        stallPath,
        logger: { warn: () => {} },
        tickMs: 20,
      });
      handles.push(watchdog.start('boot-native'));
      expect(await pollFor(() => witnessedPings(watchdog))).not.toBeNull();

      const seenWhileBlocked = execFileSync('/bin/sh', ['-c', 'sleep 1; cat "$0"', stallPath], {
        encoding: 'utf8',
      });
      const landed = await pollFor(() => capturedStall(watchdog));

      expect(parseStallSnapshot(seenWhileBlocked)?.outcome).toBe('pending');
      if (landed?.outcome !== 'captured') throw new Error('the pause never landed');
      expect(landed.pauseLatencyMs).toBeGreaterThanOrEqual(500);
    },
  );
});
