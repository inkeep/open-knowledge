import {
  chmodSync,
  closeSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { SPAWN_ATTEMPT_MARKER, SPAWN_ERROR_LOG_MAX_BYTES } from '../constants/lifecycle.ts';
import { openSpawnErrorLog } from './spawn-error-log-open.ts';

const scratchDirs: string[] = [];

function scratchPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ok-spawn-log-'));
  scratchDirs.push(dir);
  return join(dir, 'last-spawn-error.log');
}

afterEach(() => {
  while (scratchDirs.length > 0) {
    const dir = scratchDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function attempt(path: string, childOutput: string, pid = 4242): void {
  const fd = openSpawnErrorLog(path, pid);
  try {
    if (childOutput) writeSync(fd, childOutput);
  } finally {
    closeSync(fd);
  }
}

describe('openSpawnErrorLog', () => {
  test('creates the log when absent, with the header and the output', () => {
    const path = scratchPath();
    attempt(path, 'boom\n');
    const contents = readFileSync(path, 'utf-8');
    expect(contents).toContain(SPAWN_ATTEMPT_MARKER);
    expect(contents).toContain('boom');
  });

  test('a second attempt appends rather than erasing the first', () => {
    const path = scratchPath();
    attempt(path, 'first failure\n', 11);
    attempt(path, 'second failure\n', 12);
    const contents = readFileSync(path, 'utf-8');
    expect(contents).toContain('first failure');
    expect(contents).toContain('second failure');
    expect(contents.match(new RegExp(SPAWN_ATTEMPT_MARKER, 'g'))).toHaveLength(2);
  });

  test('every attempt stamps a header, so the boundary always exists', () => {
    const path = scratchPath();
    attempt(path, '', 11);
    expect(readFileSync(path, 'utf-8')).toContain('pid=11');
  });

  test('starts over once the file has reached the cap', () => {
    const path = scratchPath();
    writeFileSync(path, 'x'.repeat(SPAWN_ERROR_LOG_MAX_BYTES));
    attempt(path, 'after the reset\n');
    const contents = readFileSync(path, 'utf-8');
    expect(contents).toContain('after the reset');
    expect(contents.length).toBeLessThan(SPAWN_ERROR_LOG_MAX_BYTES);
  });

  test('tightens an existing world-readable log to 0600', () => {
    const path = scratchPath();
    writeFileSync(path, 'from an older release\n');
    chmodSync(path, 0o644);
    expect(statSync(path).mode & 0o777).toBe(0o644);
    attempt(path, 'next\n');
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  test('creates a new log at 0600', () => {
    const path = scratchPath();
    attempt(path, 'boom\n');
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });
});
