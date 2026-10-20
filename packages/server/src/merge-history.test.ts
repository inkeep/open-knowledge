import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseCheckpoint } from '@inkeep/open-knowledge-core/shadow-repo-layout';
import simpleGit from 'simple-git';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { configureTestGitRepository } from '../../../test-support/configure-git-fixture.test-helper.ts';
import { createMergeHistoryRecorder } from './merge-history.ts';
import { getMetrics, resetMetrics } from './metrics.ts';
import { initShadowRepo, type ShadowHandle, shadowGit } from './shadow-repo.ts';

describe('createMergeHistoryRecorder', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = realpathSync(mkdtempSync(join(tmpdir(), 'ok-merge-history-')));
    resetMetrics();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    resetMetrics();
  });

  const recorderFor = (shadow: ShadowHandle | undefined) =>
    createMergeHistoryRecorder({
      getShadow: () => shadow,
      contentRoot: '',
      getBranch: () => 'main',
    });

  test('with no shadow repo nothing is written, keep-live resolves not saved, and both count as unavailable', async () => {
    const history = recorderFor(undefined);

    await expect(
      history.keptLive('doc', { side: 'theirs', bytes: 'outside\n' }, 'too-large'),
    ).resolves.toBe(false);
    history.bothKept('doc', { ours: 'here\n', theirs: 'outside\n' }, 1);

    expect(getMetrics().mergeHistoryUnavailable).toBe(2);
    expect(getMetrics().mergeHistoryCheckpointFailures).toBe(0);
    expect(getMetrics().mergeHistoryCheckpointCreated).toBe(0);
  });

  test('a keep-live write that fails resolves false and counts a failure, never a save', async () => {
    const history = recorderFor({
      gitDir: join(tmpDir, 'missing-git-dir'),
      workTree: tmpDir,
    });

    await expect(
      history.keptLive('doc', { side: 'theirs', bytes: 'outside\n' }, 'check-failed'),
    ).resolves.toBe(false);
    expect(getMetrics().mergeHistoryCheckpointFailures).toBe(1);
    expect(getMetrics().mergeHistoryCheckpointCreated).toBe(0);
  });

  test('a keep-live write that lands resolves true and leaves the full bytes in a checkpoint', async () => {
    const projectRoot = join(tmpDir, 'project');
    mkdirSync(projectRoot, { recursive: true });
    await simpleGit(projectRoot).init();
    configureTestGitRepository(projectRoot);
    const shadow = await initShadowRepo(projectRoot);
    const history = recorderFor(shadow);
    const outside = '# Outside\n\n  indented  \n';

    await expect(
      history.keptLive('doc', { side: 'theirs', bytes: outside }, 'check-failed'),
    ).resolves.toBe(true);
    history.bothKept('doc', { ours: 'here\n', theirs: outside }, 1);
    await vi.waitFor(() => expect(getMetrics().mergeHistoryCheckpointCreated).toBe(3));

    const sg = shadowGit(shadow);
    const shas = (await sg.raw('for-each-ref', '--format=%(objectname)', 'refs/checkpoints/main/'))
      .trim()
      .split('\n');
    const kinds: string[] = [];
    for (const sha of shas) {
      const parsed = parseCheckpoint(await sg.raw('log', '-1', '--format=%B', sha));
      if (
        parsed?.kind !== 'external-change-both-kept' &&
        parsed?.kind !== 'external-change-kept-live'
      ) {
        throw new Error(`unexpected checkpoint ${sha}: ${parsed?.kind}`);
      }
      kinds.push(`${parsed.kind}:${parsed.metadata.side}`);
      if (parsed.kind === 'external-change-kept-live') {
        expect(await sg.raw('show', `${sha}:doc`)).toBe(outside);
      }
    }
    expect(kinds.sort()).toEqual([
      'external-change-both-kept:ours',
      'external-change-both-kept:theirs',
      'external-change-kept-live:theirs',
    ]);
    expect(getMetrics().mergeHistoryCheckpointFailures).toBe(0);
  });
});
