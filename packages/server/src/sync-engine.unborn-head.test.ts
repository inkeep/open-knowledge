import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LOCAL_DIR, type SyncMode } from '@inkeep/open-knowledge-core';
import simpleGit from 'simple-git';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { getLogger } from './logger.ts';
import { SyncEngine } from './sync-engine.ts';

const stubContentFilter = {
  isExcluded: (_path: string) => false,
  isDirExcluded: (_path: string) => false,
};

interface CapturedLog {
  data: Record<string, unknown>;
  msg: string;
  level: 'info' | 'warn' | 'error';
}

function captureSyncLogs(): { entries: CapturedLog[]; restore: () => void } {
  const entries: CapturedLog[] = [];
  const logger = getLogger('sync-engine');
  const record =
    (level: CapturedLog['level']) =>
    (data: unknown, msg?: string): void => {
      entries.push({ data: (data ?? {}) as Record<string, unknown>, msg: msg ?? '', level });
    };
  const infoSpy = vi.spyOn(logger, 'info').mockImplementation(record('info') as never);
  const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(record('warn') as never);
  const errorSpy = vi.spyOn(logger, 'error').mockImplementation(record('error') as never);
  return {
    entries,
    restore: () => {
      infoSpy.mockRestore();
      warnSpy.mockRestore();
      errorSpy.mockRestore();
    },
  };
}

let tmpDir = '';
let projectDir = '';
let okDir = '';

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'sync-engine-unborn-head-'));
  projectDir = join(tmpDir, 'project');
  okDir = join(projectDir, '.ok', LOCAL_DIR);
  mkdirSync(projectDir, { recursive: true });
  mkdirSync(okDir, { recursive: true });
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

function statePath(): string {
  return join(okDir, 'sync-state.json');
}

async function emptyProject() {
  const git = simpleGit(projectDir);
  await git.init(['--initial-branch=main']);
  await git.raw('config', 'user.name', 'Test');
  await git.raw('config', 'user.email', 'test@test.com');
  return git;
}

async function emptyProjectWithBareOrigin() {
  const bare = join(tmpDir, 'bare.git');
  mkdirSync(bare, { recursive: true });
  await simpleGit(bare).init(true);
  await simpleGit(bare).raw('symbolic-ref', 'HEAD', 'refs/heads/main');

  const git = await emptyProject();
  await git.addRemote('origin', bare);
  return { git, bare };
}

function makeEngine(opts: { mode?: SyncMode } = {}) {
  return new SyncEngine({
    projectDir,
    contentDir: projectDir,
    contentFilter: stubContentFilter,
    mode: opts.mode ?? 'off',
    pullIntervalSeconds: 99999,
    pushIntervalSeconds: 99999,
  });
}

describe('SyncEngine push refusal on an unborn HEAD', () => {
  test('a push with a remote and no commits names the missing first commit', async () => {
    await emptyProjectWithBareOrigin();

    const logs = captureSyncLogs();
    const engine = makeEngine();
    try {
      await engine.start();
      await engine.pushOnce();

      const status = engine.getStatus();
      expect(status.pausedReason).toBe('no-commits-yet');
      expect(status.state).toBe('disabled');

      const refusals = logs.entries.filter(
        (e) => e.level === 'error' && e.data.event === 'unborn-head-refusal',
      );
      expect(refusals).toHaveLength(1);
      expect(refusals[0].data).toMatchObject({ branch: 'main' });
      expect(refusals[0].msg).toContain('no commits yet');
    } finally {
      logs.restore();
      await engine.destroy();
    }
  });

  test('the notice clears once a first commit exists', async () => {
    const { git } = await emptyProjectWithBareOrigin();

    const engine = makeEngine();
    try {
      await engine.start();
      await engine.pushOnce();
      expect(engine.getStatus().pausedReason).toBe('no-commits-yet');

      writeFileSync(join(projectDir, 'doc.md'), 'v1\n', 'utf-8');
      await git.add('doc.md');
      await git.commit('first');
      await engine.pushOnce();

      expect(engine.getStatus().pausedReason).toBeUndefined();
      expect(engine.getStatus().pushError).toBeUndefined();
    } finally {
      await engine.destroy();
    }
  });

  test('a full auto-sync push with no commits names the condition instead of going silent', async () => {
    await emptyProjectWithBareOrigin();

    const logs = captureSyncLogs();
    const engine = makeEngine({ mode: 'full' });
    try {
      await engine.start();
      expect(engine.getStatus().state).not.toBe('disabled');
      await engine.pushOnce();

      const status = engine.getStatus();
      expect(status.pausedReason).toBe('no-commits-yet');
      expect(status.state).not.toBe('disabled');

      const refusals = logs.entries.filter(
        (e) => e.level === 'error' && e.data.event === 'unborn-head-refusal',
      );
      expect(refusals).toHaveLength(1);
      expect(refusals[0]?.data).toMatchObject({ branch: 'main' });
    } finally {
      logs.restore();
      await engine.destroy();
    }
  });

  test('a repeating full-mode push cycle logs the refusal once per condition, not per tick', async () => {
    await emptyProjectWithBareOrigin();

    const logs = captureSyncLogs();
    const engine = makeEngine({ mode: 'full' });
    try {
      await engine.start();
      await engine.pushOnce();
      await engine.pushOnce();
      await engine.pushOnce();

      expect(engine.getStatus().pausedReason).toBe('no-commits-yet');
      expect(logs.entries.filter((e) => e.data.event === 'unborn-head-refusal')).toHaveLength(1);
    } finally {
      logs.restore();
      await engine.destroy();
    }
  });

  test('a full-mode project with no remote is not paused on the missing first commit', async () => {
    await emptyProject();

    const logs = captureSyncLogs();
    const engine = makeEngine({ mode: 'full' });
    try {
      await engine.start();
      await engine.pushOnce();

      expect(engine.getStatus().pausedReason).toBeUndefined();
      expect(logs.entries.filter((e) => e.data.event === 'unborn-head-refusal')).toHaveLength(0);
    } finally {
      logs.restore();
      await engine.destroy();
    }
  });

  test('a project with no remote is left alone', async () => {
    await emptyProject();

    const engine = makeEngine();
    try {
      await engine.start();
      await engine.pushOnce();
      expect(engine.getStatus().pausedReason).toBeUndefined();
    } finally {
      await engine.destroy();
    }
  });

  test('the notice is neither written to the state file nor restored from it', async () => {
    await emptyProjectWithBareOrigin();

    const engine = makeEngine();
    try {
      await engine.start();
      await engine.pushOnce();
      expect(engine.getStatus().pausedReason).toBe('no-commits-yet');

      const internal = engine as unknown as { saveStateNow: () => void };
      internal.saveStateNow();
      expect(JSON.parse(readFileSync(statePath(), 'utf-8')).pausedReason).toBeUndefined();
    } finally {
      await engine.destroy();
    }

    writeFileSync(
      statePath(),
      JSON.stringify({
        version: 1,
        lastSyncUtc: null,
        lastFetchUtc: null,
        lastPushedSha: null,
        pausedReason: 'no-commits-yet',
      }),
      'utf-8',
    );

    const restarted = makeEngine();
    try {
      await restarted.start();
      expect(restarted.getStatus().pausedReason).toBeUndefined();
    } finally {
      await restarted.destroy();
    }
  });
});
