/**
 * Tests for the real filesystem executability probe backing slidev resolution.
 *
 * `resolveSlidev` itself is covered behaviorally through `handleSlidesStatus`
 * (see ipc/slides.test.ts) with injected probes. Here we pin the ONE real-fs
 * adapter — `realIsExecutableFile` — against a tmpdir, exercising the catch with
 * genuine ENOENT/EACCES inputs rather than a forced throw.
 */

import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { realIsExecutableFile } from './slidev-resolve.ts';

describe('realIsExecutableFile', () => {
  let dir: string;
  beforeEach(() => {
    dir = resolve(tmpdir(), `slidev-exec-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dir, { recursive: true });
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns true for an executable regular file', async () => {
    const bin = join(dir, 'slidev');
    writeFileSync(bin, '#!/bin/sh\necho hi\n');
    chmodSync(bin, 0o755);
    expect(await realIsExecutableFile(bin)).toBe(true);
  });

  it('returns false for a path that does not exist', async () => {
    expect(await realIsExecutableFile(join(dir, 'does-not-exist'))).toBe(false);
  });

  it('returns false for a directory', async () => {
    expect(await realIsExecutableFile(dir)).toBe(false);
  });

  it('reflects the execute bit on POSIX', async () => {
    const f = join(dir, 'data.txt');
    writeFileSync(f, 'not a program');
    chmodSync(f, 0o644);
    if (process.platform === 'win32') {
      // Windows has no execute bit; a present regular file is runnable there.
      expect(await realIsExecutableFile(f)).toBe(true);
    } else {
      expect(await realIsExecutableFile(f)).toBe(false);
    }
  });
});
