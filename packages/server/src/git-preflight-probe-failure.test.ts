import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, existsSync: () => false };
});

const { detectGit, GitNotAvailableError } = await import('./git-preflight.ts');

describe('detectGit probe failure detail', () => {
  let originalPath: string | undefined;
  let binDir: string;

  beforeEach(() => {
    originalPath = process.env.PATH;
    binDir = mkdtempSync(join(tmpdir(), 'ok-git-probe-'));
  });

  afterEach(() => {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    rmSync(binDir, { recursive: true, force: true });
  });

  test('records enoent when no git is on PATH and no fallback exists', () => {
    process.env.PATH = join(binDir, 'empty');
    let thrown: unknown;
    try {
      detectGit();
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(GitNotAvailableError);
    expect((thrown as InstanceType<typeof GitNotAvailableError>).probe).toEqual({
      path: 'enoent',
      fallback: null,
    });
  });

  test('records unparseable when the git on PATH prints no version', (ctx) => {
    ctx.skip(process.platform === 'win32', 'the stub git is a POSIX shell script');
    const stub = join(binDir, 'git');
    writeFileSync(stub, '#!/bin/sh\necho "not a version"\n');
    chmodSync(stub, 0o755);
    process.env.PATH = binDir;
    let thrown: unknown;
    try {
      detectGit();
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(GitNotAvailableError);
    expect((thrown as InstanceType<typeof GitNotAvailableError>).probe).toEqual({
      path: 'unparseable',
      fallback: null,
    });
  });
});
