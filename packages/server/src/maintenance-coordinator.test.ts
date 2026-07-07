import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import simpleGit from 'simple-git';
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

// Seed N distinct, REACHABLE loose objects fast: write N files, `git add` them
// (creates N blobs), write-tree + commit-tree, and point a WIP ref at the
// commit. All N blobs + the tree + the commit are reachable, so `git gc` packs
// them (vs. unreachable loose objects, which gc leaves loose within the grace).
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

// Spy on the private compound-maintenance entry point that every trigger
// (noteFlushCommit / onSessionClose / boot) invokes. Trigger-wiring tests assert
// "the trigger fired maintenance" at this seam — the gc/consolidate/reap legs run
// under it without re-acquiring the gate, so spying a single leg would miss it.
type WithScheduledMaintenance = { runScheduledMaintenance(trigger: string): Promise<void> };
function spyScheduledMaintenance(coord: MaintenanceCoordinator) {
  return spyOn(coord as unknown as WithScheduledMaintenance, 'runScheduledMaintenance');
}

describe('configureShadowGc (PRD-6972 D8)', () => {
  test('writes gc.auto / autoDetach / commit-graph config (idempotent)', async () => {
    await configureShadowGc(shadow); // initShadowRepo already ran it; idempotent re-run
    const sg = shadowGit(shadow);
    expect((await sg.raw('config', 'gc.auto')).trim()).toBe('512');
    expect((await sg.raw('config', 'gc.autoDetach')).trim()).toBe('false');
    expect((await sg.raw('config', 'gc.writeCommitGraph')).trim()).toBe('true');
    expect((await sg.raw('config', 'commitGraph.changedPaths')).trim()).toBe('true');
  });
});

describe('MaintenanceCoordinator.runGc (PRD-6972 FR4)', () => {
  test('packs a >512-loose-object repo: loose drops, packfile appears', async () => {
    await seedReachableLooseObjects(1500); // well over the gc.auto=512 estimate
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

  // A1 (STOP_IF gate): git gc --auto must be safe against the shadow layout
  // (core.bare unset, core.worktree set) WITH concurrent commits.
  test('A1: gc is safe against the shadow layout with a concurrent commit', async () => {
    await seedReachableLooseObjects(1500);
    const coord = createMaintenanceCoordinator({ getShadow: () => shadow });

    // gc and a fresh WIP commit race.
    writeFileSync(resolve(contentDir, 'intro.md'), '# concurrent edit\n');
    const [gcResult, concurrentSha] = await Promise.all([
      coord.runGc('test'),
      commitWip(shadow, human, 'content/docs', 'WIP: during gc'),
    ]);

    expect(gcResult.ran).toBe(true);

    // The repo is structurally valid after the race (no corruption).
    const sg = shadowGit(shadow);
    const fsck = await sg.raw('fsck', '--full', '--strict');
    expect(fsck).not.toContain('error');
    expect(fsck).not.toContain('missing');

    // The concurrent commit survived and is reachable.
    const head = (await sg.raw('rev-parse', 'refs/wip/main/human-ada')).trim();
    expect(head).toBe(concurrentSha);
  }, 60_000);

  test('detects + surfaces a gc.log latch', async () => {
    // Simulate a prior gc failure: a recent gc.log makes `git gc --auto` decline
    // to run and leaves the latch in place.
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
    // noteFlushCommit fires runScheduledMaintenance fire-and-forget, so drain
    // microtasks before asserting maintenance was reached.
    const drain = () => new Promise((r) => setTimeout(r, 0));

    for (let i = 0; i < FLUSH_GC_INTERVAL - 1; i++) coord.noteFlushCommit();
    await drain();
    expect(spy).toHaveBeenCalledTimes(0);
    coord.noteFlushCommit(); // the FLUSH_GC_INTERVAL-th
    await drain();
    expect(spy).toHaveBeenCalledTimes(1);

    // Counter reset — the next interval is needed to fire again.
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
    // No projectGitDir → reap disabled; must not throw and must not run gc.
    await coord.runReap('test');
    expect(coord.isRunning).toBe(false);
  });

  test('runBootMaintenance returns within the cap when gc is slow (background continuation)', async () => {
    const coord = createMaintenanceCoordinator({ getShadow: () => shadow });
    let resolveMaintenance: () => void = () => {};
    spyScheduledMaintenance(coord).mockImplementation(
      () =>
        new Promise<void>((res) => {
          resolveMaintenance = () => res();
        }),
    );
    const start = performance.now();
    await coord.runBootMaintenance(50); // 50ms cap
    const elapsed = performance.now() - start;
    // Returned at the cap, not after the (still-pending) maintenance run.
    expect(elapsed).toBeLessThan(2000);
    resolveMaintenance(); // let the background run settle so it does not dangle
  });

  test('runBootMaintenance no-ops when maintenance is disabled', async () => {
    const prev = process.env.OK_SHADOW_MAINTENANCE_DISABLED;
    process.env.OK_SHADOW_MAINTENANCE_DISABLED = '1';
    try {
      const coord = createMaintenanceCoordinator({ getShadow: () => shadow });
      const spy = spyScheduledMaintenance(coord);
      await coord.runBootMaintenance(50);
      expect(spy).toHaveBeenCalledTimes(0);
    } finally {
      if (prev === undefined) delete process.env.OK_SHADOW_MAINTENANCE_DISABLED;
      else process.env.OK_SHADOW_MAINTENANCE_DISABLED = prev;
    }
  });
});
