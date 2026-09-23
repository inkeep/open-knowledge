import { realpathSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { isSelfRemoval, registerRemoval, removalTracker } from './file-watcher.ts';

vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>();
  return { ...fs, realpathSync: vi.fn(fs.realpathSync) };
});

const mockedRealpathSync = vi.mocked(realpathSync);

let removalDir: string;

beforeEach(async () => {
  removalTracker.clear();
  removalDir = await mkdtemp(resolve(tmpdir(), 'ok-removal-syscall-'));
  mockedRealpathSync.mockClear();
});

afterEach(async () => {
  removalTracker.clear();
  await rm(removalDir, { recursive: true, force: true });
});

describe('isSelfRemoval path resolution', () => {
  test('resolves no path when nothing is declared, and one once a declaration is live', () => {
    expect(isSelfRemoval(resolve(removalDir, 'undeclared.md'))).toBe(false);
    expect(mockedRealpathSync).not.toHaveBeenCalled();

    registerRemoval(resolve(removalDir, 'declared.md'));
    mockedRealpathSync.mockClear();

    expect(isSelfRemoval(resolve(removalDir, 'undeclared.md'))).toBe(false);
    expect(mockedRealpathSync).toHaveBeenCalledTimes(1);
  });
});
