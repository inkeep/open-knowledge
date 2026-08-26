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
  // One of these fixtures is the size cap, so leaving them behind costs real
  // disk per run, not just clutter.
  while (scratchDirs.length > 0) {
    const dir = scratchDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

/** Run one attempt end to end: open through the real sequence, write, close. */
function attempt(path: string, childOutput: string, pid = 4242): void {
  const fd = openSpawnErrorLog(path, pid);
  try {
    if (childOutput) writeSync(fd, childOutput);
  } finally {
    closeSync(fd);
  }
}

// This module IS the fix — the predicates are separately unit-tested, but the
// sequence they compose is what every spawn actually runs, and it is reachable
// from a test only because it was extracted here.
describe('openSpawnErrorLog', () => {
  test('creates the log when absent, with the header and the output', () => {
    const path = scratchPath();
    attempt(path, 'boom\n');
    const contents = readFileSync(path, 'utf-8');
    expect(contents).toContain(SPAWN_ATTEMPT_MARKER);
    expect(contents).toContain('boom');
  });

  // The defect the whole change exists to remove: a retry seconds later used
  // to truncate the output that explained the failure it was retrying.
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

  // `open(2)` honours its mode argument only on creation, so a log an older
  // release created at the default 0644 would keep those permissions forever.
  // A child's stderr carries absolute paths, and this sits beside a 0600 lock.
  test('tightens an existing world-readable log to 0600', () => {
    const path = scratchPath();
    writeFileSync(path, 'from an older release\n');
    // Explicit chmod, not the `writeFileSync` mode, which umask can mask.
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
