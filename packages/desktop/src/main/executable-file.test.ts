import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isExecutableFileSync } from './executable-file.ts';

describe('isExecutableFileSync', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'executable-file-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('accepts a regular file with the execute bit', () => {
    const bin = join(dir, 'setpriv');
    writeFileSync(bin, '#!/bin/sh\n');
    chmodSync(bin, 0o755);
    expect(isExecutableFileSync(bin, 'linux')).toBe(true);
  });

  it('rejects a regular file without the execute bit where the host enforces it', () => {
    const bin = join(dir, 'setpriv');
    writeFileSync(bin, '#!/bin/sh\n');
    chmodSync(bin, 0o644);
    expect(isExecutableFileSync(bin, 'linux')).toBe(process.platform === 'win32');
  });

  it('rejects a directory even though access(X_OK) passes on it', () => {
    const sub = join(dir, 'setpriv');
    mkdirSync(sub, { mode: 0o755 });
    expect(isExecutableFileSync(sub, 'linux')).toBe(false);
  });

  it('rejects a path that does not exist', () => {
    expect(isExecutableFileSync(join(dir, 'missing'), 'linux')).toBe(false);
  });

  it('treats any regular file as executable on Windows', () => {
    const file = join(dir, 'tool.cmd');
    writeFileSync(file, '@echo off\n');
    chmodSync(file, 0o644);
    expect(isExecutableFileSync(file, 'win32')).toBe(true);
  });
});
