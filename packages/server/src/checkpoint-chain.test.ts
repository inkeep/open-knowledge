import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import simpleGit from 'simple-git';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { resolveCheckpointChainAnchors } from './checkpoint-chain.ts';
import {
  initShadowRepo,
  type ShadowHandle,
  saveInMemoryCheckpoint,
  shadowGit,
} from './shadow-repo';

let tmpDir: string;
let projectRoot: string;
let shadow: ShadowHandle;

beforeEach(async () => {
  tmpDir = await mkdtemp(resolve(tmpdir(), 'ok-chain-'));
  projectRoot = resolve(tmpDir, 'project');
  mkdirSync(resolve(projectRoot, 'content/docs'), { recursive: true });
  const git = simpleGit(projectRoot);
  await git.init();
  await git.raw('config', 'user.name', 'Test');
  await git.raw('config', 'user.email', 'test@test.com');
  shadow = await initShadowRepo(projectRoot);
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe('resolveCheckpointChainAnchors — empty versus unknown', () => {
  test('an empty checkpoint namespace resolves to no anchors without throwing', async () => {
    await expect(resolveCheckpointChainAnchors(shadowGit(shadow), 'main')).resolves.toEqual([]);
  });

  test('a failed ref query throws rather than reporting no anchors', async () => {
    await saveInMemoryCheckpoint(shadow, 'content/docs', {
      kind: 'bridge-merge-loss',
      docName: 'intro.md',
      contents: '# rescued\n',
      label: 'merge loss',
      metadata: { lostSubstrings: ['x'] },
    });
    writeFileSync(resolve(shadow.gitDir, 'packed-refs'), 'garbage not a ref line\n', 'utf-8');

    await expect(resolveCheckpointChainAnchors(shadowGit(shadow), 'main')).rejects.toThrow();
  });
});
