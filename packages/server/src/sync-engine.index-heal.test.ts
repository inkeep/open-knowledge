import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
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
  tmpDir = mkdtempSync(join(tmpdir(), 'sync-engine-index-heal-'));
  projectDir = join(tmpDir, 'project');
  okDir = join(projectDir, '.ok', LOCAL_DIR);
  mkdirSync(projectDir, { recursive: true });
  mkdirSync(okDir, { recursive: true });
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

function ignoreOkDir(): void {
  appendFileSync(join(projectDir, '.git', 'info', 'exclude'), '\n.ok/\n', 'utf-8');
}

function lockPath(): string {
  return join(projectDir, '.git', 'index.lock');
}

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
  ignoreOkDir();
  await git.raw('config', 'user.name', 'Test');
  await git.raw('config', 'user.email', 'test@test.com');
  writeFileSync(join(projectDir, 'doc.md'), 'v1\n', 'utf-8');
  await git.add('.');
  await git.commit('seed');
  await git.addRemote('origin', bare);
  await git.push(['--set-upstream', 'origin', 'main']);
  return { git, bare };
}

function makeEngine(
  opts: { mode?: SyncMode; _beforeRealIndexResetRetry?: () => void | Promise<void> } = {},
) {
  return new SyncEngine({
    conflicts: createTestConflictAuthority(projectDir),
    projectDir,
    contentDir: projectDir,
    contentFilter: stubContentFilter,
    mode: opts.mode ?? 'off',
    pullIntervalSeconds: 99999,
    pushIntervalSeconds: 99999,
    _beforeRealIndexResetRetry: opts._beforeRealIndexResetRetry,
  });
}

async function advanceOriginFromSisterClone(bare: string): Promise<void> {
  const sister = join(tmpDir, 'sister');
  await simpleGit().clone(bare, sister);
  const sg = simpleGit(sister);
  await sg.raw('config', 'user.name', 'Sister');
  await sg.raw('config', 'user.email', 'sister@test.com');
  writeFileSync(join(sister, 'doc.md'), 'upstream\n', 'utf-8');
  await sg.add('doc.md');
  await sg.commit('sister edit');
  await sg.push();
}

async function originHeadMessage(bare: string): Promise<string> {
  return (await simpleGit(bare).raw(['log', '-1', '--format=%s', 'main'])).trim();
}

async function healPaths(engine: SyncEngine, paths: string[]): Promise<void> {
  const internal = engine as unknown as {
    healStaleRealIndex: (paths: string[], committed: ReadonlySet<string>) => Promise<void>;
  };
  await internal.healStaleRealIndex(paths, new Set<string>());
}

describe('SyncEngine real-index reset after a landed push', () => {
  test('a reset blocked by a held index lock is logged once with the paths and branch', async () => {
    const { git, bare } = await projectWithBareOrigin();
    writeFileSync(join(projectDir, 'doc.md'), 'v2\n', 'utf-8');
    await git.add('doc.md');

    const logs = captureSyncLogs();
    const engine = makeEngine();
    try {
      await engine.start();
      writeFileSync(lockPath(), '', 'utf-8');
      await engine.pushOnce();

      expect(await originHeadMessage(bare)).toContain('doc.md');
      expect(engine.getStatus().pushError).toBeUndefined();

      const errors = logs.entries.filter(
        (e) => e.level === 'error' && e.data.event === 'stale-index-reset',
      );
      expect(errors).toHaveLength(1);
      expect(errors[0]?.data).toMatchObject({
        outcome: 'failed',
        branch: 'main',
        pathCount: 1,
        paths: ['doc.md'],
      });
      expect(errors[0]?.msg).toContain('[sync] stale-index reset failed');
      expect(logs.entries.filter((e) => e.data.event === 'stale-index-reset')).toHaveLength(1);
    } finally {
      rmSync(lockPath(), { force: true });
      logs.restore();
      await engine.destroy();
    }
  });

  test('a lock released between attempts lets the retry clear the index without a second error', async () => {
    const { git, bare } = await projectWithBareOrigin();
    writeFileSync(join(projectDir, 'doc.md'), 'v2\n', 'utf-8');
    await git.add('doc.md');

    const logs = captureSyncLogs();
    const engine = makeEngine({
      _beforeRealIndexResetRetry: () => {
        rmSync(lockPath(), { force: true });
      },
    });
    try {
      await engine.start();
      writeFileSync(lockPath(), '', 'utf-8');
      await engine.pushOnce();

      expect(await originHeadMessage(bare)).toContain('doc.md');
      expect(engine.getStatus().pushError).toBeUndefined();
      expect(existsSync(lockPath())).toBe(false);

      const porcelain = await simpleGit(projectDir).raw(['status', '--porcelain']);
      expect(porcelain.trim()).toBe('');

      expect(
        logs.entries.filter((e) => e.level === 'error' && e.data.event === 'stale-index-reset'),
      ).toHaveLength(0);
      const recovered = logs.entries.filter(
        (e) => e.level === 'warn' && e.data.event === 'stale-index-reset',
      );
      expect(recovered).toHaveLength(1);
      expect(recovered[0]?.data).toMatchObject({
        outcome: 'recovered-on-retry',
        paths: ['doc.md'],
      });
      expect(recovered[0]?.msg).toContain('the panel listing is current');
    } finally {
      rmSync(lockPath(), { force: true });
      logs.restore();
      await engine.destroy();
    }
  });

  test('an unobstructed push clears the real index and logs no reset error', async () => {
    const { git, bare } = await projectWithBareOrigin();
    writeFileSync(join(projectDir, 'doc.md'), 'v2\n', 'utf-8');
    await git.add('doc.md');

    const logs = captureSyncLogs();
    const engine = makeEngine();
    try {
      await engine.start();
      await engine.pushOnce();

      expect(await originHeadMessage(bare)).toContain('doc.md');
      const porcelain = await simpleGit(projectDir).raw(['status', '--porcelain']);
      expect(porcelain.trim()).toBe('');
      expect(logs.entries.filter((e) => e.data.event === 'stale-index-reset')).toHaveLength(0);
    } finally {
      logs.restore();
      await engine.destroy();
    }
  });
});

describe('SyncEngine self-heal across every push-cycle exit', () => {
  test('a path left stale by a blocked reset is cleared by the next push cycle', async () => {
    const { bare } = await projectWithBareOrigin();
    writeFileSync(join(projectDir, 'doc.md'), 'v2\n', 'utf-8');

    const logs = captureSyncLogs();
    const engine = makeEngine();
    try {
      await engine.start();
      writeFileSync(lockPath(), '', 'utf-8');
      await engine.pushOnce();
      rmSync(lockPath(), { force: true });

      expect(await originHeadMessage(bare)).toContain('doc.md');
      expect((await simpleGit(projectDir).raw(['status', '--porcelain'])).trim()).not.toBe('');

      await engine.pushOnce();

      expect((await simpleGit(projectDir).raw(['status', '--porcelain'])).trim()).toBe('');

      const heals = logs.entries.filter(
        (e) => e.level === 'warn' && e.data.event === 'self-heal-applied',
      );
      expect(heals).toHaveLength(1);
      expect(heals[0]?.data).toMatchObject({ branch: 'main', pathCount: 1, paths: ['doc.md'] });
    } finally {
      rmSync(lockPath(), { force: true });
      logs.restore();
      await engine.destroy();
    }
  });
  test('a staged edit whose file was restored to HEAD content is cleared by the push cycle', async () => {
    const { git } = await projectWithBareOrigin();
    writeFileSync(join(projectDir, 'doc.md'), 'v2\n', 'utf-8');
    await git.add('doc.md');
    writeFileSync(join(projectDir, 'doc.md'), 'v1\n', 'utf-8');
    expect((await git.raw(['status', '--porcelain'])).trim()).toBe('MM doc.md');

    const logs = captureSyncLogs();
    const engine = makeEngine();
    try {
      await engine.start();
      await engine.pushOnce();

      expect((await simpleGit(projectDir).raw(['status', '--porcelain'])).trim()).toBe('');
      const heals = logs.entries.filter((e) => e.data.event === 'self-heal-applied');
      expect(heals).toHaveLength(1);
      expect(heals[0]?.data).toMatchObject({ paths: ['doc.md'] });
    } finally {
      logs.restore();
      await engine.destroy();
    }
  });

  test('a Git operation that begins mid-cycle stops the self-heal from resetting promised paths', async () => {
    const { git } = await projectWithBareOrigin();
    writeFileSync(join(projectDir, 'doc.md'), 'v2\n', 'utf-8');
    await git.add('doc.md');
    writeFileSync(join(projectDir, 'doc.md'), 'v1\n', 'utf-8');
    const markerPath = join(projectDir, '.git', 'CHERRY_PICK_HEAD');

    const logs = captureSyncLogs();
    const engine = makeEngine();
    try {
      await engine.start();
      writeFileSync(markerPath, (await git.revparse('HEAD')).trim(), 'utf-8');
      await healPaths(engine, ['doc.md']);

      expect((await git.raw(['status', '--porcelain'])).trim()).toBe('MM doc.md');
      expect(logs.entries.filter((e) => e.data.event === 'self-heal-applied')).toHaveLength(0);
      const skipped = logs.entries.filter(
        (e) => e.level === 'warn' && e.data.event === 'self-heal-skipped-git-operation',
      );
      expect(skipped).toHaveLength(1);
      expect(skipped[0]?.data).toMatchObject({ branch: 'main', pathCount: 1, paths: ['doc.md'] });

      rmSync(markerPath, { force: true });
      await healPaths(engine, ['doc.md']);

      expect((await git.raw(['status', '--porcelain'])).trim()).toBe('');
      expect(logs.entries.filter((e) => e.data.event === 'self-heal-applied')).toHaveLength(1);
    } finally {
      rmSync(markerPath, { force: true });
      logs.restore();
      await engine.destroy();
    }
  });

  test('a push cycle refused for a Git operation never reaches the heal step', async () => {
    const { git } = await projectWithBareOrigin();
    writeFileSync(join(projectDir, 'doc.md'), 'v2\n', 'utf-8');
    await git.add('doc.md');
    writeFileSync(join(projectDir, 'doc.md'), 'v1\n', 'utf-8');
    const markerPath = join(projectDir, '.git', 'CHERRY_PICK_HEAD');

    const logs = captureSyncLogs();
    const engine = makeEngine();
    try {
      await engine.start();
      writeFileSync(markerPath, (await git.revparse('HEAD')).trim(), 'utf-8');
      await engine.pushOnce();

      expect(engine.getStatus().pausedReason).toBe('git-operation-in-progress');
      expect((await git.raw(['status', '--porcelain'])).trim()).toBe('MM doc.md');
      expect(
        logs.entries.filter(
          (e) =>
            e.data.event === 'self-heal-applied' ||
            e.data.event === 'self-heal-skipped-git-operation',
        ),
      ).toHaveLength(0);

      rmSync(markerPath, { force: true });
      await engine.pushOnce();

      expect((await git.raw(['status', '--porcelain'])).trim()).toBe('');
      expect(logs.entries.filter((e) => e.data.event === 'self-heal-applied')).toHaveLength(1);
    } finally {
      rmSync(markerPath, { force: true });
      logs.restore();
      await engine.destroy();
    }
  });

  test('a re-edited path and a pending deletion both stay listed, with no error line', async () => {
    const { git } = await projectWithBareOrigin();
    writeFileSync(join(projectDir, 'other.md'), 'kept\n', 'utf-8');
    writeFileSync(join(projectDir, 'gone.md'), 'kept\n', 'utf-8');
    await git.add('.');
    await git.commit('more files');
    writeFileSync(join(projectDir, 'other.md'), 'edited again\n', 'utf-8');
    rmSync(join(projectDir, 'gone.md'), { force: true });

    const logs = captureSyncLogs();
    const engine = makeEngine();
    try {
      await engine.start();
      await healPaths(engine, ['other.md', 'gone.md']);

      const porcelain = (await git.raw(['status', '--porcelain'])).trimEnd().split('\n').sort();
      expect(porcelain).toEqual([' D gone.md', ' M other.md']);

      expect(logs.entries.filter((e) => e.data.event === 'self-heal-applied')).toHaveLength(0);
      expect(
        logs.entries.filter((e) => String(e.data.event ?? '').startsWith('self-heal')),
      ).toHaveLength(0);
    } finally {
      logs.restore();
      await engine.destroy();
    }
  });

  test('a path git reports as unmerged is never promised to the heal step', async () => {
    const { git } = await projectWithBareOrigin();
    await git.raw(['checkout', '-b', 'sister']);
    writeFileSync(join(projectDir, 'doc.md'), 'sister\n', 'utf-8');
    await git.add('doc.md');
    await git.commit('sister edit');
    await git.raw(['checkout', 'main']);
    writeFileSync(join(projectDir, 'doc.md'), 'mine\n', 'utf-8');
    await git.add('doc.md');
    await git.commit('my edit');

    const engine = makeEngine();
    try {
      await engine.start();
      await git.raw(['merge', 'sister']).catch(() => undefined);
      expect((await git.raw(['status', '--porcelain'])).trim()).toContain('UU doc.md');

      const internal = engine as unknown as { snapshotPromisedPaths: () => Promise<string[]> };
      expect(await internal.snapshotPromisedPaths()).toEqual([]);
    } finally {
      await git.raw(['merge', '--abort']).catch(() => undefined);
      await engine.destroy();
    }
  });

  test('an add/add unmerged path is never promised to the heal step', async () => {
    const { git } = await projectWithBareOrigin();
    await git.raw(['checkout', '-b', 'sister']);
    writeFileSync(join(projectDir, 'both.md'), 'sister\n', 'utf-8');
    await git.add('both.md');
    await git.commit('sister adds both.md');
    await git.raw(['checkout', 'main']);
    writeFileSync(join(projectDir, 'both.md'), 'mine\n', 'utf-8');
    await git.add('both.md');
    await git.commit('main adds both.md');

    const engine = makeEngine();
    try {
      await engine.start();
      await git.raw(['merge', 'sister']).catch(() => undefined);
      expect((await git.raw(['status', '--porcelain'])).trim()).toContain('AA both.md');

      const internal = engine as unknown as { snapshotPromisedPaths: () => Promise<string[]> };
      expect(await internal.snapshotPromisedPaths()).toEqual([]);
    } finally {
      await git.raw(['merge', '--abort']).catch(() => undefined);
      await engine.destroy();
    }
  });

  test('a both-deleted unmerged path is never promised to the heal step', async () => {
    const { git } = await projectWithBareOrigin();
    writeFileSync(join(projectDir, 'orig.md'), 'body\n', 'utf-8');
    await git.add('orig.md');
    await git.commit('seed orig.md');

    await git.raw(['checkout', '-b', 'sister']);
    await git.raw(['mv', 'orig.md', 'sister-name.md']);
    await git.commit('sister renames orig.md');
    await git.raw(['checkout', 'main']);
    await git.raw(['mv', 'orig.md', 'main-name.md']);
    await git.commit('main renames orig.md');

    const engine = makeEngine();
    try {
      await engine.start();
      await git.raw(['merge', 'sister']).catch(() => undefined);
      const porcelain = (await git.raw(['status', '--porcelain'])).trimEnd().split('\n').sort();
      expect(porcelain).toEqual(['AU main-name.md', 'DD orig.md', 'UA sister-name.md']);

      const internal = engine as unknown as { snapshotPromisedPaths: () => Promise<string[]> };
      expect(await internal.snapshotPromisedPaths()).toEqual([]);
    } finally {
      await git.raw(['merge', '--abort']).catch(() => undefined);
      await engine.destroy();
    }
  });

  test('more stale paths than the cap heal one capped batch per cycle, logging 20 paths', async () => {
    const { git } = await projectWithBareOrigin();
    const names = Array.from({ length: 105 }, (_, i) => `f${String(i).padStart(3, '0')}.md`);
    for (const name of names) writeFileSync(join(projectDir, name), 'v1\n', 'utf-8');
    await git.add('.');
    await git.commit('seed the capped fixture');
    await git.push();

    const logs = captureSyncLogs();
    const engine = makeEngine();
    try {
      await engine.start();

      for (const name of names) writeFileSync(join(projectDir, name), 'v2\n', 'utf-8');
      writeFileSync(lockPath(), '', 'utf-8');
      await engine.pushOnce();
      rmSync(lockPath(), { force: true });

      const stale = (await git.raw(['status', '--porcelain'])).trimEnd().split('\n');
      expect(stale).toHaveLength(names.length);

      logs.entries.length = 0;
      await engine.pushOnce();

      const heals = logs.entries.filter(
        (e) => e.level === 'warn' && e.data.event === 'self-heal-applied',
      );
      expect(heals).toHaveLength(1);
      expect(heals[0]?.data.pathCount).toBe(100);
      expect(heals[0]?.data.paths).toHaveLength(20);
      expect(heals[0]?.data.paths).toEqual(names.slice(0, 20));

      const remainder = (await git.raw(['status', '--porcelain'])).trimEnd().split('\n');
      expect(remainder).toHaveLength(5);

      await engine.pushOnce();
      expect((await git.raw(['status', '--porcelain'])).trim()).toBe('');
    } finally {
      rmSync(lockPath(), { force: true });
      logs.restore();
      await engine.destroy();
    }
  });

  test('a cycle that commits one path also heals a different path left stale', async () => {
    const { git, bare } = await projectWithBareOrigin();
    writeFileSync(join(projectDir, 'a.md'), 'a1\n', 'utf-8');
    writeFileSync(join(projectDir, 'b.md'), 'b1\n', 'utf-8');
    await git.add('.');
    await git.commit('seed a and b');
    await git.push();

    const logs = captureSyncLogs();
    const engine = makeEngine();
    try {
      await engine.start();

      writeFileSync(join(projectDir, 'a.md'), 'a2\n', 'utf-8');
      writeFileSync(lockPath(), '', 'utf-8');
      await engine.pushOnce();
      rmSync(lockPath(), { force: true });

      writeFileSync(join(projectDir, 'b.md'), 'b2\n', 'utf-8');
      const before = (await git.raw(['status', '--porcelain'])).trimEnd().split('\n').sort();
      expect(before).toEqual([' M b.md', 'MM a.md']);

      await engine.pushOnce();

      expect((await git.raw(['status', '--porcelain'])).trim()).toBe('');
      expect(await originHeadMessage(bare)).toContain('b.md');

      const heals = logs.entries.filter((e) => e.data.event === 'self-heal-applied');
      expect(heals).toHaveLength(1);
      expect(heals[0]?.data).toMatchObject({ paths: ['a.md'] });
    } finally {
      rmSync(lockPath(), { force: true });
      logs.restore();
      await engine.destroy();
    }
  });

  test('a symlink stale only in the index heals, while re-pointed symlinks stay listed', async () => {
    const { git } = await projectWithBareOrigin();
    writeFileSync(join(projectDir, 'target.md'), 'target body\n', 'utf-8');
    writeFileSync(join(projectDir, 'decoy.md'), 'target.md', 'utf-8');
    writeFileSync(join(projectDir, 'shared.md'), 'shared\n', 'utf-8');
    writeFileSync(join(projectDir, 'was-file.md'), 'shared\n', 'utf-8');
    symlinkSync('target.md', join(projectDir, 'link.md'));
    symlinkSync('target.md', join(projectDir, 'stale-link.md'));
    symlinkSync('missing.md', join(projectDir, 'dangling.md'));
    await git.add('.');
    await git.commit('symlink fixture');

    rmSync(join(projectDir, 'link.md'), { force: true });
    symlinkSync('decoy.md', join(projectDir, 'link.md'));
    rmSync(join(projectDir, 'was-file.md'), { force: true });
    symlinkSync('shared.md', join(projectDir, 'was-file.md'));

    rmSync(join(projectDir, 'stale-link.md'), { force: true });
    symlinkSync('decoy.md', join(projectDir, 'stale-link.md'));
    await git.add('stale-link.md');
    rmSync(join(projectDir, 'stale-link.md'), { force: true });
    symlinkSync('target.md', join(projectDir, 'stale-link.md'));
    expect((await git.raw(['status', '--porcelain', '--', 'stale-link.md'])).trim()).toBe(
      'MM stale-link.md',
    );

    const logs = captureSyncLogs();
    const engine = makeEngine();
    try {
      await engine.start();

      await healPaths(engine, ['link.md', 'dangling.md', 'was-file.md', 'stale-link.md']);

      const after = (await git.raw(['status', '--porcelain'])).trimEnd().split('\n').sort();
      expect(after).toEqual([' M link.md', ' T was-file.md']);

      const heals = logs.entries.filter(
        (e) => e.level === 'warn' && e.data.event === 'self-heal-applied',
      );
      expect(heals).toHaveLength(1);
      expect(heals[0]?.data).toMatchObject({ paths: ['stale-link.md'] });
      expect(logs.entries.filter((e) => e.data.event === 'self-heal-skipped')).toHaveLength(0);
    } finally {
      logs.restore();
      await engine.destroy();
    }
  });

  test('a push that only forwards existing commits still heals a stale real-index entry', async () => {
    const { git, bare } = await projectWithBareOrigin();
    writeFileSync(join(projectDir, 'doc.md'), 'v2\n', 'utf-8');
    await git.add('doc.md');
    await git.commit('local ahead of origin');

    writeFileSync(join(projectDir, 'doc.md'), 'v3\n', 'utf-8');
    await git.add('doc.md');
    writeFileSync(join(projectDir, 'doc.md'), 'v2\n', 'utf-8');
    expect((await git.raw(['status', '--porcelain'])).trim()).toBe('MM doc.md');

    const logs = captureSyncLogs();
    const engine = makeEngine();
    try {
      await engine.start();
      await engine.pushOnce();

      expect(await originHeadMessage(bare)).toContain('local ahead of origin');
      expect((await git.raw(['status', '--porcelain'])).trim()).toBe('');

      const heals = logs.entries.filter(
        (e) => e.level === 'warn' && e.data.event === 'self-heal-applied',
      );
      expect(heals).toHaveLength(1);
      expect(heals[0]?.data).toMatchObject({ paths: ['doc.md'] });
    } finally {
      logs.restore();
      await engine.destroy();
    }
  });

  test('a push cycle over a clean tree does no heal work', async () => {
    await projectWithBareOrigin();

    const logs = captureSyncLogs();
    const engine = makeEngine();
    try {
      await engine.start();
      await engine.pushOnce();

      expect(
        logs.entries.filter((e) => String(e.data.event ?? '').startsWith('self-heal')),
      ).toHaveLength(0);
    } finally {
      logs.restore();
      await engine.destroy();
    }
  });
});

describe('SyncEngine index-lock paused reason', () => {
  test('a lock held for a whole push cycle names the condition and clears on the next clean cycle', async () => {
    const { bare } = await projectWithBareOrigin();
    writeFileSync(join(projectDir, 'doc.md'), 'v2\n', 'utf-8');

    const logs = captureSyncLogs();
    const engine = makeEngine();
    try {
      await engine.start();
      writeFileSync(lockPath(), '', 'utf-8');
      await engine.pushOnce();

      expect(await originHeadMessage(bare)).toContain('doc.md');
      expect(engine.getStatus().pausedReason).toBe('git-index-locked');

      const locked = logs.entries.filter(
        (e) => e.level === 'error' && e.data.event === 'index-locked',
      );
      expect(locked).toHaveLength(1);
      expect(locked[0]?.data).toMatchObject({
        op: 'push',
        branch: 'main',
        errorClass: 'local',
        errorSubclass: 'index-lock',
      });
      expect(locked[0]?.msg).toContain('[sync] index locked');

      rmSync(lockPath(), { force: true });
      await engine.pushOnce();

      expect(engine.getStatus().pausedReason).toBeUndefined();
      expect((await simpleGit(projectDir).raw(['status', '--porcelain'])).trim()).toBe('');
    } finally {
      rmSync(lockPath(), { force: true });
      logs.restore();
      await engine.destroy();
    }
  });

  test('a lock held across a pull cycle names the condition from the pull side', async () => {
    const { bare } = await projectWithBareOrigin();
    await advanceOriginFromSisterClone(bare);
    writeFileSync(join(projectDir, 'doc.md'), 'local overlay\n', 'utf-8');

    const logs = captureSyncLogs();
    const engine = makeEngine();
    try {
      await engine.start();
      writeFileSync(lockPath(), '', 'utf-8');

      expect(await engine.pullOnce()).toBe('error');
      expect(engine.getStatus().pausedReason).toBe('git-index-locked');

      const locked = logs.entries.filter(
        (e) => e.level === 'error' && e.data.event === 'index-locked',
      );
      expect(locked).toHaveLength(1);
      expect(locked[0]?.data).toMatchObject({
        op: 'pull',
        branch: 'main',
        errorClass: 'local',
        errorSubclass: 'index-lock',
      });
    } finally {
      rmSync(lockPath(), { force: true });
      logs.restore();
      await engine.destroy();
    }
  });

  test('a reset blocked during a pull cycle is attributed to the pull, not to a push', async () => {
    const { bare } = await projectWithBareOrigin();
    await advanceOriginFromSisterClone(bare);
    writeFileSync(join(projectDir, 'doc.md'), 'local overlay\n', 'utf-8');

    const logs = captureSyncLogs();
    const engine = makeEngine();
    try {
      await engine.start();
      writeFileSync(lockPath(), '', 'utf-8');
      await engine.pullOnce('sync');

      const resets = logs.entries.filter((e) => e.data.event === 'stale-index-reset');
      expect(resets).toHaveLength(1);
      expect(resets[0]?.data).toMatchObject({
        outcome: 'failed',
        op: 'pull',
        branch: 'main',
        errorClass: 'local',
        errorSubclass: 'index-lock',
      });
      expect(resets[0]?.msg).not.toContain('landed push');

      const locked = logs.entries.filter(
        (e) => e.level === 'error' && e.data.event === 'index-locked',
      );
      expect(locked).toHaveLength(1);
      expect(locked[0]?.data).toMatchObject({ op: 'pull' });
      expect(locked[0]?.msg).toContain('[sync] index locked');
    } finally {
      rmSync(lockPath(), { force: true });
      logs.restore();
      await engine.destroy();
    }
  });

  test('a reset blocked while committing an MCP launcher entry is attributed to neither cycle', async () => {
    const { git } = await projectWithBareOrigin();
    const entry = (marker: string) => ({
      command: '/bin/sh',
      args: ['-l', '-c', `${marker}\nexit 127`],
    });
    const config = (marker: string) =>
      `${JSON.stringify({
        theme: 'keep',
        mcpServers: { other: { command: 'keep-me' }, 'open-knowledge': entry(marker) },
      })}\n`;
    writeFileSync(join(projectDir, '.mcp.json'), config('# ok-mcp-v2'), 'utf-8');
    await git.add('.mcp.json');
    await git.commit('mcp base');

    const logs = captureSyncLogs();
    const engine = makeEngine();
    const internal = engine as unknown as {
      persistReconciledMcpEntries: (
        entries: Array<{ path: string; raw: string; winnerEntry: Record<string, unknown> }>,
      ) => Promise<void>;
    };
    try {
      await engine.start();
      writeFileSync(lockPath(), '', 'utf-8');
      await internal.persistReconciledMcpEntries([
        {
          path: '.mcp.json',
          raw: config('# ok-mcp-v99'),
          winnerEntry: entry('# ok-mcp-v99'),
        },
      ]);

      const resets = logs.entries.filter((e) => e.data.event === 'stale-index-reset');
      expect(resets).toHaveLength(1);
      expect(resets[0]?.data).toMatchObject({
        outcome: 'failed',
        op: 'mcp-reconcile',
        branch: 'main',
        errorClass: 'local',
        errorSubclass: 'index-lock',
      });
    } finally {
      rmSync(lockPath(), { force: true });
      logs.restore();
      await engine.destroy();
    }
  });

  test('a ref lock hit while an index-lock pause is resting still names itself in the log', async () => {
    const { git } = await projectWithBareOrigin();
    writeFileSync(join(projectDir, 'doc.md'), 'v2\n', 'utf-8');
    const refLock = join(projectDir, '.git', 'refs', 'heads', 'main.lock');

    const logs = captureSyncLogs();
    const engine = makeEngine();
    try {
      await engine.start();
      writeFileSync(lockPath(), '', 'utf-8');
      await engine.pushOnce();
      expect(engine.getStatus().pausedReason).toBe('git-index-locked');

      rmSync(lockPath(), { force: true });
      writeFileSync(join(projectDir, 'doc.md'), 'v3\n', 'utf-8');
      writeFileSync(refLock, '', 'utf-8');
      await engine.pushOnce();

      expect((await git.raw(['status', '--porcelain'])).trim()).not.toBe('');
      expect(logs.entries.filter((e) => e.data.event === 'index-locked')).toHaveLength(1);
      const held = logs.entries.filter(
        (e) => e.level === 'error' && e.data.event === 'git-lock-held',
      );
      expect(held).toHaveLength(1);
      expect(held[0]?.data).toMatchObject({ op: 'push', branch: 'main' });
    } finally {
      rmSync(refLock, { force: true });
      rmSync(lockPath(), { force: true });
      logs.restore();
      await engine.destroy();
    }
  });

  test('a reset blocked inside the push non-fast-forward retry is attributed to the push', async () => {
    const { bare } = await projectWithBareOrigin();
    await advanceOriginFromSisterClone(bare);
    writeFileSync(join(projectDir, 'doc.md'), 'mine\n', 'utf-8');

    const logs = captureSyncLogs();
    let resetAttempts = 0;
    const editDuringTheCycle = (): void => {
      resetAttempts++;
      if (resetAttempts !== 1) return;
      writeFileSync(join(projectDir, 'doc.md'), 'typed while the push was in flight\n', 'utf-8');
    };
    const engine = makeEngine({ _beforeRealIndexResetRetry: editDuringTheCycle });
    try {
      await engine.start();
      writeFileSync(lockPath(), '', 'utf-8');
      await engine.pushOnce();

      const resets = logs.entries.filter((e) => e.data.event === 'stale-index-reset');
      expect(resets.length).toBeGreaterThanOrEqual(2);
      expect(resets.map((e) => e.data.op)).not.toContain('pull');
      expect(resets[resets.length - 1]?.data).toMatchObject({
        outcome: 'failed',
        op: 'push',
        branch: 'main',
        errorClass: 'local',
        errorSubclass: 'index-lock',
      });
    } finally {
      rmSync(lockPath(), { force: true });
      logs.restore();
      await engine.destroy();
    }
  });

  test('a lock under full auto-sync pauses the panel without disabling the engine', async () => {
    await projectWithBareOrigin();
    writeFileSync(join(projectDir, 'doc.md'), 'v2\n', 'utf-8');

    const engine = makeEngine({ mode: 'full' });
    try {
      await engine.start();
      expect(engine.getStatus().state).not.toBe('disabled');

      writeFileSync(lockPath(), '', 'utf-8');
      await engine.pushOnce();

      const status = engine.getStatus();
      expect(status.pausedReason).toBe('git-index-locked');
      expect(status.state).not.toBe('disabled');
    } finally {
      rmSync(lockPath(), { force: true });
      await engine.destroy();
    }
  });

  test('a held ref lock is not reported to the user as a held index lock', async () => {
    const { git } = await projectWithBareOrigin();
    writeFileSync(join(projectDir, 'doc.md'), 'v2\n', 'utf-8');
    const refLock = join(projectDir, '.git', 'refs', 'heads', 'main.lock');

    const logs = captureSyncLogs();
    const engine = makeEngine();
    try {
      await engine.start();
      writeFileSync(refLock, '', 'utf-8');
      await engine.pushOnce();

      expect(existsSync(lockPath())).toBe(false);
      expect(engine.getStatus().pausedReason).not.toBe('git-index-locked');
      expect((await git.raw(['status', '--porcelain'])).trim()).not.toBe('');

      expect(logs.entries.filter((e) => e.data.event === 'index-locked')).toHaveLength(0);
      const held = logs.entries.filter(
        (e) => e.level === 'error' && e.data.event === 'git-lock-held',
      );
      expect(held).toHaveLength(1);
      expect(held[0]?.data).toMatchObject({ op: 'push', branch: 'main' });
      expect(held[0]?.msg).not.toContain('another program is holding .git/index.lock');
    } finally {
      rmSync(refLock, { force: true });
      logs.restore();
      await engine.destroy();
    }
  });

  test('a pull invoked during an in-flight push is refused and leaves the lock pause intact', async () => {
    const { git } = await projectWithBareOrigin();
    writeFileSync(join(projectDir, 'a.md'), 'a1\n', 'utf-8');
    await git.add('a.md');
    await git.commit('seed a');
    await git.push();

    writeFileSync(join(projectDir, 'a.md'), 'a2\n', 'utf-8');
    await git.add('a.md');
    writeFileSync(join(projectDir, 'a.md'), 'a1\n', 'utf-8');
    writeFileSync(join(projectDir, 'b.md'), 'b1\n', 'utf-8');

    const logs = captureSyncLogs();
    let resetAttempts = 0;
    let pausedReasonDuringPull: string | undefined | 'never-ran' = 'never-ran';
    let engine: SyncEngine | undefined;
    const doPullCycle = vi.fn();
    const runInterleavedPull = async (): Promise<void> => {
      resetAttempts++;
      if (resetAttempts !== 2 || engine === undefined) return;
      const internals = engine as unknown as {
        runPullCycle: () => Promise<void>;
        doPullCycle: () => Promise<void>;
        pullTimer: NodeJS.Timeout | null;
      };
      internals.doPullCycle = doPullCycle;
      await internals.runPullCycle();
      pausedReasonDuringPull = engine.getStatus().pausedReason;
    };
    engine = makeEngine({ mode: 'full', _beforeRealIndexResetRetry: runInterleavedPull });
    try {
      await engine.start();
      writeFileSync(lockPath(), '', 'utf-8');
      await engine.pushOnce();

      expect(resetAttempts).toBeGreaterThanOrEqual(2);
      expect(doPullCycle).not.toHaveBeenCalled();
      expect(pausedReasonDuringPull).toBe('git-index-locked');
      expect(engine.getStatus().pausedReason).toBe('git-index-locked');

      const locked = logs.entries.filter(
        (e) => e.level === 'error' && e.data.event === 'index-locked',
      );
      expect(locked).toHaveLength(1);
      expect(locked[0]?.data).toMatchObject({ op: 'push' });
    } finally {
      rmSync(lockPath(), { force: true });
      logs.restore();
      await engine.destroy();
    }
  });

  test('a lock watch opened by the other leg neither captures nor restores the resting pause', () => {
    const engine = makeEngine();
    const internals = engine as unknown as {
      cycleInFlight: 'push' | 'pull' | null;
      pausedReason: string | undefined;
      restingIndexLockPause: string | undefined;
      beginIndexLockWatch: (op: 'push' | 'pull') => void;
      settleIndexLockPause: (op: 'push' | 'pull') => void;
    };
    internals.pausedReason = 'git-index-locked';
    internals.restingIndexLockPause = 'dirty-tree';
    internals.cycleInFlight = 'push';

    internals.beginIndexLockWatch('pull');
    expect(internals.restingIndexLockPause).toBe('dirty-tree');

    internals.settleIndexLockPause('pull');
    expect(internals.pausedReason).toBe('git-index-locked');

    internals.cycleInFlight = null;
    internals.settleIndexLockPause('push');
    expect(internals.pausedReason).toBe('dirty-tree');
  });

  test('a push failure that is not a held lock leaves the paused reason alone', async () => {
    const { git } = await projectWithBareOrigin();

    const engine = makeEngine();
    try {
      await engine.start();
      await git.remote(['set-url', 'origin', join(tmpDir, 'not-a-repo.git')]);
      writeFileSync(join(projectDir, 'doc.md'), 'v2\n', 'utf-8');
      await engine.pushOnce();

      expect(engine.getStatus().pushError).toBeDefined();
      expect(engine.getStatus().pausedReason).not.toBe('git-index-locked');
    } finally {
      await engine.destroy();
    }
  });

  test('the lock pause is neither written to the state file nor restored from it', async () => {
    await projectWithBareOrigin();
    writeFileSync(join(projectDir, 'doc.md'), 'v2\n', 'utf-8');

    const engine = makeEngine();
    try {
      await engine.start();
      writeFileSync(lockPath(), '', 'utf-8');
      await engine.pushOnce();
      rmSync(lockPath(), { force: true });

      expect(engine.getStatus().pausedReason).toBe('git-index-locked');
      const internal = engine as unknown as { saveStateNow: () => void };
      internal.saveStateNow();
      expect(JSON.parse(readFileSync(statePath(), 'utf-8')).pausedReason).toBeUndefined();
    } finally {
      rmSync(lockPath(), { force: true });
      await engine.destroy();
    }

    writeFileSync(
      statePath(),
      JSON.stringify({
        version: 1,
        lastSyncUtc: null,
        lastFetchUtc: null,
        lastPushedSha: null,
        pausedReason: 'git-index-locked',
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
