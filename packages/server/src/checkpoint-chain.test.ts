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
  // The safety contract rests on these two staying distinguishable. Collapsing
  // them is what let the writer commit a chain-severing checkpoint off any
  // transient git failure.

  test('an empty checkpoint namespace resolves to no anchors without throwing', async () => {
    // `for-each-ref` over an absent namespace exits 0 with no output, so this
    // really is "the first checkpoint" rather than a failed lookup.
    await expect(resolveCheckpointChainAnchors(shadowGit(shadow), 'main')).resolves.toEqual([]);
  });

  test('a failed ref query throws rather than reporting no anchors', async () => {
    // A rescue checkpoint exists, so the namespace is genuinely non-empty and
    // an empty result would be a lie rather than a first-checkpoint case.
    await saveInMemoryCheckpoint(shadow, 'content/docs', {
      kind: 'bridge-merge-loss',
      docName: 'intro.md',
      contents: '# rescued\n',
      label: 'merge loss',
      metadata: { lostSubstrings: ['x'] },
    });
    // A malformed `packed-refs` makes `for-each-ref` fail outright, which is the
    // real shape of the failures this guards (locked gitdir, concurrent prune,
    // spawn error) without mocking the git layer out of the test.
    writeFileSync(resolve(shadow.gitDir, 'packed-refs'), 'garbage not a ref line\n', 'utf-8');

    await expect(resolveCheckpointChainAnchors(shadowGit(shadow), 'main')).rejects.toThrow();
  });
});
