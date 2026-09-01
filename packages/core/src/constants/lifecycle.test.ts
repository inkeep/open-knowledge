import { describe, expect, test } from 'vitest';
import {
  formatSpawnAttemptHeader,
  SPAWN_ATTEMPT_MARKER,
  SPAWN_ERROR_LOG_MAX_BYTES,
  sliceLastSpawnAttempt,
  spawnErrorLogOpenMode,
} from './lifecycle.ts';

describe('spawnErrorLogOpenMode', () => {
  test('appends to an existing sink rather than truncating it', () => {
    expect(spawnErrorLogOpenMode(0)).toBe('a');
    expect(spawnErrorLogOpenMode(1)).toBe('a');
    expect(spawnErrorLogOpenMode(SPAWN_ERROR_LOG_MAX_BYTES - 1)).toBe('a');
  });

  test('starts over once the sink reaches the cap', () => {
    expect(spawnErrorLogOpenMode(SPAWN_ERROR_LOG_MAX_BYTES)).toBe('w');
    expect(spawnErrorLogOpenMode(SPAWN_ERROR_LOG_MAX_BYTES + 1)).toBe('w');
  });

  test('appends when the size is unknown, rather than truncating', () => {
    expect(spawnErrorLogOpenMode(undefined)).toBe('a');
  });

  test('the cap is the documented 256 KiB, not just some threshold', () => {
    expect(SPAWN_ERROR_LOG_MAX_BYTES).toBe(256 * 1024);
  });
});

describe('formatSpawnAttemptHeader', () => {
  test('carries the attempt time and the spawning pid', () => {
    const header = formatSpawnAttemptHeader(new Date('2026-08-25T18:49:24.449Z'), 4242);
    expect(header).toContain('2026-08-25T18:49:24.449Z');
    expect(header).toContain('pid=4242');
  });

  test('opens on its own line so appended output stays separable', () => {
    const header = formatSpawnAttemptHeader(new Date('2026-08-25T18:49:24.449Z'), 1);
    expect(header.startsWith('\n')).toBe(true);
    expect(header.endsWith('\n')).toBe(true);
  });

  test('the header it writes is the boundary the slicer finds', () => {
    const first = `${formatSpawnAttemptHeader(new Date('2026-08-25T10:00:00.000Z'), 1)}first boom\n`;
    const second = `${formatSpawnAttemptHeader(new Date('2026-08-25T11:00:00.000Z'), 2)}second boom\n`;
    const sliced = sliceLastSpawnAttempt(first + second);
    expect(sliced).toContain('second boom');
    expect(sliced).not.toContain('first boom');
    expect(sliced).not.toContain(SPAWN_ATTEMPT_MARKER);
  });
});

describe('sliceLastSpawnAttempt', () => {
  test('a silent attempt inherits no output from the attempt before it', () => {
    const noisy = `${formatSpawnAttemptHeader(new Date('2026-08-25T10:00:00.000Z'), 1)}EADDRINUSE\n`;
    const silent = formatSpawnAttemptHeader(new Date('2026-08-25T11:00:00.000Z'), 2);
    expect(sliceLastSpawnAttempt(noisy + silent)).not.toContain('EADDRINUSE');
  });

  test('a silent attempt is empty, not a bare header', () => {
    const silent = formatSpawnAttemptHeader(new Date('2026-08-25T11:00:00.000Z'), 2);
    expect(sliceLastSpawnAttempt(silent)).toBe('');
  });

  test('a header with no terminating newline yields nothing', () => {
    expect(sliceLastSpawnAttempt(`\n${SPAWN_ATTEMPT_MARKER}2026-08-25T11:00`)).toBe('');
  });

  test('returns an unmarked file whole', () => {
    expect(sliceLastSpawnAttempt('legacy stack trace\n')).toBe('legacy stack trace\n');
    expect(sliceLastSpawnAttempt('')).toBe('');
  });
});
