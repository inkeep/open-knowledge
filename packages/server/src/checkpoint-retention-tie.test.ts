import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import simpleGit from 'simple-git';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  DEFAULT_CHECKPOINT_RETENTION,
  gcCheckpointRefs,
  initShadowRepo,
  type ShadowHandle,
  saveInMemoryCheckpoint,
} from './shadow-repo.ts';

let tmpDir: string;
let projectRoot: string;
let shadow: ShadowHandle;

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'ok-checkpoint-tie-'));
  projectRoot = resolve(tmpDir, 'project');
  mkdirSync(resolve(projectRoot, 'content/docs'), { recursive: true });
  const git = simpleGit(projectRoot);
  await git.init();
  await git.raw('config', 'user.name', 'Test');
  await git.raw('config', 'user.email', 'test@test.com');
  shadow = await initShadowRepo(projectRoot);
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function survivingShas(): Set<string> {
  return new Set(
    execFileSync('git', ['for-each-ref', '--format=%(objectname)', 'refs/checkpoints/main/'], {
      cwd: shadow.workTree,
      encoding: 'utf-8',
      env: { ...process.env, GIT_DIR: shadow.gitDir, GIT_WORK_TREE: shadow.workTree },
    })
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean),
  );
}

function writeCheckpoint(index: number, date: string): Promise<string> {
  return saveInMemoryCheckpoint(shadow, 'content/docs', {
    kind: 'defer-exhaustion-loss',
    docName: `doc-${index}.md`,
    contents: `rescued body ${index}\n`,
    label: `defer exhaustion ${index}`,
    metadata: { deferCount: 9 },
    date,
  });
}

const SECOND_A = '2026-01-02T03:04:05Z';
const SECOND_B = '2026-01-02T03:04:06Z';
const SECOND_C = '2026-01-02T03:04:07Z';

describe('checkpoint retention across a timestamp tie', () => {
  test('a same-second burst straddling the keep boundary retains every member instead of destroying an arbitrary one', async () => {
    const shas: string[] = [];
    for (let i = 0; i < 4; i++) shas.push(await writeCheckpoint(i, SECOND_A));

    const gc = await gcCheckpointRefs(shadow, 'main', {
      ...DEFAULT_CHECKPOINT_RETENTION,
      maxDeferExhaustionLoss: 2,
      ttlMs: 0,
    });

    expect(gc.deletedDeferExhaustionLoss).toBe(0);
    const survivors = survivingShas();
    for (const sha of shas) expect(survivors.has(sha)).toBe(true);
  });

  test('checkpoints written in distinct seconds still evict oldest-first down to the budget', async () => {
    const oldest = await writeCheckpoint(0, SECOND_A);
    const older = await writeCheckpoint(1, SECOND_B);
    const newest = await writeCheckpoint(2, SECOND_C);

    const gc = await gcCheckpointRefs(shadow, 'main', {
      ...DEFAULT_CHECKPOINT_RETENTION,
      maxDeferExhaustionLoss: 2,
      ttlMs: 0,
    });

    expect(gc.deletedDeferExhaustionLoss).toBe(1);
    const survivors = survivingShas();
    expect(survivors.has(newest)).toBe(true);
    expect(survivors.has(older)).toBe(true);
    expect(survivors.has(oldest)).toBe(false);
  });

  test('the keep window widens across the straddling group only, so strictly older checkpoints are still evicted', async () => {
    const oldest = await writeCheckpoint(0, SECOND_A);
    const tied = [
      await writeCheckpoint(1, SECOND_B),
      await writeCheckpoint(2, SECOND_B),
      await writeCheckpoint(3, SECOND_B),
    ];
    const newest = await writeCheckpoint(4, SECOND_C);

    const gc = await gcCheckpointRefs(shadow, 'main', {
      ...DEFAULT_CHECKPOINT_RETENTION,
      maxDeferExhaustionLoss: 2,
      ttlMs: 0,
    });

    expect(gc.deletedDeferExhaustionLoss).toBe(1);
    const survivors = survivingShas();
    expect(survivors.has(newest)).toBe(true);
    for (const sha of tied) expect(survivors.has(sha)).toBe(true);
    expect(survivors.has(oldest)).toBe(false);
  });

  test('the TTL lower bound still reaps tied checkpoints that are inside the count budget but past expiry', async () => {
    const shas: string[] = [];
    for (let i = 0; i < 2; i++) shas.push(await writeCheckpoint(i, SECOND_A));

    const gc = await gcCheckpointRefs(shadow, 'main', {
      ...DEFAULT_CHECKPOINT_RETENTION,
      maxDeferExhaustionLoss: 50,
      ttlMs: 1000,
    });

    expect(gc.deletedDeferExhaustionLoss).toBe(2);
    const survivors = survivingShas();
    for (const sha of shas) expect(survivors.has(sha)).toBe(false);
  });
});
