import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseCheckpoint } from '@inkeep/open-knowledge-core/shadow-repo-layout';
import simpleGit from 'simple-git';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { configureTestGitRepository } from '../../../test-support/configure-git-fixture.test-helper.ts';
import { DocNoticeLedger } from './doc-notices.ts';
import { createMergeHistoryRecorder } from './merge-history.ts';
import { getMetrics, resetMetrics } from './metrics.ts';
import type { KeptBlockPair } from './reconciliation.ts';
import { initShadowRepo, type ShadowHandle, shadowGit } from './shadow-repo.ts';

const KEPT_TWICE: KeptBlockPair = {
  blockIndex: 1,
  base: 'Shared.',
  ours: 'Shared, here.',
  theirs: 'Shared, outside.',
  landed: 'both',
};
const RESTORED: KeptBlockPair = {
  blockIndex: 2,
  base: 'Gone.',
  ours: '',
  theirs: 'Gone, changed outside.',
  landed: 'theirs',
};

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
    history.bothKept('doc', { ours: 'here\n', theirs: 'outside\n' }, [KEPT_TWICE]);

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
    history.bothKept('doc', { ours: 'here\n', theirs: outside }, [KEPT_TWICE]);
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

  describe('the notice on the document', () => {
    function noticesIn(dir: string): DocNoticeLedger {
      writeFileSync(join(dir, 'doc.md'), '# Doc\n');
      return new DocNoticeLedger({
        projectDir: dir,
        contentDir: dir,
        getShadow: () => undefined,
        isReady: () => true,
        signal: () => {},
      });
    }

    test('a both-kept merge raises its notice with the block counts even when no history can be written', async () => {
      const notices = noticesIn(tmpDir);
      const history = createMergeHistoryRecorder({
        getShadow: () => undefined,
        contentRoot: '',
        getBranch: () => 'main',
        notices,
      });

      history.bothKept('doc', { ours: 'here\n', theirs: 'outside\n' }, [KEPT_TWICE, RESTORED]);

      expect(await notices.list('main')).toEqual([
        expect.objectContaining({
          docName: 'doc',
          kind: 'both-kept',
          kept: { duplicated: 1, restoredDeletedHere: 1, restoredDeletedOutside: 0 },
          entries: [],
        }),
      ]);
    });

    test('a both-kept notice points at the two history entries once they are written', async () => {
      const projectRoot = join(tmpDir, 'project');
      mkdirSync(projectRoot, { recursive: true });
      await simpleGit(projectRoot).init();
      configureTestGitRepository(projectRoot);
      const shadow = await initShadowRepo(projectRoot);
      const notices = noticesIn(projectRoot);
      const history = createMergeHistoryRecorder({
        getShadow: () => shadow,
        contentRoot: '',
        getBranch: () => 'main',
        notices,
      });

      history.bothKept('doc', { ours: 'here\n', theirs: 'outside\n' }, [KEPT_TWICE]);
      await vi.waitFor(() => expect(getMetrics().mergeHistoryCheckpointCreated).toBe(2));

      const shas = (
        await shadowGit(shadow).raw(
          'for-each-ref',
          '--format=%(objectname)',
          'refs/checkpoints/main/',
        )
      )
        .trim()
        .split('\n');
      const [notice] = await notices.list('main');
      expect([...(notice?.entries ?? [])].sort()).toEqual([...shas].sort());
    });

    test('a kept-live refusal raises its notice only when the outside version reached history', async () => {
      const failing = noticesIn(tmpDir);
      await createMergeHistoryRecorder({
        getShadow: () => ({ gitDir: join(tmpDir, 'missing-git-dir'), workTree: tmpDir }),
        contentRoot: '',
        getBranch: () => 'main',
        notices: failing,
      }).keptLive('doc', { side: 'theirs', bytes: 'outside\n' }, 'check-failed');
      expect(await failing.list('main')).toEqual([]);

      const projectRoot = join(tmpDir, 'project');
      mkdirSync(projectRoot, { recursive: true });
      await simpleGit(projectRoot).init();
      configureTestGitRepository(projectRoot);
      const shadow = await initShadowRepo(projectRoot);
      const notices = noticesIn(projectRoot);
      await createMergeHistoryRecorder({
        getShadow: () => shadow,
        contentRoot: '',
        getBranch: () => 'main',
        notices,
      }).keptLive('doc', { side: 'ours', bytes: 'parked\n' }, 'too-large');

      const sha = (
        await shadowGit(shadow).raw(
          'for-each-ref',
          '--format=%(objectname)',
          'refs/checkpoints/main/',
        )
      ).trim();
      expect(await notices.list('main')).toEqual([
        expect.objectContaining({
          kind: 'moved-to-history',
          side: 'ours',
          reason: 'too-large',
          entries: [sha],
        }),
      ]);
    });
  });
});
