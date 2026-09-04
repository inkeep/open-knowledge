import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import simpleGit from 'simple-git';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  createMaintenanceCoordinator,
  FLUSH_GC_INTERVAL,
  type MaintenanceCoordinator,
} from './maintenance-coordinator.ts';
import {
  commitWip,
  configureShadowGc,
  initShadowRepo,
  type ShadowHandle,
  shadowGit,
  type WriterIdentity,
} from './shadow-repo.ts';
import { countShadowObjects } from './shadow-repo-stats.ts';

let tmpDir: string;
let projectRoot: string;
let contentDir: string;
let shadow: ShadowHandle;

const human: WriterIdentity = { id: 'human-ada', name: 'Ada', email: 'ada@example.com' };

beforeEach(async () => {
  tmpDir = await mkdtemp(resolve(tmpdir(), 'ok-maint-test-'));
  projectRoot = resolve(tmpDir, 'project');
  contentDir = resolve(projectRoot, 'content/docs');
  mkdirSync(contentDir, { recursive: true });
  const git = simpleGit(projectRoot);
  await git.init();
  await git.raw('config', 'user.name', 'Test');
  await git.raw('config', 'user.email', 'test@test.com');
  writeFileSync(resolve(contentDir, 'intro.md'), '# Hello\n');
  await git.add('.');
  await git.commit('Initial commit');
  shadow = await initShadowRepo(projectRoot);
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

async function seedReachableLooseObjects(n: number): Promise<void> {
  const sg = shadowGit(shadow);
  for (let i = 0; i < n; i++) {
    writeFileSync(resolve(contentDir, `f${i}.md`), `# file ${i} ${randomUUID()}\n`);
  }
  const idx = resolve(shadow.gitDir, `index-seed-${randomUUID()}`);
  await sg
    .env({ GIT_DIR: shadow.gitDir, GIT_WORK_TREE: shadow.workTree, GIT_INDEX_FILE: idx })
    .raw('add', 'content/docs');
  const tree = (
    await sg.env({ GIT_DIR: shadow.gitDir, GIT_INDEX_FILE: idx }).raw('write-tree')
  ).trim();
  const sha = (
    await sg
      .env({
        GIT_DIR: shadow.gitDir,
        GIT_AUTHOR_NAME: 'Ada',
        GIT_AUTHOR_EMAIL: 'ada@example.com',
        GIT_COMMITTER_NAME: 'Ada',
        GIT_COMMITTER_EMAIL: 'ada@example.com',
      })
      .raw('commit-tree', tree, '-m', 'wip: seed')
  ).trim();
  await sg.raw('update-ref', 'refs/wip/main/human-ada', sha);
  rmSync(idx, { force: true });
}

const GC_AUTO_SAMPLE_PAYLOADS = [
  'gc auto fanout sample object 188\n',
  'gc auto fanout sample object 460\n',
  'gc auto fanout sample object 486\n',
];

async function seedGcAutoSampleObjects(): Promise<void> {
  const sg = shadowGit(shadow);
  for (const payload of GC_AUTO_SAMPLE_PAYLOADS) {
    const file = resolve(tmpDir, `gc-auto-sample-${randomUUID()}`);
    writeFileSync(file, payload);
    const sha = (await sg.raw('hash-object', '-w', '--', file)).trim();
    rmSync(file, { force: true });
    if (!sha.startsWith('17')) {
      throw new Error(
        `precomputed gc sample payload no longer hashes into objects/17 (got ${sha}); ` +
          'recompute GC_AUTO_SAMPLE_PAYLOADS to repin the gc --auto fanout sample',
      );
    }
  }
}

type WithScheduledMaintenance = { runScheduledMaintenance(trigger: string): Promise<void> };
function spyScheduledMaintenance(coord: MaintenanceCoordinator) {
  return vi.spyOn(coord as unknown as WithScheduledMaintenance, 'runScheduledMaintenance');
}

describe('configureShadowGc (PRD-6972 D8)', () => {
  test('writes gc.auto / autoDetach / commit-graph config (idempotent)', async () => {
    await configureShadowGc(shadow);
    const sg = shadowGit(shadow);
    expect((await sg.raw('config', 'gc.auto')).trim()).toBe('512');
    expect((await sg.raw('config', 'gc.autoDetach')).trim()).toBe('false');
    expect((await sg.raw('config', 'gc.writeCommitGraph')).trim()).toBe('true');
    expect((await sg.raw('config', 'commitGraph.changedPaths')).trim()).toBe('true');
  });
});

describe('MaintenanceCoordinator.runGc (PRD-6972 FR4)', () => {
  test('packs a >512-loose-object repo: loose drops, packfile appears', async () => {
    await seedReachableLooseObjects(1500);
    await seedGcAutoSampleObjects();
    const before = await countShadowObjects(shadow);
    expect(before.looseObjects).toBeGreaterThan(512);
    expect(before.packfiles).toBe(0);

    const coord = createMaintenanceCoordinator({ getShadow: () => shadow });
    const result = await coord.runGc('test');

    expect(result.ran).toBe(true);
    expect(result.looseAfter).toBeLessThan(result.looseBefore ?? 0);
    expect(result.packfilesAfter).toBeGreaterThan(0);
    const after = await countShadowObjects(shadow);
    expect(after.looseObjects).toBeLessThan(before.looseObjects);
  }, 60_000);

  test('A1: gc is safe against the shadow layout with a concurrent commit', async () => {
    await seedReachableLooseObjects(1500);
    await seedGcAutoSampleObjects();
    const coord = createMaintenanceCoordinator({ getShadow: () => shadow });

    writeFileSync(resolve(contentDir, 'intro.md'), '# concurrent edit\n');
    const [gcResult, concurrentSha] = await Promise.all([
      coord.runGc('test'),
      commitWip(shadow, human, 'content/docs', 'WIP: during gc'),
    ]);

    expect(gcResult.ran).toBe(true);

    const sg = shadowGit(shadow);
    const fsck = await sg.raw('fsck', '--full', '--strict');
    expect(fsck).not.toContain('error');
    expect(fsck).not.toContain('missing');

    const head = (await sg.raw('rev-parse', 'refs/wip/main/human-ada')).trim();
    expect(head).toBe(concurrentSha);
  }, 60_000);

  test('A2: gc is safe against a sustained stream of concurrent commits', async () => {
    await seedReachableLooseObjects(1500);
    await seedGcAutoSampleObjects();
    const coord = createMaintenanceCoordinator({ getShadow: () => shadow });

    const shas: string[] = [];
    const [gcResult] = await Promise.all([
      coord.runGc('test'),
      (async () => {
        for (let i = 0; i < 20; i++) {
          writeFileSync(resolve(contentDir, 'intro.md'), `# concurrent edit ${i}\n`);
          shas.push(await commitWip(shadow, human, 'content/docs', `WIP: during gc ${i}`));
        }
      })(),
    ]);

    expect(gcResult.ran).toBe(true);

    const sg = shadowGit(shadow);
    const fsck = await sg.raw('fsck', '--full', '--strict');
    expect(fsck).not.toContain('error');
    expect(fsck).not.toContain('missing');

    const head = (await sg.raw('rev-parse', 'refs/wip/main/human-ada')).trim();
    expect(shas).toHaveLength(20);
    expect(head).toBe(shas[shas.length - 1]);
  }, 60_000);

  test('detects + surfaces a gc.log latch', async () => {
    writeFileSync(resolve(shadow.gitDir, 'gc.log'), 'warning: prior gc failed\n');
    const coord = createMaintenanceCoordinator({ getShadow: () => shadow });
    const result = await coord.runGc('test');
    expect(result.ran).toBe(true);
    expect(result.latch).toBe(true);
  });

  test('master kill switch disables maintenance (D18)', async () => {
    const prev = process.env.OK_SHADOW_MAINTENANCE_DISABLED;
    process.env.OK_SHADOW_MAINTENANCE_DISABLED = '1';
    try {
      const coord = createMaintenanceCoordinator({ getShadow: () => shadow });
      const result = await coord.runGc('test');
      expect(result.ran).toBe(false);
      expect(result.skipped).toBe('disabled');
    } finally {
      if (prev === undefined) delete process.env.OK_SHADOW_MAINTENANCE_DISABLED;
      else process.env.OK_SHADOW_MAINTENANCE_DISABLED = prev;
    }
  });

  test('gate: a second concurrent runGc is skipped as busy (one op at a time)', async () => {
    await seedReachableLooseObjects(1500);
    const coord = createMaintenanceCoordinator({ getShadow: () => shadow });
    const [a, b] = await Promise.all([coord.runGc('a'), coord.runGc('b')]);
    const ran = [a, b].filter((r) => r.ran);
    const busy = [a, b].filter((r) => r.skipped === 'busy');
    expect(ran).toHaveLength(1);
    expect(busy).toHaveLength(1);
  }, 60_000);

  test('no-ops gracefully when no shadow repo exists', async () => {
    const coord = createMaintenanceCoordinator({ getShadow: () => null });
    const result = await coord.runGc('test');
    expect(result.ran).toBe(false);
    expect(result.skipped).toBe('no-shadow');
  });
});

describe('MaintenanceCoordinator triggers (PRD-6972 FR4 / D8 / D12)', () => {
  test('noteFlushCommit fires gc every FLUSH_GC_INTERVAL commits, then resets', async () => {
    const coord = createMaintenanceCoordinator({ getShadow: () => shadow });
    const spy = spyScheduledMaintenance(coord).mockResolvedValue(undefined);
    const drain = () => new Promise((r) => setTimeout(r, 0));

    for (let i = 0; i < FLUSH_GC_INTERVAL - 1; i++) coord.noteFlushCommit();
    await drain();
    expect(spy).toHaveBeenCalledTimes(0);
    coord.noteFlushCommit();
    await drain();
    expect(spy).toHaveBeenCalledTimes(1);

    for (let i = 0; i < FLUSH_GC_INTERVAL - 1; i++) coord.noteFlushCommit();
    await drain();
    expect(spy).toHaveBeenCalledTimes(1);
    coord.noteFlushCommit();
    await drain();
    expect(spy).toHaveBeenCalledTimes(2);
  });

  test('noteFlushCommit no-ops when maintenance is disabled', () => {
    const prev = process.env.OK_SHADOW_MAINTENANCE_DISABLED;
    process.env.OK_SHADOW_MAINTENANCE_DISABLED = '1';
    try {
      const coord = createMaintenanceCoordinator({ getShadow: () => shadow });
      const spy = spyScheduledMaintenance(coord);
      for (let i = 0; i < FLUSH_GC_INTERVAL + 5; i++) coord.noteFlushCommit();
      expect(spy).toHaveBeenCalledTimes(0);
    } finally {
      if (prev === undefined) delete process.env.OK_SHADOW_MAINTENANCE_DISABLED;
      else process.env.OK_SHADOW_MAINTENANCE_DISABLED = prev;
    }
  });

  test('onSessionClose evaluates maintenance', async () => {
    const coord = createMaintenanceCoordinator({ getShadow: () => shadow });
    const spy = spyScheduledMaintenance(coord).mockResolvedValue(undefined);
    await coord.onSessionClose();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  test('runReap no-ops when projectGitDir is not configured', async () => {
    const coord = createMaintenanceCoordinator({ getShadow: () => shadow });
    await coord.runReap('test');
    expect(coord.isRunning).toBe(false);
  });

  test('runBootMaintenance settles only after the whole maintenance run', async () => {
    vi.useFakeTimers();
    try {
      const coord = createMaintenanceCoordinator({ getShadow: () => shadow });
      let resolveMaintenance: () => void = () => {};
      spyScheduledMaintenance(coord).mockImplementation(
        () =>
          new Promise<void>((res) => {
            resolveMaintenance = () => res();
          }),
      );
      let settled = false;
      const run = coord.runBootMaintenance().then(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(1_200);
      expect(settled).toBe(false);
      resolveMaintenance();
      await run;
      expect(settled).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  test('runBootMaintenance no-ops when maintenance is disabled', async () => {
    const prev = process.env.OK_SHADOW_MAINTENANCE_DISABLED;
    process.env.OK_SHADOW_MAINTENANCE_DISABLED = '1';
    try {
      const coord = createMaintenanceCoordinator({ getShadow: () => shadow });
      const spy = spyScheduledMaintenance(coord);
      await coord.runBootMaintenance();
      expect(spy).toHaveBeenCalledTimes(0);
    } finally {
      if (prev === undefined) delete process.env.OK_SHADOW_MAINTENANCE_DISABLED;
      else process.env.OK_SHADOW_MAINTENANCE_DISABLED = prev;
    }
  });

  test('a destroy() mid-run stops the compound run at the next leg boundary', async () => {
    const coord = createMaintenanceCoordinator({
      getShadow: () => shadow,
      projectGitDir: resolve(projectRoot, '.git'),
    });
    let releaseConsolidate: () => void = () => {};
    const consolidateSpy = vi
      .spyOn(
        coord as unknown as { consolidateInner: (trigger: string) => Promise<void> },
        'consolidateInner',
      )
      .mockImplementation(
        () =>
          new Promise<void>((res) => {
            releaseConsolidate = () => res();
          }),
      );
    const reapSpy = vi
      .spyOn(coord as unknown as { reapInner: (trigger: string) => Promise<void> }, 'reapInner')
      .mockResolvedValue(undefined);
    const gcSpy = vi
      .spyOn(coord as unknown as { gcInner: (trigger: string) => Promise<void> }, 'gcInner')
      .mockResolvedValue(undefined);

    const run = coord.runBootMaintenance();
    await new Promise((r) => setTimeout(r, 10));
    expect(consolidateSpy).toHaveBeenCalledTimes(1);
    coord.destroy();
    releaseConsolidate();
    await run;
    expect(reapSpy).not.toHaveBeenCalled();
    expect(gcSpy).not.toHaveBeenCalled();
  });
});
