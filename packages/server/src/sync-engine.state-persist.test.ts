import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LOCAL_DIR } from '@inkeep/open-knowledge-core';
import simpleGit from 'simple-git';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createTestConflictAuthority } from './conflict-authority.test-helper.ts';
import { SyncEngine } from './sync-engine.ts';

const writeCalls = vi.hoisted(() => [] as string[]);
const renameCalls = vi.hoisted(() => [] as [string, string][]);

vi.mock('./fs-traced.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./fs-traced.ts')>();
  return {
    ...actual,
    tracedWriteFileSync: (
      path: string,
      data: Parameters<typeof actual.tracedWriteFileSync>[1],
      options?: Parameters<typeof actual.tracedWriteFileSync>[2],
    ) => {
      writeCalls.push(path);
      actual.tracedWriteFileSync(path, data, options);
    },
    tracedRenameSync: (from: string, to: string) => {
      renameCalls.push([from, to]);
      actual.tracedRenameSync(from, to);
    },
  };
});

const stubContentFilter = {
  isExcluded: (_path: string) => false,
  isDirExcluded: (_path: string) => false,
};

let tmpDir = '';
let projectDir = '';
let okDir = '';

beforeEach(async () => {
  writeCalls.length = 0;
  renameCalls.length = 0;
  tmpDir = mkdtempSync(join(tmpdir(), 'sync-engine-state-persist-'));
  projectDir = join(tmpDir, 'project');
  okDir = join(projectDir, '.ok', LOCAL_DIR);
  mkdirSync(projectDir, { recursive: true });
  mkdirSync(okDir, { recursive: true });
  const git = simpleGit(projectDir);
  await git.init(['--initial-branch=main']);
  await git.raw('config', 'user.name', 'Test');
  await git.raw('config', 'user.email', 'test@test.com');
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

function statePath(): string {
  return join(okDir, 'sync-state.json');
}

function makeEngine() {
  return new SyncEngine({
    conflicts: createTestConflictAuthority(projectDir),
    projectDir,
    contentDir: projectDir,
    contentFilter: stubContentFilter,
    mode: 'off',
    pullIntervalSeconds: 99999,
    pushIntervalSeconds: 99999,
  });
}

interface StateInternals {
  saveStateNow: () => void;
  scheduleSaveState: () => void;
}

describe('SyncEngine sync-state persistence', () => {
  test('the state file is replaced by a rename, never truncated in place', async () => {
    const engine = makeEngine();
    try {
      await engine.start();
      writeCalls.length = 0;
      renameCalls.length = 0;

      (engine as unknown as StateInternals).saveStateNow();

      expect(writeCalls).toHaveLength(1);
      expect(writeCalls[0]).not.toBe(statePath());
      expect(renameCalls).toEqual([[writeCalls[0], statePath()]]);
      expect(existsSync(writeCalls[0] as string)).toBe(false);
      expect(JSON.parse(readFileSync(statePath(), 'utf-8')).version).toBe(1);
    } finally {
      await engine.destroy();
    }
  });

  test('an immediate save cancels the armed debounce instead of writing twice', async () => {
    const engine = makeEngine();
    try {
      await engine.start();
      const internal = engine as unknown as StateInternals;
      vi.useFakeTimers();
      internal.scheduleSaveState();
      writeCalls.length = 0;

      internal.saveStateNow();
      expect(writeCalls).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(10_000);
      expect(writeCalls).toHaveLength(1);
    } finally {
      vi.useRealTimers();
      await engine.destroy();
    }
  });
});
