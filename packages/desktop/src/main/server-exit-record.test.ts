/**
 * Server-exit recorder tests: tmpdir-backed lockDir, an injected advancing
 * clock, and a capturing logger — the same injectable-deps posture as the
 * sibling crash-detection tests. Covers the two arrival orders of the exit
 * `code` and the process-gone `reason`, the correlation window that joins
 * them, and the fail-soft write path.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SERVER_EXIT_LOG } from '@inkeep/open-knowledge-core';
import { createServerExitRecorder, type ServerExitRecord } from './server-exit-record.ts';

const tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeLockDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ok-exit-'));
  tmpDirs.push(dir);
  return dir;
}

/** Clock the recorder reads through `now()`; advance with `tick(ms)`. */
function makeClock(startMs = 1_000_000) {
  let ms = startMs;
  return {
    now: () => new Date(ms),
    tick: (delta: number) => {
      ms += delta;
    },
  };
}

function makeLogger() {
  const warnings: Array<{ payload: Record<string, unknown>; msg: string }> = [];
  return {
    warnings,
    logger: {
      warn: (payload: Record<string, unknown>, msg: string) => warnings.push({ payload, msg }),
    },
  };
}

function readRecord(lockDir: string): ServerExitRecord {
  return JSON.parse(readFileSync(join(lockDir, SERVER_EXIT_LOG), 'utf8')) as ServerExitRecord;
}

describe('createServerExitRecorder', () => {
  test('recordExit writes code, pid, and ISO timestamp with a null reason when none seen', () => {
    const lockDir = makeLockDir();
    const clock = makeClock();
    const recorder = createServerExitRecorder({ now: clock.now, logger: makeLogger().logger });

    recorder.recordExit({ lockDir, pid: 51502, code: 0 });

    const record = readRecord(lockDir);
    expect(record.pid).toBe(51502);
    expect(record.code).toBe(0);
    expect(record.reason).toBeNull();
    expect(new Date(record.at).toISOString()).toBe(record.at);
  });

  test('a null code (signal kill) is preserved', () => {
    const lockDir = makeLockDir();
    const clock = makeClock();
    const recorder = createServerExitRecorder({ now: clock.now, logger: makeLogger().logger });

    recorder.recordExit({ lockDir, pid: 999, code: null });

    expect(readRecord(lockDir).code).toBeNull();
  });

  test('noteGoneReason before recordExit attaches the reason', () => {
    const lockDir = makeLockDir();
    const clock = makeClock();
    const recorder = createServerExitRecorder({ now: clock.now, logger: makeLogger().logger });

    recorder.noteGoneReason('oom');
    clock.tick(50);
    recorder.recordExit({ lockDir, pid: 1, code: null });

    expect(readRecord(lockDir).reason).toBe('oom');
  });

  test('recordExit before noteGoneReason patches the file within the window', () => {
    const lockDir = makeLockDir();
    const clock = makeClock();
    const recorder = createServerExitRecorder({ now: clock.now, logger: makeLogger().logger });

    recorder.recordExit({ lockDir, pid: 1, code: 1 });
    expect(readRecord(lockDir).reason).toBeNull();

    clock.tick(100);
    recorder.noteGoneReason('killed');

    const record = readRecord(lockDir);
    expect(record.reason).toBe('killed');
    // The patch preserves the originally-observed exit fields.
    expect(record.code).toBe(1);
    expect(record.pid).toBe(1);
  });

  test('a reason older than the correlation window is not attached to a later exit', () => {
    const lockDir = makeLockDir();
    const clock = makeClock();
    const recorder = createServerExitRecorder({ now: clock.now, logger: makeLogger().logger });

    recorder.noteGoneReason('killed');
    clock.tick(3_001);
    recorder.recordExit({ lockDir, pid: 1, code: null });

    expect(readRecord(lockDir).reason).toBeNull();
  });

  test('a reason arriving after the window does not patch an earlier exit', () => {
    const lockDir = makeLockDir();
    const clock = makeClock();
    const recorder = createServerExitRecorder({ now: clock.now, logger: makeLogger().logger });

    recorder.recordExit({ lockDir, pid: 1, code: 0 });
    clock.tick(3_001);
    recorder.noteGoneReason('clean-exit');

    expect(readRecord(lockDir).reason).toBeNull();
  });

  test('each exit overwrites the previous record (latest death wins)', () => {
    const lockDir = makeLockDir();
    const clock = makeClock();
    const recorder = createServerExitRecorder({ now: clock.now, logger: makeLogger().logger });

    recorder.recordExit({ lockDir, pid: 1, code: 0 });
    clock.tick(60_000);
    recorder.recordExit({ lockDir, pid: 2, code: 1 });

    const record = readRecord(lockDir);
    expect(record.pid).toBe(2);
    expect(record.code).toBe(1);
  });

  test('an unwritable lockDir warns instead of throwing', () => {
    const parent = makeLockDir();
    // Put a regular file where the recorder expects a directory, so the
    // recursive mkdir fails with ENOTDIR.
    const filePath = join(parent, 'not-a-dir');
    writeFileSync(filePath, 'x');
    const badLockDir = join(filePath, 'nested');
    const clock = makeClock();
    const { warnings, logger } = makeLogger();
    const recorder = createServerExitRecorder({ now: clock.now, logger });

    expect(() => recorder.recordExit({ lockDir: badLockDir, pid: 1, code: 1 })).not.toThrow();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.payload.event).toBe('server-exit-record.write-failed');
  });
});
