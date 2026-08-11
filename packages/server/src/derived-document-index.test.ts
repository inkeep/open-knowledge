import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { BacklinkIndex } from './backlink-index.ts';
import { createContentFilter } from './content-filter.ts';
import {
  DerivedDocumentIndex,
  isDerivedDocumentIndexClosedError,
} from './derived-document-index.ts';
import { LocalTargetIndex } from './local-target-index.ts';
import type { WatcherLocalTargetInventory } from './local-target-inventory.ts';
import { getLogger } from './logger.ts';
import { TagIndex } from './tag-index.ts';

interface Rig {
  projectDir: string;
  contentDir: string;
  contentFilter: ReturnType<typeof createContentFilter>;
  signals: string[];
  index: DerivedDocumentIndex;
}

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
}

const cleanups: Array<() => Promise<void>> = [];

function createDeferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function createRig(
  getLocalTargetInventory?: () => WatcherLocalTargetInventory | null,
  onRecoveredFileTarget?: (relativePath: string, exists: boolean) => void,
): Rig {
  const projectDir = mkdtempSync(join(tmpdir(), 'ok-derived-index-'));
  const contentDir = join(projectDir, 'content');
  mkdirSync(contentDir, { recursive: true });
  const signals: string[] = [];
  const contentFilter = createContentFilter({ projectDir, contentDir });
  const index = new DerivedDocumentIndex({
    projectDir,
    contentDir,
    contentFilter,
    getGlobalSkillRoots: () => [],
    signalChannel: (channel) => signals.push(channel),
    ...(getLocalTargetInventory ? { getLocalTargetInventory } : {}),
    ...(onRecoveredFileTarget ? { onRecoveredFileTarget } : {}),
  });
  cleanups.push(async () => {
    await index.close();
    rmSync(projectDir, { recursive: true, force: true });
  });
  return { projectDir, contentDir, contentFilter, signals, index };
}

function writeDoc(rig: Rig, relativePath: string, markdown: string): void {
  const filePath = join(rig.contentDir, relativePath);
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, markdown);
}

async function settleStartup(rig: Rig): Promise<void> {
  const startup = rig.index.beginStartup('main');
  await startup.backlinksReady;
  await rig.index.settleStartupAfterWatcherSeed();
  rig.signals.length = 0;
}

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

describe('DerivedDocumentIndex', () => {
  test('direct documents update links and tags before returning and signal B/G/T', async () => {
    const rig = createRig();
    await settleStartup(rig);

    await rig.index.recordDirectDocument(
      'source',
      '---\ntags: [project/active]\n---\nSee [[target]].\n',
    );

    expect(await rig.index.getBacklinks('target')).toEqual([
      expect.objectContaining({ source: 'source' }),
    ]);
    expect(await rig.index.getBacklinkCounts(['target', 'missing'])).toEqual({
      target: 1,
      missing: 0,
    });
    expect(await rig.index.getDocsForTagWithMatches('project')).toEqual([
      { docName: 'source', matchingTags: ['project/active'] },
    ]);
    expect(rig.signals).toEqual(['backlinks', 'graph', 'tags']);
  });

  test('direct batches mutate in order with one cache save and one B/G/T signal set', async () => {
    const backlinkSave = vi.spyOn(BacklinkIndex.prototype, 'saveToDisk');
    const tagSave = vi.spyOn(TagIndex.prototype, 'saveToDisk');
    const rig = createRig();
    await settleStartup(rig);
    backlinkSave.mockClear();
    tagSave.mockClear();

    await rig.index.recordDirectMutations([
      { kind: 'upsert', documentName: 'first', markdown: 'See [[old]]. #old\n' },
      {
        kind: 'rename',
        oldDocumentName: 'first',
        newDocumentName: 'second',
        markdown: 'See [[target]]. #moved\n',
      },
      {
        kind: 'link-rewrite',
        documentName: 'second',
        markdown: 'See [[rewritten]]. #ignored\n',
      },
      { kind: 'delete', documentName: 'missing' },
    ]);

    expect(await rig.index.getBacklinks('old')).toEqual([]);
    expect(await rig.index.getBacklinks('target')).toEqual([]);
    expect((await rig.index.getBacklinks('rewritten')).map((entry) => entry.source)).toEqual([
      'second',
    ]);
    expect(await rig.index.getDocsForTagWithMatches('moved')).toEqual([
      { docName: 'second', matchingTags: ['moved'] },
    ]);
    expect(await rig.index.getDocsForTagWithMatches('ignored')).toEqual([]);
    expect(backlinkSave).toHaveBeenCalledTimes(1);
    expect(tagSave).toHaveBeenCalledTimes(1);
    expect(rig.signals).toEqual(['backlinks', 'graph', 'tags']);
  });

  test('empty direct batches are immediate no-ops across readiness, branch, and close gates', async () => {
    const rig = createRig();

    await expect(rig.index.recordDirectMutations([])).resolves.toBeUndefined();
    await settleStartup(rig);
    const transition = await rig.index.beginBranchSwitch('feature');
    await expect(rig.index.recordDirectMutations([])).resolves.toBeUndefined();
    rig.index.abortBranchSwitch(transition);
    await rig.index.close();
    await expect(rig.index.recordDirectMutations([])).resolves.toBeUndefined();
    expect(rig.signals).toEqual([]);
  });

  test('live documents do not persist caches but preserve backlink-first paired updates', async () => {
    const backlinkSave = vi.spyOn(BacklinkIndex.prototype, 'saveToDisk');
    const tagSave = vi.spyOn(TagIndex.prototype, 'saveToDisk');
    const rig = createRig();
    await settleStartup(rig);
    backlinkSave.mockClear();
    tagSave.mockClear();

    const token = rig.index.captureLiveUpdateToken();
    expect(token).not.toBeNull();
    await rig.index.recordLiveDocument('source', 'See [[target]]. #live\n', token ?? -1);

    expect(await rig.index.getBacklinks('target')).toHaveLength(1);
    expect(await rig.index.getDocsForTagWithMatches('live')).toHaveLength(1);
    expect(backlinkSave).not.toHaveBeenCalled();
    expect(tagSave).not.toHaveBeenCalled();
    expect(rig.signals).toEqual(['backlinks', 'graph', 'tags']);
  });

  test('an ignored incremental document removes existing link and tag memberships', async () => {
    const rig = createRig();
    await settleStartup(rig);
    await rig.index.recordDirectDocument('ignored', 'See [[target]]. #hidden\n');
    rig.signals.length = 0;
    writeFileSync(join(rig.projectDir, '.okignore'), 'content/ignored.md\n');
    const rebuilt = await rig.contentFilter.rebuildIgnorePatterns();
    expect(rebuilt.ok).toBe(true);

    await rig.index.recordDirectDocument('ignored', 'See [[target]]. #hidden\n');

    expect(await rig.index.getBacklinks('target')).toEqual([]);
    expect(await rig.index.getDocsForTagWithMatches('hidden')).toEqual([]);
    expect(rig.signals).toEqual(['backlinks', 'graph', 'tags']);
  });

  test('system and config docs are excluded while managed artifacts remain admitted', async () => {
    const rig = createRig();
    await settleStartup(rig);

    await rig.index.recordDirectDocument('__system__', 'See [[target]]. #internal\n');
    await rig.index.recordDirectDocument('__config__/project', 'See [[target]]. #internal\n');
    await rig.index.recordDirectDocument(
      '__template__/notes/lifecycle',
      'See [[target]]. #managed\n',
    );

    expect((await rig.index.getBacklinks('target')).map((entry) => entry.source)).toEqual([
      '__template__/notes/lifecycle',
    ]);
    expect(await rig.index.getDocsForTagWithMatches('internal')).toEqual([]);
    expect(await rig.index.getDocsForTagWithMatches('managed')).toEqual([
      { docName: '__template__/notes/lifecycle', matchingTags: ['managed'] },
    ]);
    expect(await rig.index.getIndexedDocNames()).not.toContain('__system__');
    expect(await rig.index.getIndexedDocNames()).not.toContain('__config__/project');
  });

  test('durable stores update and persist backlinks without changing tags or signaling', async () => {
    vi.useFakeTimers();
    const backlinkSave = vi.spyOn(BacklinkIndex.prototype, 'saveToDisk');
    const tagSave = vi.spyOn(TagIndex.prototype, 'saveToDisk');
    const rig = createRig();
    await settleStartup(rig);
    backlinkSave.mockClear();
    tagSave.mockClear();

    await rig.index.recordDurableStore('source', 'See [[target]]. #durable\n');

    expect(await rig.index.getBacklinks('target')).toHaveLength(1);
    expect(await rig.index.getDocsForTagWithMatches('durable')).toEqual([]);
    expect(backlinkSave).not.toHaveBeenCalled();
    expect(tagSave).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(2000);

    expect(backlinkSave).toHaveBeenCalledTimes(1);
    expect(tagSave).not.toHaveBeenCalled();
    expect(rig.signals).toEqual([]);
  });

  test('disk events debounce paired cache saves while applying and signaling immediately', async () => {
    vi.useFakeTimers();
    const backlinkSave = vi.spyOn(BacklinkIndex.prototype, 'saveToDisk');
    const tagSave = vi.spyOn(TagIndex.prototype, 'saveToDisk');
    const rig = createRig();
    await settleStartup(rig);
    backlinkSave.mockClear();
    tagSave.mockClear();

    await rig.index.recordDiskUpsert('source', 'See [[first]]. #one\n');
    await rig.index.recordDiskUpsert('source', 'See [[second]]. #two\n');

    expect(await rig.index.getBacklinks('first')).toEqual([]);
    expect(await rig.index.getBacklinks('second')).toHaveLength(1);
    expect(await rig.index.getDocsForTagWithMatches('two')).toHaveLength(1);
    expect(backlinkSave).not.toHaveBeenCalled();
    expect(tagSave).not.toHaveBeenCalled();

    await rig.index.recordDiskRename('source', 'renamed', 'See [[third]]. #three\n');
    await rig.index.recordDiskDelete('renamed');

    expect(await rig.index.getBacklinks('second')).toEqual([]);
    expect(await rig.index.getBacklinks('third')).toEqual([]);
    expect(await rig.index.getDocsForTagWithMatches('two')).toEqual([]);
    expect(await rig.index.getDocsForTagWithMatches('three')).toEqual([]);

    await vi.advanceTimersByTimeAsync(2000);
    await rig.index.getIndexedDocNames();

    expect(backlinkSave).toHaveBeenCalledTimes(1);
    expect(tagSave).toHaveBeenCalledTimes(1);
    expect(rig.signals).toEqual([
      'backlinks',
      'graph',
      'tags',
      'backlinks',
      'graph',
      'tags',
      'backlinks',
      'graph',
      'tags',
      'backlinks',
      'graph',
      'tags',
    ]);
  });

  test('link rewrites are backlink-only and retain existing tag membership', async () => {
    const rig = createRig();
    await settleStartup(rig);
    await rig.index.recordDirectDocument('source', 'See [[old]]. #stable\n');
    rig.signals.length = 0;

    await rig.index.recordLinkRewrite('source', 'See [[new]]. #changed\n');

    expect(await rig.index.getBacklinks('old')).toEqual([]);
    expect(await rig.index.getBacklinks('new')).toHaveLength(1);
    expect(await rig.index.getDocsForTagWithMatches('stable')).toHaveLength(1);
    expect(await rig.index.getDocsForTagWithMatches('changed')).toEqual([]);
    expect(rig.signals).toEqual(['backlinks', 'graph']);
  });

  test('direct rename moves link and tag membership atomically', async () => {
    const rig = createRig();
    await settleStartup(rig);
    await rig.index.recordDirectDocument('old', 'See [[target]]. #moved\n');
    rig.signals.length = 0;

    await rig.index.recordDirectRename('old', 'new', 'See [[target]]. #moved\n');

    expect((await rig.index.getBacklinks('target')).map((entry) => entry.source)).toEqual(['new']);
    expect(await rig.index.getDocsForTagWithMatches('moved')).toEqual([
      { docName: 'new', matchingTags: ['moved'] },
    ]);
    expect(rig.signals).toEqual(['backlinks', 'graph', 'tags']);
  });

  test('queries wait for post-watcher startup settlement', async () => {
    const rig = createRig();
    writeDoc(rig, 'source.md', 'See [[target]].\n');
    const startup = rig.index.beginStartup('main');
    let settled = false;
    const query = rig.index.getBacklinks('target').then((entries) => {
      settled = true;
      return entries;
    });

    await startup.backlinksReady;
    await Promise.resolve();
    expect(settled).toBe(false);

    await rig.index.settleStartupAfterWatcherSeed();
    await expect(query).resolves.toHaveLength(1);
  });

  test('branch transitions hold new commands until the replacement indexes settle', async () => {
    const rig = createRig();
    await settleStartup(rig);
    const transition = await rig.index.beginBranchSwitch('feature');
    let applied = false;
    let queried = false;
    const pending = rig.index.recordDirectDocument('after-switch', '# branch\n').then(() => {
      applied = true;
    });
    const pendingQuery = rig.index.getIndexedDocNames().then(() => {
      queried = true;
    });

    await Promise.resolve();
    expect(applied).toBe(false);
    expect(queried).toBe(false);

    await rig.index.settleBranchFromDisk(transition);
    await Promise.all([pending, pendingQuery]);
    expect(applied).toBe(true);
    expect(queried).toBe(true);
  });

  test('branch transitions invalidate stale live payloads captured from the old branch', async () => {
    const rig = createRig();
    await settleStartup(rig);
    await rig.index.recordDirectDocument('old-doc', 'See [[target]]. #old-tag\n');
    const staleToken = rig.index.captureLiveUpdateToken();
    expect(staleToken).not.toBeNull();

    const transition = await rig.index.beginBranchSwitch('feature');
    const targetBranchToken = rig.index.captureLiveUpdateToken();
    expect(targetBranchToken).not.toBeNull();
    expect(targetBranchToken).not.toBe(staleToken);
    await rig.index.settleBranchFromDisk(transition);
    await rig.index.recordLiveDocument('old-doc', 'See [[target]]. #old-tag\n', staleToken ?? -1);

    expect(await rig.index.getBacklinks('target')).toEqual([]);
    expect(await rig.index.getDocsForTagWithMatches('old-tag')).toEqual([]);
  });

  test('live mutations captured during a branch transition wait and apply to the target branch', async () => {
    const rig = createRig();
    await settleStartup(rig);
    const transition = await rig.index.beginBranchSwitch('feature');
    const token = rig.index.captureLiveUpdateToken();
    expect(token).not.toBeNull();
    let mutationSettled = false;
    let querySettled = false;
    const mutation = rig.index
      .recordLiveDocument('target-live', 'See [[target]]. #target-live\n', token ?? -1)
      .then(() => {
        mutationSettled = true;
      });
    const query = rig.index.getBacklinks('target').then((entries) => {
      querySettled = true;
      return entries;
    });

    await Promise.resolve();
    expect(mutationSettled).toBe(false);
    expect(querySettled).toBe(false);

    await rig.index.settleBranchFromDisk(transition);
    await expect(mutation).resolves.toBeUndefined();
    await expect(query).resolves.toEqual([expect.objectContaining({ source: 'target-live' })]);
    expect(await rig.index.getDocsForTagWithMatches('target-live')).toHaveLength(1);
  });

  test('backlink failure short-circuits tags and signals without poisoning the queue', async () => {
    const rig = createRig();
    await settleStartup(rig);
    const warn = vi.spyOn(getLogger('derived-document-index'), 'warn');
    const update = vi
      .spyOn(BacklinkIndex.prototype, 'updateDocumentFromMarkdown')
      .mockImplementationOnce(() => {
        throw new Error('injected projection failure');
      });
    const updateTags = vi.spyOn(TagIndex.prototype, 'updateDocumentFromMarkdown');

    await expect(rig.index.recordDirectDocument('failed', '# failed\n')).rejects.toThrow(
      'injected projection failure',
    );
    expect(updateTags).not.toHaveBeenCalled();
    expect(rig.signals).toEqual([]);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      'Derived document index operation failed; queue remains available',
    );
    update.mockRestore();

    await expect(
      rig.index.recordDirectDocument('recovered', 'See [[target]].\n'),
    ).resolves.toBeUndefined();
    expect(updateTags).toHaveBeenCalledTimes(1);
    expect(await rig.index.getBacklinks('target')).toHaveLength(1);
  });

  test('refreshContentScope gates later mutations and queries until both replacements settle', async () => {
    const rig = createRig();
    await settleStartup(rig);
    const backlinksReplacement = createDeferred();
    const tagsReplacement = createDeferred();
    vi.spyOn(BacklinkIndex.prototype, 'rebuildFromDisk').mockImplementationOnce(
      async () => backlinksReplacement.promise,
    );
    const tagInit = vi
      .spyOn(TagIndex.prototype, 'init')
      .mockImplementationOnce(async () => tagsReplacement.promise);

    const refresh = rig.index.refreshContentScope();
    let mutationSettled = false;
    let querySettled = false;
    const mutation = rig.index.recordDurableStore('after-refresh', '# refreshed\n').then(() => {
      mutationSettled = true;
    });
    const query = rig.index.getIndexedDocNames().then(() => {
      querySettled = true;
    });

    await Promise.resolve();
    expect(mutationSettled).toBe(false);
    expect(querySettled).toBe(false);
    expect(rig.signals).toEqual([]);

    backlinksReplacement.resolve();
    await vi.waitFor(() => expect(tagInit).toHaveBeenCalledTimes(1));
    expect(mutationSettled).toBe(false);
    expect(querySettled).toBe(false);
    expect(rig.signals).toEqual([]);

    tagsReplacement.resolve();
    await Promise.all([refresh, mutation, query]);
    expect(mutationSettled).toBe(true);
    expect(querySettled).toBe(true);
    expect(rig.signals).toEqual(['backlinks', 'graph', 'tags']);
  });

  test('content-scope refresh surfaces global ingest failure and the queue recovers', async () => {
    const rig = createRig();
    await settleStartup(rig);
    writeDoc(rig, 'hidden.md', 'See [[target]]. #hidden\n');
    await rig.index.recordDirectDocument('hidden', 'See [[target]]. #hidden\n');
    writeFileSync(join(rig.projectDir, '.okignore'), 'content/hidden.md\n');
    const rebuilt = await rig.contentFilter.rebuildIgnorePatterns();
    expect(rebuilt.ok).toBe(true);
    rig.signals.length = 0;
    vi.spyOn(BacklinkIndex.prototype, 'ingestGlobalSkillBundles').mockRejectedValueOnce(
      new Error('global ingest failed'),
    );

    await expect(rig.index.refreshContentScope()).rejects.toThrow('global ingest failed');
    expect(await rig.index.getBacklinks('target')).toEqual([]);
    expect(await rig.index.getDocsForTagWithMatches('hidden')).toEqual([]);
    expect(rig.signals).toEqual(['backlinks', 'graph', 'tags']);

    await expect(
      rig.index.recordDirectDocument('recovered', 'See [[target]]. #recovered\n'),
    ).resolves.toBeUndefined();
    expect(await rig.index.getBacklinks('target')).toHaveLength(1);
    expect(await rig.index.getDocsForTagWithMatches('recovered')).toHaveLength(1);
  });

  test('test rescan surfaces global ingest failure and leaves the queue available', async () => {
    const rig = createRig();
    await settleStartup(rig);
    vi.spyOn(BacklinkIndex.prototype, 'ingestGlobalSkillBundles').mockRejectedValueOnce(
      new Error('rescan global ingest failed'),
    );

    await expect(rig.index.testOnly.rescanBacklinksForTest()).rejects.toThrow(
      'rescan global ingest failed',
    );
    expect(rig.signals).toEqual([]);

    await expect(
      rig.index.recordDirectDocument('recovered', 'See [[target]].\n'),
    ).resolves.toBeUndefined();
    expect(await rig.index.getBacklinks('target')).toHaveLength(1);
  });

  test('branch settlement rebuilds, ingests global nodes, then saves and falls back for tags', async () => {
    const rig = createRig();
    await settleStartup(rig);
    const transition = await rig.index.beginBranchSwitch('feature');
    const load = vi.spyOn(BacklinkIndex.prototype, 'loadFromDisk').mockResolvedValueOnce(false);
    const rebuild = vi
      .spyOn(BacklinkIndex.prototype, 'rebuildFromDisk')
      .mockResolvedValueOnce(undefined);
    const ingest = vi
      .spyOn(BacklinkIndex.prototype, 'ingestGlobalSkillBundles')
      .mockResolvedValueOnce(undefined);
    const backlinkSave = vi
      .spyOn(BacklinkIndex.prototype, 'saveToDisk')
      .mockResolvedValueOnce(undefined);
    const reconcileTags = vi
      .spyOn(TagIndex.prototype, 'reconcileWithDisk')
      .mockRejectedValueOnce(new Error('reconcile failed'));
    const rebuildTags = vi.spyOn(TagIndex.prototype, 'init').mockResolvedValueOnce(undefined);
    const tagSave = vi.spyOn(TagIndex.prototype, 'saveToDisk').mockResolvedValueOnce(undefined);

    await rig.index.settleBranchFromDisk(transition);

    expect(load).toHaveBeenCalledWith('feature');
    expect(rebuild).toHaveBeenCalledWith('feature');
    expect(ingest).toHaveBeenCalledWith([], 'feature');
    expect(rebuild.mock.invocationCallOrder[0]).toBeLessThan(
      ingest.mock.invocationCallOrder[0] ?? 0,
    );
    expect(ingest.mock.invocationCallOrder[0]).toBeLessThan(
      backlinkSave.mock.invocationCallOrder[0] ?? 0,
    );
    expect(reconcileTags).toHaveBeenCalledTimes(1);
    expect(rebuildTags).toHaveBeenCalledTimes(1);
    expect(tagSave).toHaveBeenCalledTimes(1);
  });

  test('branch settlement reconciles a warm cache before global ingest and save', async () => {
    const rig = createRig();
    await settleStartup(rig);
    const transition = await rig.index.beginBranchSwitch('warm');
    vi.spyOn(BacklinkIndex.prototype, 'loadFromDisk').mockResolvedValueOnce(true);
    const reconcile = vi.spyOn(BacklinkIndex.prototype, 'reconcileWithDisk').mockResolvedValueOnce({
      added: 0,
      updated: 0,
      deleted: 0,
      deletedDocNames: [],
    });
    const ingest = vi
      .spyOn(BacklinkIndex.prototype, 'ingestGlobalSkillBundles')
      .mockResolvedValueOnce(undefined);
    const save = vi.spyOn(BacklinkIndex.prototype, 'saveToDisk').mockResolvedValueOnce(undefined);

    await rig.index.settleBranchFromDisk(transition);

    expect(reconcile.mock.invocationCallOrder[0]).toBeLessThan(
      ingest.mock.invocationCallOrder[0] ?? 0,
    );
    expect(ingest.mock.invocationCallOrder[0]).toBeLessThan(save.mock.invocationCallOrder[0] ?? 0);
  });

  test('branch global-ingest failure still replaces local indexes and releases callers', async () => {
    const rig = createRig();
    writeDoc(rig, 'old.md', '# Old\n\n#old-branch\n');
    await settleStartup(rig);
    unlinkSync(join(rig.contentDir, 'old.md'));
    writeDoc(rig, 'target.md', '# Target\n\n#target-branch\n');
    const transition = await rig.index.beginBranchSwitch('feature');
    vi.spyOn(BacklinkIndex.prototype, 'ingestGlobalSkillBundles').mockRejectedValueOnce(
      new Error('branch global ingest failed'),
    );
    const query = rig.index.getDocsForTagWithMatches('target-branch');

    await expect(rig.index.settleBranchFromDisk(transition)).rejects.toThrow(
      'branch global ingest failed',
    );
    await expect(query).resolves.toEqual([{ docName: 'target', matchingTags: ['target-branch'] }]);
    expect(await rig.index.getDocsForTagWithMatches('old-branch')).toEqual([]);
  });

  test('beginBranchSwitch cancels an old-branch save timer before changing scope', async () => {
    vi.useFakeTimers();
    const backlinkSave = vi.spyOn(BacklinkIndex.prototype, 'saveToDisk');
    const tagSave = vi.spyOn(TagIndex.prototype, 'saveToDisk');
    const rig = createRig();
    await settleStartup(rig);
    await rig.index.recordDiskUpsert('old-branch', '# old\n');

    const transition = await rig.index.beginBranchSwitch('feature');
    await rig.index.settleBranchFromDisk(transition);
    backlinkSave.mockClear();
    tagSave.mockClear();
    await vi.advanceTimersByTimeAsync(2000);

    expect(backlinkSave).not.toHaveBeenCalled();
    expect(tagSave).not.toHaveBeenCalled();
  });

  test('abortBranchSwitch releases only the transition owned by its caller', async () => {
    const rig = createRig();
    await settleStartup(rig);
    const transition = await rig.index.beginBranchSwitch('aborted');
    const mutation = rig.index.recordDirectDocument('released', '# released\n');
    const query = rig.index.getIndexedDocNames();
    let mutationSettled = false;
    void mutation.then(() => {
      mutationSettled = true;
    });

    rig.index.abortBranchSwitch({ branch: 'other' });
    await Promise.resolve();
    expect(mutationSettled).toBe(false);

    rig.index.abortBranchSwitch(transition);
    await expect(mutation).resolves.toBeUndefined();
    await expect(query).resolves.toBeInstanceOf(Array);
    await expect(rig.index.getIndexedDocNames()).resolves.toContain('released');
  });

  test('recognizes only coordinator close errors as lifecycle rejections', async () => {
    const rig = createRig();
    await rig.index.close();

    const closedError = await rig.index.getIndexedDocNames().catch((err: unknown) => err);

    expect(isDerivedDocumentIndexClosedError(closedError)).toBe(true);
    const sameName = new Error('lookalike');
    sameName.name = 'DerivedDocumentIndexClosedError';
    expect(isDerivedDocumentIndexClosedError(sameName)).toBe(false);
  });

  test('warm startup reports documents deleted while the server was down', async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'ok-derived-warm-'));
    const contentDir = join(projectDir, 'content');
    mkdirSync(contentDir, { recursive: true });
    writeFileSync(join(contentDir, 'stale.md'), '# stale\n');
    const contentFilter = createContentFilter({ projectDir, contentDir });
    const rawIndex = new BacklinkIndex({ projectDir, contentDir, contentFilter });
    await rawIndex.rebuildFromDisk('main');
    await rawIndex.saveToDisk('main');
    unlinkSync(join(contentDir, 'stale.md'));
    const index = new DerivedDocumentIndex({
      projectDir,
      contentDir,
      contentFilter,
      getGlobalSkillRoots: () => [],
      signalChannel: () => {},
    });
    cleanups.push(async () => {
      await index.close();
      rmSync(projectDir, { recursive: true, force: true });
    });

    const startup = index.beginStartup('main');

    await expect(startup.backlinksReady).resolves.toEqual({
      deletedDocNames: ['stale'],
      backlinkIndexDegraded: false,
    });
    await index.settleStartupAfterWatcherSeed();
  });

  test('degraded startup releases query readiness and reports index degradation', async () => {
    const warn = vi.spyOn(getLogger('derived-document-index'), 'warn');
    const rig = createRig();
    vi.spyOn(BacklinkIndex.prototype, 'loadFromDisk').mockRejectedValueOnce(
      new Error('broken backlink cache'),
    );
    vi.spyOn(TagIndex.prototype, 'loadFromDisk').mockRejectedValueOnce(
      new Error('broken tag cache'),
    );
    const startup = rig.index.beginStartup('main');
    await expect(startup.backlinksReady).resolves.toEqual({
      deletedDocNames: [],
      backlinkIndexDegraded: true,
    });
    vi.spyOn(TagIndex.prototype, 'reconcileWithDisk').mockRejectedValueOnce(
      new Error('broken tag scan'),
    );
    const query = rig.index.getIndexedDocNames();

    await expect(rig.index.settleStartupAfterWatcherSeed()).resolves.toEqual({
      tagIndexDegraded: true,
    });
    await expect(query).resolves.toEqual([]);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      '[derived-document-index] tag-index warm boot failed; continuing with stale or empty index',
    );
  });

  test('a startup graph pass with no file inventory keeps extension-less file hrefs as document edges', async () => {
    // The watcher never seeds (factory stays null), as when it fails outright:
    // the settlement reconcile has no inventory to consult either, so the
    // startup pass's document-shaped reading of `assets/NOTICE` persists.
    const rig = createRig(() => null);
    writeDoc(rig, 'src.md', 'See [notice](assets/NOTICE).\n');
    writeDoc(rig, 'assets/NOTICE', 'plain text\n');

    const startup = rig.index.beginStartup('main');
    await startup.backlinksReady;
    await rig.index.settleStartupAfterWatcherSeed();

    expect((await rig.index.getBacklinks('assets/NOTICE')).map((entry) => entry.source)).toEqual([
      'src',
    ]);
  });

  test('startup settlement re-derives the graph once the watcher inventory arrives', async () => {
    let inventory: WatcherLocalTargetInventory | null = null;
    const rig = createRig(() => inventory);
    writeDoc(rig, 'src.md', 'See [notice](assets/NOTICE).\n');
    writeDoc(rig, 'assets/NOTICE', 'plain text\n');

    const startup = rig.index.beginStartup('main');
    await startup.backlinksReady;
    // The real cold-boot ordering: the graph builds before the watcher seeds,
    // then the inventory exists by the time startup settles.
    inventory = { documentTargets: ['src'], fileTargets: ['assets/NOTICE'] };
    await rig.index.settleStartupAfterWatcherSeed();

    // The reconcile re-derived the graph against the inventory: the
    // extension-less href names an existing ordinary file, not a document.
    expect(await rig.index.getBacklinks('assets/NOTICE')).toEqual([]);
  });

  test('startup settlement re-derives a warm graph cache against the watcher inventory', async () => {
    let inventory: WatcherLocalTargetInventory | null = null;
    const rig = createRig(() => inventory);
    writeDoc(rig, 'src.md', 'See [notice](assets/NOTICE).\n');
    writeDoc(rig, 'assets/NOTICE', 'plain text\n');

    // Seed the persisted cache in the pre-inventory shape an older build or a
    // prior cold startup would have written. Its mtime snapshot is current, so
    // the warm reconcile legitimately has no changed document to re-parse.
    const cached = new BacklinkIndex({
      projectDir: rig.projectDir,
      contentDir: rig.contentDir,
      contentFilter: rig.contentFilter,
    });
    await cached.rebuildFromDisk('main');
    await cached.saveToDisk('main');
    expect(cached.getBacklinks('assets/NOTICE', 'main')).toHaveLength(1);

    const startup = rig.index.beginStartup('main');
    await startup.backlinksReady;
    inventory = { documentTargets: ['src'], fileTargets: ['assets/NOTICE'] };
    await rig.index.settleStartupAfterWatcherSeed();

    expect(await rig.index.getBacklinks('assets/NOTICE')).toEqual([]);
  });

  test('close flushes a pending paired save and rejects future commands', async () => {
    vi.useFakeTimers();
    const backlinkSave = vi.spyOn(BacklinkIndex.prototype, 'saveToDisk');
    const tagSave = vi.spyOn(TagIndex.prototype, 'saveToDisk');
    const rig = createRig();
    await settleStartup(rig);
    backlinkSave.mockClear();
    tagSave.mockClear();

    await rig.index.recordDiskUpsert('source', '# pending\n');
    const closing = rig.index.close();
    await expect(rig.index.recordDirectDelete('source')).rejects.toThrow(
      'Derived document index is closed',
    );
    await closing;
    await vi.advanceTimersByTimeAsync(2000);

    expect(backlinkSave).toHaveBeenCalledTimes(1);
    expect(tagSave).toHaveBeenCalledTimes(1);
  });

  test('close flushes a pending backlink-only durable-store save', async () => {
    vi.useFakeTimers();
    const backlinkSave = vi.spyOn(BacklinkIndex.prototype, 'saveToDisk');
    const tagSave = vi.spyOn(TagIndex.prototype, 'saveToDisk');
    const rig = createRig();
    await settleStartup(rig);
    backlinkSave.mockClear();
    tagSave.mockClear();

    await rig.index.recordDurableStore('source', 'See [[target]].\n');
    await rig.index.close();
    await vi.advanceTimersByTimeAsync(2000);

    expect(backlinkSave).toHaveBeenCalledTimes(1);
    expect(tagSave).not.toHaveBeenCalled();
  });

  test('repeated close calls wait for the same dependency drain', async () => {
    const rig = createRig();
    await settleStartup(rig);
    const tagClose = createDeferred();
    const closeTagIndex = vi
      .spyOn(TagIndex.prototype, 'close')
      .mockReturnValueOnce(tagClose.promise);

    const firstClose = rig.index.close();
    const secondClose = rig.index.close();
    let secondCloseSettled = false;
    void secondClose.then(() => {
      secondCloseSettled = true;
    });
    await Promise.resolve();

    expect(closeTagIndex).toHaveBeenCalledTimes(1);
    expect(secondCloseSettled).toBe(false);

    tagClose.resolve();
    await Promise.all([firstClose, secondClose]);
    expect(secondCloseSettled).toBe(true);
  });

  test('close rejects an already-admitted queued disk mutation before it can arm a timer', async () => {
    vi.useFakeTimers();
    const deferredSave = createDeferred();
    const backlinkSave = vi.spyOn(BacklinkIndex.prototype, 'saveToDisk');
    const tagSave = vi.spyOn(TagIndex.prototype, 'saveToDisk');
    const indexLog = getLogger('derived-document-index');
    const warn = vi.spyOn(indexLog, 'warn');
    const debug = vi.spyOn(indexLog, 'debug');
    const rig = createRig();
    await settleStartup(rig);
    backlinkSave.mockClear();
    tagSave.mockClear();
    backlinkSave.mockImplementationOnce(async () => deferredSave.promise);

    const running = rig.index.recordDirectDocument('running', '# running\n');
    await vi.waitFor(() => expect(backlinkSave).toHaveBeenCalledTimes(1));
    const queued = rig.index.recordDiskUpsert('queued', '# queued\n');
    await Promise.resolve();
    const closing = rig.index.close();
    deferredSave.resolve();

    await expect(running).resolves.toBeUndefined();
    await expect(queued).rejects.toThrow('Derived document index is closed');
    await closing;
    const tagSaveCallsAfterClose = tagSave.mock.calls.length;
    await vi.advanceTimersByTimeAsync(2000);

    expect(backlinkSave).toHaveBeenCalledTimes(1);
    expect(tagSave).toHaveBeenCalledTimes(tagSaveCallsAfterClose);
    expect(debug).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      'Derived document index operation rejected after close',
    );
    expect(warn).not.toHaveBeenCalledWith(
      expect.anything(),
      'Derived document index operation failed; queue remains available',
    );
  });

  test('close drains a debounced save already enqueued behind in-flight work', async () => {
    vi.useFakeTimers();
    const deferredSave = createDeferred();
    const backlinkSave = vi.spyOn(BacklinkIndex.prototype, 'saveToDisk');
    const rig = createRig();
    await settleStartup(rig);
    backlinkSave.mockClear();

    await rig.index.recordDiskUpsert('disk-event', '# disk\n');
    backlinkSave.mockImplementationOnce(async () => deferredSave.promise);
    const running = rig.index.recordDirectDocument('running', '# running\n');
    await vi.waitFor(() => expect(backlinkSave).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(2000);

    const closing = rig.index.close();
    deferredSave.resolve();
    await expect(running).resolves.toBeUndefined();
    await closing;

    expect(backlinkSave).toHaveBeenCalledTimes(2);
  });
});

describe('DerivedDocumentIndex local-target projection', () => {
  test('a source edit assesses local targets and signals local-targets alongside relations', async () => {
    const rig = createRig();
    await settleStartup(rig);

    await rig.index.recordDirectDocument('src', 'See [x](target) and [pdf](assets/f.pdf).\n');

    const assessments = await rig.index.getLocalTargetAssessments('src');
    expect(assessments.map((a) => [a.targetKind, a.resolvedTarget, a.status])).toEqual([
      ['document', 'target', 'missing'],
      ['file', 'assets/f.pdf', 'missing'],
    ]);
    // local-targets rides the relation signal set only because an assessment moved.
    expect(rig.signals).toEqual(['backlinks', 'graph', 'local-targets', 'tags']);
  });

  test('the batch source query returns every source, or a scoped subset, through the ready gate', async () => {
    const rig = createRig();
    await settleStartup(rig);
    await rig.index.recordDirectDocument('a', 'Download [pdf](assets/a.pdf).\n');
    await rig.index.recordDirectDocument('b', 'Download [pdf](assets/b.pdf).\n');

    const all = await rig.index.getLocalTargetAssessmentsForSources();
    expect(all.map((entry) => entry.source).sort()).toEqual(['a', 'b']);
    expect(all.flatMap((entry) => entry.assessments).every((a) => a.status === 'missing')).toBe(
      true,
    );

    // A source filter narrows enumeration to just those sources — the path a
    // folder/doc scope drives.
    const scoped = await rig.index.getLocalTargetAssessmentsForSources(['a']);
    expect(scoped.map((entry) => entry.source)).toEqual(['a']);
  });

  test('wiki-only and occurrence-free edits never signal local-targets or move its generation', async () => {
    const rig = createRig();
    await settleStartup(rig);
    const generation = await rig.index.getLocalTargetGeneration();

    await rig.index.recordDirectDocument('wiki', 'See [[target]]. #tagged\n');

    expect(rig.signals).toEqual(['backlinks', 'graph', 'tags']);
    expect(await rig.index.getLocalTargetGeneration()).toBe(generation);
    expect(await rig.index.getLocalTargetAssessments('wiki')).toEqual([]);
  });

  test('creating the target document heals the reference and re-signals', async () => {
    const rig = createRig();
    await settleStartup(rig);
    await rig.index.recordDirectDocument('src', 'See [x](target).\n');
    rig.signals.length = 0;

    await rig.index.recordDirectDocument('target', '# Target\n');

    expect((await rig.index.getLocalTargetAssessments('src'))[0]).toMatchObject({
      status: 'exact',
    });
    expect(rig.signals).toContain('local-targets');
    expect(await rig.index.getLocalTargetDocumentDependents('target')).toEqual(['src']);
  });

  test('ordinary-file target events heal and break references and signal only when a dependent moves', async () => {
    const rig = createRig();
    await settleStartup(rig);
    await rig.index.recordDirectDocument('src', 'Download [pdf](assets/report.pdf).\n');
    rig.signals.length = 0;

    await rig.index.recordFileTargetUpsert('assets/report.pdf');
    expect((await rig.index.getLocalTargetAssessments('src'))[0]).toMatchObject({
      status: 'exact',
    });
    expect(rig.signals).toEqual(['local-targets']);

    rig.signals.length = 0;
    await rig.index.recordFileTargetDelete('assets/report.pdf');
    expect((await rig.index.getLocalTargetAssessments('src'))[0]).toMatchObject({
      status: 'missing',
      reason: 'no-such-file',
    });
    expect(rig.signals).toEqual(['local-targets']);

    // An unreferenced file create moves nothing and stays silent.
    rig.signals.length = 0;
    await rig.index.recordFileTargetUpsert('assets/unreferenced.pdf');
    expect(rig.signals).toEqual([]);
  });

  test('the dependency-only sweep repairs file inventory in both missed-watcher directions', async () => {
    vi.useFakeTimers();
    const inventory: WatcherLocalTargetInventory = {
      documentTargets: ['source'],
      fileTargets: ['assets/report.pdf'],
    };
    const recovered: Array<{ relativePath: string; exists: boolean }> = [];
    const rig = createRig(
      () => inventory,
      (relativePath, exists) => recovered.push({ relativePath, exists }),
    );
    writeDoc(rig, 'source.md', 'Download [pdf](assets/report.pdf).\n');
    writeDoc(rig, 'assets/report.pdf', '%PDF-1.4\n');
    await settleStartup(rig);
    expect((await rig.index.getLocalTargetAssessments('source'))[0]).toMatchObject({
      status: 'exact',
    });

    unlinkSync(join(rig.contentDir, 'assets/report.pdf'));
    await vi.advanceTimersByTimeAsync(5000);

    expect((await rig.index.getLocalTargetAssessments('source'))[0]).toMatchObject({
      status: 'missing',
      reason: 'no-such-file',
    });
    expect(rig.signals).toEqual(['local-targets', 'files']);
    expect(recovered).toEqual([{ relativePath: 'assets/report.pdf', exists: false }]);

    rig.signals.length = 0;
    writeDoc(rig, 'assets/report.pdf', '%PDF-1.4 restored\n');
    await vi.advanceTimersByTimeAsync(5000);

    expect((await rig.index.getLocalTargetAssessments('source'))[0]).toMatchObject({
      status: 'exact',
    });
    expect(rig.signals).toEqual(['local-targets', 'files']);
    expect(recovered).toEqual([
      { relativePath: 'assets/report.pdf', exists: false },
      { relativePath: 'assets/report.pdf', exists: true },
    ]);
  });

  test('a canonical document rename invalidates old aliases and admits new aliases', async () => {
    let inventory: WatcherLocalTargetInventory = {
      documentTargets: ['source', 'canonical-old', 'old-alias'],
      fileTargets: [],
    };
    const rig = createRig(() => inventory);
    writeDoc(rig, 'source.md', 'See [old](old-alias) and [new](new-alias).\n');
    writeDoc(rig, 'canonical-old.md', '# Old\n');
    await settleStartup(rig);
    expect((await rig.index.getLocalTargetAssessments('source')).map((a) => a.status)).toEqual([
      'exact',
      'missing',
    ]);

    inventory = {
      documentTargets: ['source', 'canonical-new', 'new-alias'],
      fileTargets: [],
    };
    await rig.index.recordDirectRename('canonical-old', 'canonical-new', '# New\n');

    expect((await rig.index.getLocalTargetAssessments('source')).map((a) => a.status)).toEqual([
      'missing',
      'exact',
    ]);
  });

  test('an ordinary-file delete invalidates direct and directory-alias identities together', async () => {
    let inventory: WatcherLocalTargetInventory = {
      documentTargets: ['source'],
      fileTargets: ['canonical/data.csv', 'direct.csv', 'folder-alias/data.csv'],
    };
    const rig = createRig(() => inventory);
    writeDoc(
      rig,
      'source.md',
      '[canonical](canonical/data.csv) [direct](direct.csv) [folder](folder-alias/data.csv)\n',
    );
    await settleStartup(rig);
    expect(
      (await rig.index.getLocalTargetAssessments('source')).every((a) => a.status === 'exact'),
    ).toBe(true);

    inventory = { documentTargets: ['source'], fileTargets: [] };
    await rig.index.recordFileTargetDelete('canonical/data.csv');

    expect((await rig.index.getLocalTargetAssessments('source')).map((a) => a.status)).toEqual([
      'missing',
      'missing',
      'missing',
    ]);
  });

  test('a direct batch coalesces high-fanout source assessments into one local-targets signal', async () => {
    const rig = createRig();
    await settleStartup(rig);

    await rig.index.recordDirectMutations(
      Array.from({ length: 12 }, (_, i) => ({
        kind: 'upsert' as const,
        documentName: `dep-${i}`,
        markdown: 'Download [pdf](assets/shared.pdf).\n',
      })),
    );

    expect(rig.signals.filter((channel) => channel === 'local-targets')).toHaveLength(1);
    // One file create heals every dependent in the batch.
    expect(await rig.index.getLocalTargetFileDependents('assets/shared.pdf')).toHaveLength(12);
    expect(await rig.index.recordFileTargetUpsert('assets/shared.pdf')).toBeUndefined();
    for (let i = 0; i < 12; i++) {
      expect((await rig.index.getLocalTargetAssessments(`dep-${i}`))[0]).toMatchObject({
        status: 'exact',
      });
    }
  });

  test('local-target queries wait for post-watcher settlement rather than return a falsely clean result', async () => {
    const rig = createRig();
    writeDoc(rig, 'src.md', 'See [x](target).\n');
    const startup = rig.index.beginStartup('main');

    const pending = rig.index.getLocalTargetAssessments('src');
    let settled = false;
    void pending.then(() => {
      settled = true;
    });

    await startup.backlinksReady;
    await Promise.resolve();
    expect(settled).toBe(false);

    await rig.index.settleStartupAfterWatcherSeed();
    const assessments = await pending;
    expect(settled).toBe(true);
    // Seeded from disk: `target` does not exist, so the reference is missing, not absent.
    expect(assessments[0]).toMatchObject({ resolvedTarget: 'target', status: 'missing' });
  });

  test('local-target queries fail closed when the startup rebuild fails', async () => {
    const rig = createRig();
    writeDoc(rig, 'src.md', 'See [x](target).\n');
    vi.spyOn(LocalTargetIndex.prototype, 'rebuildFromDisk').mockRejectedValueOnce(
      new Error('forced local-target rebuild failure'),
    );

    const startup = rig.index.beginStartup('main');
    await startup.backlinksReady;
    await rig.index.settleStartupAfterWatcherSeed();

    await expect(rig.index.getIndexedDocNames()).resolves.toContain('src');
    await expect(rig.index.getLocalTargetAssessments('src')).rejects.toThrow(
      'Local-target index is not ready',
    );
    await expect(rig.index.getLocalTargetAssessmentsForSources()).rejects.toThrow(
      'Local-target index is not ready',
    );
  });

  test('a transient startup rebuild failure recovers on the scheduled retry', async () => {
    vi.useFakeTimers();
    const rig = createRig();
    writeDoc(rig, 'src.md', 'See [x](target).\n');
    vi.spyOn(LocalTargetIndex.prototype, 'rebuildFromDisk').mockRejectedValueOnce(
      new Error('transient rebuild failure'),
    );

    const startup = rig.index.beginStartup('main');
    await startup.backlinksReady;
    await rig.index.settleStartupAfterWatcherSeed();
    await expect(rig.index.getLocalTargetAssessments('src')).rejects.toThrow(
      'Local-target index is not ready',
    );

    await vi.advanceTimersByTimeAsync(1000);
    await expect(rig.index.getLocalTargetAssessments('src')).resolves.toEqual([
      expect.objectContaining({ resolvedTarget: 'target', status: 'missing' }),
    ]);
    expect(rig.signals).toContain('local-targets');
  });

  test('a branch switch reassesses against the new branch inventory', async () => {
    const rig = createRig();
    writeDoc(rig, 'src.md', 'See [x](target).\n');
    writeDoc(rig, 'target.md', '# Target\n');
    await settleStartup(rig);
    expect((await rig.index.getLocalTargetAssessments('src'))[0]).toMatchObject({
      status: 'exact',
    });

    // The new branch no longer has the target on disk.
    unlinkSync(join(rig.contentDir, 'target.md'));
    const transition = await rig.index.beginBranchSwitch('feature');
    await rig.index.settleBranchFromDisk(transition);

    expect((await rig.index.getLocalTargetAssessments('src'))[0]).toMatchObject({
      status: 'missing',
      reason: 'no-such-doc',
    });
  });
});
