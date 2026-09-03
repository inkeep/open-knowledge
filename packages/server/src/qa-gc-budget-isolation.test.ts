
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

const BUDGET = 5;
const OVER = BUDGET + 4;

const burstDate = (rank: number): string => `@${1_700_000_000 + rank * 100} +0000`;

let tmpDir: string;
let shadow: ShadowHandle;

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'ok-gc-budget-'));
  const projectRoot = resolve(tmpDir, 'project');
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

describe('checkpoint GC budgets for the derive-guard / detector / backstop kinds', () => {
  test('a defer-exhaustion burst evicts only its own bucket and leaves every sibling anchor retained', async () => {
    for (let i = 0; i < OVER; i++) {
      await saveInMemoryCheckpoint(shadow, 'content/docs', {
        kind: 'defer-exhaustion-loss',
        docName: `noisy-${i}.md`,
        contents: `pending line ${i}\n`,
        label: `defer exhaustion ${i}`,
        metadata: { deferCount: 9 },
        date: burstDate(i),
      });
    }
    const anchors = [
      { kind: 'bridge-merge-loss', metadata: { lostSubstrings: ['anchor'] } },
      { kind: 'producer-guard-loss', metadata: { construct: 'table' } },
      { kind: 'observer-a-duplication', metadata: { duplicatedLineCount: 1 } },
      { kind: 'external-change-rescue', metadata: { incomingDiskSha: 'deadbeef' } },
      { kind: 'bridge-derive-loss', metadata: { lostSubstrings: ['anchor'] } },
      { kind: 'bridge-backstop-trip', metadata: { rounds: 8 } },
    ] as const;
    for (const anchor of anchors) {
      await saveInMemoryCheckpoint(shadow, 'content/docs', {
        ...anchor,
        docName: `anchor-${anchor.kind}.md`,
        contents: `anchor body for ${anchor.kind}\n`,
        label: `anchor ${anchor.kind}`,
      });
    }

    const result = await gcCheckpointRefs(shadow, 'main', {
      ...DEFAULT_CHECKPOINT_RETENTION,
      maxDeferExhaustionLoss: BUDGET,
      ttlMs: 0,
    });

    expect(result.scanned).toBe(OVER + anchors.length);
    expect(result.deletedDeferExhaustionLoss).toBe(OVER - BUDGET);
    expect(result.deletedBridgeMergeLoss).toBe(0);
    expect(result.deletedProducerGuardLoss).toBe(0);
    expect(result.deletedObserverADuplication).toBe(0);
    expect(result.deletedExternalChangeRescue).toBe(0);
    expect(result.deletedBridgeDeriveLoss).toBe(0);
    expect(result.deletedBridgeBackstopTrip).toBe(0);
    expect(result.deletedAutoConsolidation).toBe(0);
  }, 60_000);

  test('bridge-derive-loss and bridge-backstop-trip each carry their own budget', async () => {
    for (let i = 0; i < OVER; i++) {
      await saveInMemoryCheckpoint(shadow, 'content/docs', {
        kind: 'bridge-derive-loss',
        docName: `derive-${i}.md`,
        contents: `derive body ${i}\n`,
        label: `derive loss ${i}`,
        metadata: { lostSubstrings: [`derive-${i}`] },
        date: burstDate(i),
      });
      await saveInMemoryCheckpoint(shadow, 'content/docs', {
        kind: 'bridge-backstop-trip',
        docName: `backstop-${i}.md`,
        contents: `backstop body ${i}\n`,
        label: `backstop trip ${i}`,
        metadata: { rounds: 8 },
        date: burstDate(i),
      });
    }

    const result = await gcCheckpointRefs(shadow, 'main', {
      ...DEFAULT_CHECKPOINT_RETENTION,
      maxBridgeDeriveLoss: BUDGET,
      maxBridgeBackstopTrip: OVER,
      ttlMs: 0,
    });

    expect(result.deletedBridgeDeriveLoss).toBe(OVER - BUDGET);
    expect(result.deletedBridgeBackstopTrip).toBe(0);
  }, 60_000);
});
