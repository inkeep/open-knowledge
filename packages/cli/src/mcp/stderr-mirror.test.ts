import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  closeSync,
  existsSync,
  ftruncateSync,
  mkdirSync,
  openSync,
  readFileSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMcpStderrMirror, pruneMirrorLogs } from './stderr-mirror.ts';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ok-mcp-mirror-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function fixedClock(iso: string): () => Date {
  return () => new Date(iso);
}

describe('createMcpStderrMirror', () => {
  test('appends chunks to a date-named file with an ISO timestamp prefix', () => {
    const mirror = createMcpStderrMirror({
      logsDir: dir,
      now: fixedClock('2026-07-18T10:00:00.000Z'),
      pruneDelayMs: 0,
    });
    mirror.write('[mcp] global stdio server ready\n');
    mirror.write('[mcp] stdin EOF\n');
    const content = readFileSync(join(dir, 'mcp.2026-07-18.log'), 'utf-8');
    expect(content).toBe(
      '2026-07-18T10:00:00.000Z [mcp] global stdio server ready\n' +
        '2026-07-18T10:00:00.000Z [mcp] stdin EOF\n',
    );
  });

  test('creates the logs dir on first write when absent', () => {
    const nested = join(dir, 'not', 'yet', 'there');
    const mirror = createMcpStderrMirror({
      logsDir: nested,
      now: fixedClock('2026-07-18T10:00:00.000Z'),
      pruneDelayMs: 0,
    });
    mirror.write('[mcp] hello\n');
    expect(existsSync(join(nested, 'mcp.2026-07-18.log'))).toBe(true);
  });

  test('rolls to a new file when the date changes mid-session', () => {
    let iso = '2026-07-18T23:59:59.000Z';
    const mirror = createMcpStderrMirror({
      logsDir: dir,
      now: () => new Date(iso),
      pruneDelayMs: 0,
    });
    mirror.write('[mcp] day one\n');
    iso = '2026-07-19T00:00:01.000Z';
    mirror.write('[mcp] day two\n');
    expect(readFileSync(join(dir, 'mcp.2026-07-18.log'), 'utf-8')).toContain('day one');
    expect(readFileSync(join(dir, 'mcp.2026-07-19.log'), 'utf-8')).toContain('day two');
  });

  test('recovers after the logs dir is removed mid-session instead of self-disabling', async () => {
    const nested = join(dir, 'logs');
    const mirror = createMcpStderrMirror({
      logsDir: nested,
      now: fixedClock('2026-07-18T10:00:00.000Z'),
      pruneDelayMs: 0,
    });
    mirror.write('[mcp] before\n');
    expect(existsSync(join(nested, 'mcp.2026-07-18.log'))).toBe(true);

    // Something external (tmpwatch, user cleanup) removes the dir mid-session.
    await rm(nested, { recursive: true, force: true });

    // The write that raced the removal is lost, but the mirror re-ensures the
    // dir on the next attempt rather than counting down to a permanent disable.
    mirror.write('[mcp] lost\n');
    mirror.write('[mcp] recovered\n');
    const content = readFileSync(join(nested, 'mcp.2026-07-18.log'), 'utf-8');
    expect(content).toContain('recovered');
  });

  test('write failures are swallowed and disable the mirror after repeated failures', () => {
    // A regular file where the logs dir should be makes every write fail.
    const blocked = join(dir, 'blocked');
    writeFileSync(blocked, 'file, not dir');
    const mirror = createMcpStderrMirror({
      logsDir: join(blocked, 'logs'),
      pruneDelayMs: 0,
    });
    for (let i = 0; i < 20; i++) {
      expect(() => mirror.write('[mcp] doomed\n')).not.toThrow();
    }
  });
});

describe('pruneMirrorLogs', () => {
  const DAY_MS = 24 * 60 * 60 * 1000;

  function touch(name: string, ageMs: number, now: Date, bytes = 10): void {
    const path = join(dir, name);
    const fd = openSync(path, 'w');
    // Sparse file: statSync reports the logical size without eating disk.
    ftruncateSync(fd, bytes);
    closeSync(fd);
    const mtime = new Date(now.getTime() - ageMs);
    utimesSync(path, mtime, mtime);
  }

  test('deletes mirror files older than the retention window, keeps recent ones', () => {
    const now = new Date('2026-07-18T10:00:00.000Z');
    touch('mcp.2026-07-01.log', 17 * DAY_MS, now);
    touch('mcp.2026-07-17.log', 1 * DAY_MS, now);
    pruneMirrorLogs(dir, () => now);
    expect(existsSync(join(dir, 'mcp.2026-07-01.log'))).toBe(false);
    expect(existsSync(join(dir, 'mcp.2026-07-17.log'))).toBe(true);
  });

  test('never touches non-mirror files in the shared logs dir', () => {
    const now = new Date('2026-07-18T10:00:00.000Z');
    touch('desktop.2026-06-01.log', 40 * DAY_MS, now);
    touch('other.log', 40 * DAY_MS, now);
    touch('mcp.2026-06-01.log', 40 * DAY_MS, now);
    pruneMirrorLogs(dir, () => now);
    expect(existsSync(join(dir, 'desktop.2026-06-01.log'))).toBe(true);
    expect(existsSync(join(dir, 'other.log'))).toBe(true);
    expect(existsSync(join(dir, 'mcp.2026-06-01.log'))).toBe(false);
  });

  test('deletes oldest-first until the aggregate size fits the cap', () => {
    const now = new Date('2026-07-18T10:00:00.000Z');
    const twentyMb = 20 * 1024 * 1024;
    touch('mcp.2026-07-15.log', 3 * DAY_MS, now, twentyMb);
    touch('mcp.2026-07-16.log', 2 * DAY_MS, now, twentyMb);
    touch('mcp.2026-07-17.log', 1 * DAY_MS, now, twentyMb);
    pruneMirrorLogs(dir, () => now);
    // 60 MB total against the 45 MB cap: only the oldest goes.
    expect(existsSync(join(dir, 'mcp.2026-07-15.log'))).toBe(false);
    expect(existsSync(join(dir, 'mcp.2026-07-16.log'))).toBe(true);
    expect(existsSync(join(dir, 'mcp.2026-07-17.log'))).toBe(true);
  });

  test('a missing dir is a no-op', () => {
    expect(() => pruneMirrorLogs(join(dir, 'nope'))).not.toThrow();
  });

  test('startup sweep runs inline when pruneDelayMs is 0', () => {
    const now = new Date('2026-07-18T10:00:00.000Z');
    touch('mcp.2026-07-01.log', 17 * DAY_MS, now);
    mkdirSync(dir, { recursive: true });
    createMcpStderrMirror({ logsDir: dir, now: () => now, pruneDelayMs: 0 });
    expect(existsSync(join(dir, 'mcp.2026-07-01.log'))).toBe(false);
  });
});
