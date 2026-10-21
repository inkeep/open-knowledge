import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseCheckpoint } from '@inkeep/open-knowledge-core/shadow-repo-layout';
import simpleGit from 'simple-git';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { configureTestGitRepository } from '../../../test-support/configure-git-fixture.test-helper.ts';
import { DocNoticeLedger } from './doc-notices.ts';
import { createMergeHistoryRecorder, keepNoEngineVersion } from './merge-history.ts';
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

  test('an outside version of a file with no merge engine lands in its own kind and counters, with full bytes', async () => {
    const projectRoot = join(tmpDir, 'project');
    mkdirSync(projectRoot, { recursive: true });
    await simpleGit(projectRoot).init();
    configureTestGitRepository(projectRoot);
    const shadow = await initShadowRepo(projectRoot);
    const outside = '{"type":"excalidraw","elements":[]}\n';

    await expect(
      recorderFor(shadow).saveNoEngine(
        'board.excalidraw',
        { side: 'theirs', bytes: outside },
        'excalidraw',
      ),
    ).resolves.toMatch(/^[0-9a-f]{40}$/);

    const sg = shadowGit(shadow);
    const sha = (
      await sg.raw('for-each-ref', '--format=%(objectname)', 'refs/checkpoints/main/')
    ).trim();
    expect(parseCheckpoint(await sg.raw('log', '-1', '--format=%B', sha))).toMatchObject({
      kind: 'external-change-no-engine',
      docName: 'board.excalidraw',
      metadata: { side: 'theirs', fileType: 'excalidraw' },
    });
    expect(await sg.raw('show', `${sha}:board.excalidraw`)).toBe(outside);
    expect(getMetrics().noEngineHistoryCheckpointCreated).toBe(1);
    expect(getMetrics().mergeHistoryCheckpointCreated).toBe(0);
  });

  test('a no-engine write with no shadow repo or a failing write resolves null', async () => {
    await expect(
      recorderFor(undefined).saveNoEngine('flow.mmd', { side: 'theirs', bytes: 'x\n' }, 'mermaid'),
    ).resolves.toBeNull();
    await expect(
      recorderFor({ gitDir: join(tmpDir, 'missing-git-dir'), workTree: tmpDir }).saveNoEngine(
        'flow.mmd',
        { side: 'theirs', bytes: 'x\n' },
        'mermaid',
      ),
    ).resolves.toBeNull();
    expect(getMetrics().mergeHistoryUnavailable).toBe(1);
    expect(getMetrics().noEngineHistoryCheckpointFailures).toBe(1);
    expect(getMetrics().noEngineHistoryCheckpointCreated).toBe(0);
  });

  test('a displaced settings edit and a refused outside settings file get their own notice reasons, naming history or the backup', async () => {
    const recorded: Array<{
      docName: string;
      kind: string;
      side: string;
      reason: string;
      at: string;
    }> = [];
    const history = createMergeHistoryRecorder({
      getShadow: () => ({ gitDir: tmpDir, workTree: tmpDir }),
      contentRoot: '',
      getBranch: () => 'main',
      writeCheckpoint: async () => 'd'.repeat(40),
      notices: {
        record: (docName, _branch, event) => {
          if (event.kind === 'moved-to-history') {
            recorded.push({
              docName,
              kind: event.kind,
              side: event.side,
              reason: event.reason,
              at: event.entry,
            });
          }
          if (event.kind === 'moved-to-backup') {
            recorded.push({
              docName,
              kind: event.kind,
              side: event.side,
              reason: event.reason,
              at: event.backup,
            });
          }
          return 'notice';
        },
        attachEntry: () => {},
        withdrawHeld: () => {},
      },
    });
    const entry = 'd'.repeat(40);
    const backup = {
      abs: '/home/me/.ok/edit-backups/discarded/flow.mmd/x.mmd',
      display: '~/.ok/edit-backups/discarded/flow.mmd/x.mmd',
    };

    history.noticeNoEngine('__config__/project', 'ours', 'config', { where: 'history', entry });
    history.noticeNoEngine('__config__/project', 'theirs', 'config', { where: 'history', entry });
    history.noticeNoEngine('flow.mmd', 'theirs', 'mermaid', { where: 'history', entry });
    history.noticeNoEngine('flow.mmd', 'theirs', 'mermaid', { where: 'backup', backup });

    expect(recorded).toEqual([
      {
        docName: '__config__/project',
        kind: 'moved-to-history',
        side: 'ours',
        reason: 'outside-settings-applied',
        at: entry,
      },
      {
        docName: '__config__/project',
        kind: 'moved-to-history',
        side: 'theirs',
        reason: 'outside-settings-invalid',
        at: entry,
      },
      {
        docName: 'flow.mmd',
        kind: 'moved-to-history',
        side: 'theirs',
        reason: 'no-merge-engine',
        at: entry,
      },
      {
        docName: 'flow.mmd',
        kind: 'moved-to-backup',
        side: 'theirs',
        reason: 'no-merge-engine',
        at: backup.display,
      },
    ]);
  });

  test('a no-engine version goes to history when it can, else to the backup folder, else nowhere', async () => {
    const home = join(tmpDir, 'home');
    mkdirSync(home, { recursive: true });
    const displaced = { side: 'theirs' as const, bytes: 'graph LR\n' };
    const saving = createMergeHistoryRecorder({
      getShadow: () => ({ gitDir: tmpDir, workTree: tmpDir }),
      contentRoot: '',
      getBranch: () => 'main',
      writeCheckpoint: async () => 'e'.repeat(40),
    });

    await expect(
      keepNoEngineVersion(
        saving,
        home,
        '/projects/one',
        'flow.mmd',
        displaced,
        'mermaid',
        'flow.mmd',
      ),
    ).resolves.toEqual({ where: 'history', entry: 'e'.repeat(40) });

    const kept = await keepNoEngineVersion(
      recorderFor(undefined),
      home,
      '/projects/one',
      'flow.mmd',
      displaced,
      'mermaid',
      'flow.mmd',
    );
    expect(kept).toMatchObject({
      where: 'backup',
      backup: {
        display: expect.stringMatching(
          /^~\/\.ok\/edit-backups\/discarded\/projects\/[0-9a-f]+\/flow\.mmd\/.+\.mmd$/,
        ),
      },
    });
    expect(kept?.where === 'backup' && readFileSync(kept.backup.abs, 'utf-8')).toBe('graph LR\n');

    writeFileSync(join(tmpDir, 'not-a-home'), 'file');
    await expect(
      keepNoEngineVersion(
        null,
        join(tmpDir, 'not-a-home'),
        '/projects/one',
        'flow.mmd',
        displaced,
        'mermaid',
        'flow.mmd',
      ),
    ).resolves.toBeNull();
    expect(getMetrics().displacedVersionBackups).toBe(1);
    expect(getMetrics().displacedVersionBackupFailures).toBe(1);
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

    test('a no-engine event raises a moved-to-history notice naming its entry once the entry exists', async () => {
      const projectRoot = join(tmpDir, 'project');
      mkdirSync(projectRoot, { recursive: true });
      await simpleGit(projectRoot).init();
      configureTestGitRepository(projectRoot);
      const shadow = await initShadowRepo(projectRoot);
      writeFileSync(join(projectRoot, 'flow.mmd'), 'graph TD\n');
      const notices = new DocNoticeLedger({
        projectDir: projectRoot,
        contentDir: projectRoot,
        getShadow: () => shadow,
        isReady: () => true,
        signal: () => {},
      });

      const history = createMergeHistoryRecorder({
        getShadow: () => shadow,
        contentRoot: '',
        getBranch: () => 'main',
        notices,
      });
      const copy = await keepNoEngineVersion(
        history,
        tmpDir,
        projectRoot,
        'flow.mmd',
        { side: 'theirs', bytes: 'graph LR\n' },
        'mermaid',
        'flow.mmd',
      );
      if (copy === null) throw new Error('expected the version to reach history');
      history.noticeNoEngine('flow.mmd', 'theirs', 'mermaid', copy);

      const sha = (
        await shadowGit(shadow).raw(
          'for-each-ref',
          '--format=%(objectname)',
          'refs/checkpoints/main/',
        )
      ).trim();
      expect(await notices.list('main')).toEqual([
        expect.objectContaining({
          docName: 'flow.mmd',
          file: 'flow.mmd',
          kind: 'moved-to-history',
          side: 'theirs',
          reason: 'no-merge-engine',
          entries: [sha],
        }),
      ]);
    });

    test('a held save raises its notice with the cause, and only a held notice is withdrawn when the save lands', async () => {
      const notices = noticesIn(tmpDir);
      const history = createMergeHistoryRecorder({
        getShadow: () => undefined,
        contentRoot: '',
        getBranch: () => 'main',
        notices,
      });

      history.noticeHeld('doc', 'not-utf8');
      expect(await notices.list('main')).toEqual([
        expect.objectContaining({ docName: 'doc', kind: 'save-held', cause: 'not-utf8' }),
      ]);

      history.clearHeld('doc');
      expect(await notices.list('main')).toEqual([]);

      history.bothKept('doc', { ours: 'here\n', theirs: 'outside\n' }, [KEPT_TWICE]);
      history.clearHeld('doc');
      expect(await notices.list('main')).toEqual([
        expect.objectContaining({ docName: 'doc', kind: 'both-kept' }),
      ]);
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
