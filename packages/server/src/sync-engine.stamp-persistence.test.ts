import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LOCAL_DIR, type SyncMode } from '@inkeep/open-knowledge-core';
import simpleGit from 'simple-git';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createTestConflictAuthority } from './conflict-authority.test-helper.ts';
import { getLogger } from './logger.ts';
import { SyncEngine } from './sync-engine.ts';

const stubContentFilter = {
  isExcluded: (_path: string) => false,
  isDirExcluded: (_path: string) => false,
};

interface CapturedLog {
  data: Record<string, unknown>;
  msg: string;
}

function captureSyncWarnings(): { entries: CapturedLog[]; restore: () => void } {
  const entries: CapturedLog[] = [];
  const logger = getLogger('sync-engine');
  const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(((
    data: unknown,
    msg?: string,
  ): void => {
    entries.push({ data: (data ?? {}) as Record<string, unknown>, msg: msg ?? '' });
  }) as never);
  return { entries, restore: () => warnSpy.mockRestore() };
}

let tmpDir = '';
let projectDir = '';
let okDir = '';

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'sync-engine-stamps-'));
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

async function projectWithBareOrigin() {
  const bare = join(tmpDir, 'bare.git');
  mkdirSync(bare, { recursive: true });
  await simpleGit(bare).init(true);
  await simpleGit(bare).raw('symbolic-ref', 'HEAD', 'refs/heads/main');

  const git = simpleGit(projectDir);
  await git.init(['--initial-branch=main']);
  await git.raw('config', 'user.name', 'Test');
  await git.raw('config', 'user.email', 'test@test.com');
  writeFileSync(join(projectDir, 'doc.md'), 'v1\n', 'utf-8');
  await git.add('.');
  await git.commit('seed');
  await git.addRemote('origin', bare);
  await git.push(['--set-upstream', 'origin', 'main']);
  return { git, bare };
}

function makeEngine(opts: { mode?: SyncMode } = {}) {
  return new SyncEngine({
    conflicts: createTestConflictAuthority(projectDir),
    projectDir,
    contentDir: projectDir,
    contentFilter: stubContentFilter,
    mode: opts.mode ?? 'off',
    pullIntervalSeconds: 99999,
    pushIntervalSeconds: 99999,
  });
}

describe('SyncEngine sync stamp persistence', () => {
  test('push and pull stamps survive a restart that happens inside the save debounce', async () => {
    await projectWithBareOrigin();

    const engineA = makeEngine();
    let engineB: SyncEngine | null = null;
    try {
      await engineA.start();
      writeFileSync(join(projectDir, 'doc.md'), 'v2\n', 'utf-8');
      await engineA.pushOnce();
      await engineA.pullOnce();

      const before = engineA.getStatus();
      expect(before.lastPushOkUtc).toBeTruthy();
      expect(before.lastPullOkUtc).toBeTruthy();

      engineB = makeEngine();
      await engineB.start();

      const after = engineB.getStatus();
      expect(after.lastPushOkUtc).toBe(before.lastPushOkUtc);
      expect(after.lastPullOkUtc).toBe(before.lastPullOkUtc);
    } finally {
      if (engineB) await engineB.destroy();
      await engineA.destroy();
    }
  });

  test('the persisted file keeps version 1 without duplicating conflict state', async () => {
    await projectWithBareOrigin();

    const engine = makeEngine();
    try {
      await engine.start();
      writeFileSync(join(projectDir, 'doc.md'), 'v2\n', 'utf-8');
      await engine.pushOnce();

      const persisted = JSON.parse(readFileSync(statePath(), 'utf-8')) as Record<string, unknown>;
      expect(persisted.version).toBe(1);
      expect(persisted.lastPushOkUtc).toBe(engine.getStatus().lastPushOkUtc);
      expect(persisted).toHaveProperty('lastFetchUtc');
      expect(persisted).toHaveProperty('lastPushedSha');
      expect(persisted).toHaveProperty('consecutiveFailures');
      expect(persisted).not.toHaveProperty('inflightConflicts');
    } finally {
      await engine.destroy();
    }
  });

  test('a stamp write that cannot reach disk warns and leaves the push cycle intact', async () => {
    const { bare } = await projectWithBareOrigin();
    mkdirSync(statePath(), { recursive: true });

    const logs = captureSyncWarnings();
    const engine = makeEngine();
    try {
      await engine.start();
      writeFileSync(join(projectDir, 'doc.md'), 'v2\n', 'utf-8');
      await engine.pushOnce();

      expect(engine.getStatus().pushError).toBeUndefined();
      expect(engine.getStatus().lastPushOkUtc).toBeTruthy();
      expect((await simpleGit(bare).raw(['log', '-1', '--format=%s', 'main'])).trim()).toContain(
        'doc.md',
      );
      expect(logs.entries.some((e) => e.msg === '[sync] failed to persist sync state')).toBe(true);
    } finally {
      logs.restore();
      await engine.destroy();
    }
  });
});
