import type { DerivedViewChannel } from '@inkeep/open-knowledge-core';
import {
  type BacklinkEntry,
  BacklinkIndex,
  type GraphNode,
  type HubEntry,
  isOrphanMode,
  type OrphanMode,
} from './backlink-index.ts';
import { isLinkIndexExcludedDoc, isManagedArtifactDoc } from './cc1-broadcast.ts';
import type { ContentFilter } from './content-filter.ts';
import { docNameToRelativePath } from './doc-extensions.ts';
import { getLogger } from './logger.ts';
import { TagIndex, type TagSummaryEntry } from './tag-index.ts';

const log = getLogger('derived-document-index');

const DERIVED_INDEX_SAVE_DEBOUNCE_MS = 2000;

export type DerivedDocumentRelationChannel = Extract<
  DerivedViewChannel,
  'backlinks' | 'graph' | 'tags'
>;

type ForwardLinkEntry = ReturnType<BacklinkIndex['getForwardLinkEntries']>[number];
type LinkGraph = ReturnType<BacklinkIndex['getLinkGraph']>;
type DeadLinkEntry = ReturnType<BacklinkIndex['getDeadLinks']>[number];
type TagDocMatch = ReturnType<TagIndex['getDocsForTagWithMatches']>[number];

export type DerivedGraphNode = GraphNode;
export type DerivedOrphanMode = OrphanMode;

export function isDerivedOrphanMode(value: unknown): value is DerivedOrphanMode {
  return typeof value === 'string' && isOrphanMode(value);
}

export interface DerivedIndexStartupBacklinksResult {
  deletedDocNames: readonly string[];
  backlinkIndexDegraded: boolean;
}

export interface DerivedIndexStartupSettlement {
  tagIndexDegraded: boolean;
}

export interface DerivedDocumentIndexBranchTransition {
  readonly branch: string;
}

export interface DerivedDocumentIndexLivePort {
  captureLiveUpdateToken(): number | null;
  recordLiveDocument(documentName: string, markdown: string, token: number): Promise<void>;
}

export interface DerivedDocumentIndexPersistencePort {
  recordDurableStore(documentName: string, markdown: string): Promise<void>;
}

export interface DerivedDocumentIndexTestPort {
  resetDocumentForTest(documentName: string): Promise<void>;
  rescanBacklinksForTest(): Promise<void>;
}

export type DerivedDocumentIndexMutation =
  | { kind: 'upsert'; documentName: string; markdown: string }
  | { kind: 'delete'; documentName: string }
  | {
      kind: 'rename';
      oldDocumentName: string;
      newDocumentName: string;
      markdown: string;
    }
  | { kind: 'link-rewrite'; documentName: string; markdown: string };

export interface DerivedDocumentIndexApiPort {
  readonly testOnly?: DerivedDocumentIndexTestPort;
  recordDirectMutations(mutations: readonly DerivedDocumentIndexMutation[]): Promise<void>;
  recordDirectDocument(documentName: string, markdown: string): Promise<void>;
  recordDirectDelete(documentName: string): Promise<void>;
  recordDirectRename(
    oldDocumentName: string,
    newDocumentName: string,
    markdown: string,
  ): Promise<void>;
  recordLinkRewrite(documentName: string, markdown: string): Promise<void>;
  getBacklinks(documentName: string): Promise<BacklinkEntry[]>;
  getBacklinkCount(documentName: string): Promise<number>;
  getBacklinkCounts(documentNames: readonly string[]): Promise<Record<string, number>>;
  getForwardLinkEntries(documentName: string): Promise<ForwardLinkEntry[]>;
  getLinkGraphNeighborhood(documentName: string, degrees: number): Promise<LinkGraph>;
  getLinkGraph(): Promise<LinkGraph>;
  getHubs(limit?: number): Promise<HubEntry[]>;
  getOrphans(documentNames: string[], mode: OrphanMode): Promise<string[]>;
  getDeadLinks(
    admittedDocuments: Iterable<string>,
    sourceDocumentNames?: readonly string[],
  ): Promise<DeadLinkEntry[]>;
  getIndexedDocNames(): Promise<string[]>;
  getAllTags(): Promise<TagSummaryEntry[]>;
  getDocsForTagWithMatches(tag: string): Promise<TagDocMatch[]>;
}

export interface DerivedDocumentIndexOptions {
  projectDir: string;
  contentDir: string;
  contentFilter: ContentFilter;
  getGlobalSkillRoots: () => string[];
  signalChannel: (channel: DerivedDocumentRelationChannel) => void;
}

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
}

interface BranchTransition extends DerivedDocumentIndexBranchTransition {
  barrier: Deferred;
}

function createDeferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

class DerivedDocumentIndexClosedError extends Error {
  constructor() {
    super('Derived document index is closed');
    this.name = 'DerivedDocumentIndexClosedError';
  }
}

export function isDerivedDocumentIndexClosedError(err: unknown): boolean {
  return err instanceof DerivedDocumentIndexClosedError;
}

export class DerivedDocumentIndex
  implements
    DerivedDocumentIndexApiPort,
    DerivedDocumentIndexLivePort,
    DerivedDocumentIndexPersistencePort
{
  readonly testOnly: DerivedDocumentIndexTestPort;

  private readonly backlinkIndex: BacklinkIndex;
  private readonly tagIndex: TagIndex;
  private readonly contentFilter: ContentFilter;
  private readonly getGlobalSkillRoots: () => string[];
  private readonly signalChannel: (channel: DerivedDocumentRelationChannel) => void;
  private readonly startupAdmission = createDeferred();
  private readonly readyBarrier = createDeferred();
  private tail: Promise<void> = Promise.resolve();
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private saveTagsOnNextDebounce = false;
  private branchTransition: BranchTransition | null = null;
  private startupBegun = false;
  private startupSettled = false;
  private liveUpdateToken = 0;
  private closed = false;
  private closePromise: Promise<void> | null = null;

  constructor(options: DerivedDocumentIndexOptions) {
    this.backlinkIndex = new BacklinkIndex({
      projectDir: options.projectDir,
      contentDir: options.contentDir,
      contentFilter: options.contentFilter,
    });
    this.tagIndex = new TagIndex({
      projectDir: options.projectDir,
      contentDir: options.contentDir,
      contentFilter: options.contentFilter,
    });
    this.contentFilter = options.contentFilter;
    this.getGlobalSkillRoots = options.getGlobalSkillRoots;
    this.signalChannel = options.signalChannel;
    this.testOnly = {
      resetDocumentForTest: (documentName) => this.resetDocumentForTest(documentName),
      rescanBacklinksForTest: () => this.rescanBacklinksForTest(),
    };
  }

  beginStartup(branch: string): { backlinksReady: Promise<DerivedIndexStartupBacklinksResult> } {
    this.assertOpen();
    if (this.startupBegun) {
      throw new Error('Derived document index startup has already begun');
    }
    this.startupBegun = true;
    this.backlinkIndex.switchBranch(branch);

    const backlinksReady = this.initializeBacklinks(branch);
    const tagsWarm = this.warmTags();
    this.tail = Promise.all([backlinksReady.then(() => undefined), tagsWarm]).then(() => undefined);
    this.startupAdmission.resolve();
    return { backlinksReady };
  }

  async settleStartupAfterWatcherSeed(): Promise<DerivedIndexStartupSettlement> {
    this.assertOpen();
    if (!this.startupBegun) {
      throw new Error('Derived document index startup has not begun');
    }
    if (this.startupSettled) {
      throw new Error('Derived document index startup has already settled');
    }
    this.startupSettled = true;

    try {
      return await this.enqueueInternal(async () => {
        try {
          const diff = await this.tagIndex.reconcileWithDisk();
          if (diff.added > 0 || diff.updated > 0 || diff.deleted > 0) {
            log.info(diff, '[tag-index] startup reconcile: offline changes applied');
          }
          await this.saveTagsLogOnly('startup');
          return { tagIndexDegraded: false };
        } catch (err) {
          log.error(
            { err },
            '[tag-index] startup reconcile failed; tag index updates incrementally via watcher events',
          );
          return { tagIndexDegraded: true };
        }
      });
    } finally {
      this.readyBarrier.resolve();
    }
  }

  async beginBranchSwitch(branch: string): Promise<DerivedDocumentIndexBranchTransition> {
    this.assertOpen();
    if (this.branchTransition) {
      throw new Error(`Derived document index branch switch already active`);
    }
    const transition: BranchTransition = { branch, barrier: createDeferred() };
    this.liveUpdateToken++;
    this.branchTransition = transition;
    this.cancelScheduledSave();

    try {
      await this.startupAdmission.promise;
      await this.readyBarrier.promise;
      this.assertOpen();
      await this.enqueueInternal(async () => {
        this.backlinkIndex.switchBranch(branch);
      });
      return transition;
    } catch (err) {
      this.releaseBranchTransition(transition);
      throw err;
    }
  }

  async settleBranchFromDisk(transition: DerivedDocumentIndexBranchTransition): Promise<void> {
    this.assertOpen();
    if (this.branchTransition !== transition) {
      throw new Error('No derived document index branch switch is active');
    }

    try {
      await this.enqueueInternal(async () => {
        const branch = transition.branch;
        const loaded = await this.backlinkIndex.loadFromDisk(branch);
        if (loaded) {
          const diff = await this.backlinkIndex.reconcileWithDisk(branch);
          if (diff.added > 0 || diff.updated > 0 || diff.deleted > 0) {
            log.info(diff, `[backlinks] branch-switch reconcile for ${branch}`);
          }
        } else {
          await this.backlinkIndex.rebuildFromDisk(branch);
        }
        let globalIngestFailed = false;
        let globalIngestFailure: unknown;
        try {
          await this.backlinkIndex.ingestGlobalSkillBundles(this.getGlobalSkillRoots(), branch);
        } catch (err) {
          globalIngestFailed = true;
          globalIngestFailure = err;
        }
        await this.saveBacklinksLogOnly('branch-switch', branch);

        try {
          const tagDiff = await this.tagIndex.reconcileWithDisk();
          if (tagDiff.added > 0 || tagDiff.updated > 0 || tagDiff.deleted > 0) {
            log.info(tagDiff, `[tag-index] branch-switch reconcile for ${branch}`);
          }
        } catch (err) {
          log.warn(
            { err, branch },
            '[tag-index] branch-switch reconcile failed; falling back to full rebuild',
          );
          await this.tagIndex.init();
        }
        await this.saveTagsLogOnly('branch-switch');
        if (globalIngestFailed) throw globalIngestFailure;
      });
    } finally {
      this.releaseBranchTransition(transition);
    }
  }

  abortBranchSwitch(transition: DerivedDocumentIndexBranchTransition | undefined): void {
    if (transition) this.releaseBranchTransition(transition);
  }

  captureLiveUpdateToken(): number | null {
    if (this.closed) return null;
    return this.liveUpdateToken;
  }

  recordLiveDocument(documentName: string, markdown: string, token: number): Promise<void> {
    if (this.closed || token !== this.liveUpdateToken) {
      return Promise.resolve();
    }
    return this.runCommand(async () => {
      if (token !== this.liveUpdateToken) return;
      this.updateBoth(documentName, markdown);
      this.signalAllRelations();
    });
  }

  recordDurableStore(documentName: string, markdown: string): Promise<void> {
    return this.runCommand(async () => {
      this.updateBacklinks(documentName, markdown);
      this.scheduleSave(false);
    });
  }

  recordDiskUpsert(documentName: string, markdown: string): Promise<void> {
    return this.runCommand(async () => {
      this.updateBoth(documentName, markdown);
      this.scheduleSave();
      this.signalAllRelations();
    });
  }

  recordDiskDelete(documentName: string): Promise<void> {
    return this.runCommand(async () => {
      this.deleteBoth(documentName);
      this.scheduleSave();
      this.signalAllRelations();
    });
  }

  recordDiskRename(
    oldDocumentName: string,
    newDocumentName: string,
    markdown: string,
  ): Promise<void> {
    return this.runCommand(async () => {
      this.renameBoth(oldDocumentName, newDocumentName, markdown);
      this.scheduleSave();
      this.signalAllRelations();
    });
  }

  recordDirectDocument(documentName: string, markdown: string): Promise<void> {
    return this.recordDirectMutations([{ kind: 'upsert', documentName, markdown }]);
  }

  recordDirectDelete(documentName: string): Promise<void> {
    return this.recordDirectMutations([{ kind: 'delete', documentName }]);
  }

  recordDirectRename(
    oldDocumentName: string,
    newDocumentName: string,
    markdown: string,
  ): Promise<void> {
    return this.recordDirectMutations([
      { kind: 'rename', oldDocumentName, newDocumentName, markdown },
    ]);
  }

  recordLinkRewrite(documentName: string, markdown: string): Promise<void> {
    return this.recordDirectMutations([{ kind: 'link-rewrite', documentName, markdown }]);
  }

  recordDirectMutations(mutations: readonly DerivedDocumentIndexMutation[]): Promise<void> {
    if (mutations.length === 0) return Promise.resolve();
    return this.runCommand(async () => {
      let tagsChanged = false;
      for (const mutation of mutations) {
        switch (mutation.kind) {
          case 'upsert':
            this.updateBoth(mutation.documentName, mutation.markdown);
            tagsChanged = true;
            break;
          case 'delete':
            this.deleteBoth(mutation.documentName);
            tagsChanged = true;
            break;
          case 'rename':
            this.renameBoth(mutation.oldDocumentName, mutation.newDocumentName, mutation.markdown);
            tagsChanged = true;
            break;
          case 'link-rewrite':
            this.updateBacklinks(mutation.documentName, mutation.markdown);
            break;
        }
      }

      if (tagsChanged) {
        await this.saveBothLogOnly('direct-batch');
        this.signalAllRelations();
      } else {
        await this.saveBacklinksLogOnly('direct-batch');
        this.signalBacklinks();
      }
    });
  }

  refreshGlobalSkillNodes(): Promise<void> {
    return this.runCommand(async () => {
      await this.backlinkIndex.ingestGlobalSkillBundles(this.getGlobalSkillRoots());
      this.signalBacklinks();
    });
  }

  refreshContentScope(): Promise<void> {
    return this.runCommand(async () => {
      const branch = this.backlinkIndex.getActiveBranch();
      await this.backlinkIndex.rebuildFromDisk(branch);
      let globalIngestFailed = false;
      let globalIngestFailure: unknown;
      try {
        await this.backlinkIndex.ingestGlobalSkillBundles(this.getGlobalSkillRoots(), branch);
      } catch (err) {
        globalIngestFailed = true;
        globalIngestFailure = err;
      }
      await this.tagIndex.init();
      await this.saveBothLogOnly('content-filter', branch);
      this.signalAllRelations();
      if (globalIngestFailed) throw globalIngestFailure;
    });
  }

  announceReadyViews(): void {
    // The server factory calls this only after startup settlement has resolved.
    this.assertOpen();
    this.signalAllRelations();
  }

  getBacklinks(documentName: string): Promise<BacklinkEntry[]> {
    return this.runQuery(() => this.backlinkIndex.getBacklinks(documentName));
  }

  getBacklinkCount(documentName: string): Promise<number> {
    return this.runQuery(() => this.backlinkIndex.getBacklinkCount(documentName));
  }

  getBacklinkCounts(documentNames: readonly string[]): Promise<Record<string, number>> {
    return this.runQuery(() =>
      Object.fromEntries(
        documentNames.map((documentName) => [
          documentName,
          this.backlinkIndex.getBacklinkCount(documentName),
        ]),
      ),
    );
  }

  getForwardLinkEntries(documentName: string): Promise<ForwardLinkEntry[]> {
    return this.runQuery(() => this.backlinkIndex.getForwardLinkEntries(documentName));
  }

  getLinkGraphNeighborhood(documentName: string, degrees: number): Promise<LinkGraph> {
    return this.runQuery(() => this.backlinkIndex.getLinkGraphNeighborhood(documentName, degrees));
  }

  getLinkGraph(): Promise<LinkGraph> {
    return this.runQuery(() => this.backlinkIndex.getLinkGraph());
  }

  getHubs(limit?: number): Promise<HubEntry[]> {
    return this.runQuery(() => this.backlinkIndex.getHubs(limit));
  }

  getOrphans(documentNames: string[], mode: OrphanMode): Promise<string[]> {
    return this.runQuery(() => this.backlinkIndex.getOrphans(documentNames, mode));
  }

  getDeadLinks(
    admittedDocuments: Iterable<string>,
    sourceDocumentNames?: readonly string[],
  ): Promise<DeadLinkEntry[]> {
    return this.runQuery(() =>
      this.backlinkIndex.getDeadLinks(admittedDocuments, sourceDocumentNames),
    );
  }

  getIndexedDocNames(): Promise<string[]> {
    return this.runQuery(() => this.backlinkIndex.getIndexedDocNames());
  }

  getAllTags(): Promise<TagSummaryEntry[]> {
    return this.runQuery(() => this.tagIndex.getAllTags());
  }

  getDocsForTagWithMatches(tag: string): Promise<TagDocMatch[]> {
    return this.runQuery(() => this.tagIndex.getDocsForTagWithMatches(tag));
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    const pendingSave = this.cancelScheduledSave();
    if (pendingSave !== null) {
      void this.enqueueInternal(() => this.saveScheduledCache(pendingSave, 'close-flush'));
    }
    this.closed = true;
    this.startupAdmission.resolve();
    this.readyBarrier.resolve();
    this.releaseBranchTransition(this.branchTransition);
    this.closePromise = this.tail
      .then(() => this.tagIndex.close())
      .then(
        () => undefined,
        () => undefined,
      );
    return this.closePromise;
  }

  private resetDocumentForTest(documentName: string): Promise<void> {
    return this.runCommand(async () => {
      this.deleteBoth(documentName);
      await this.saveBothLogOnly('test-reset');
      this.signalAllRelations();
    });
  }

  private rescanBacklinksForTest(): Promise<void> {
    return this.runCommand(async () => {
      const branch = this.backlinkIndex.getActiveBranch();
      await this.backlinkIndex.rebuildFromDisk(branch);
      await this.backlinkIndex.ingestGlobalSkillBundles(this.getGlobalSkillRoots(), branch);
      await this.saveBacklinksLogOnly('test-rescan', branch);
      this.signalBacklinks();
    });
  }

  private async initializeBacklinks(branch: string): Promise<DerivedIndexStartupBacklinksResult> {
    try {
      let deletedDocNames: readonly string[] = [];
      if (await this.backlinkIndex.loadFromDisk(branch)) {
        const diff = await this.backlinkIndex.reconcileWithDisk(branch);
        deletedDocNames = diff.deletedDocNames;
        if (diff.added > 0 || diff.updated > 0 || diff.deleted > 0) {
          log.info(
            { added: diff.added, updated: diff.updated, deleted: diff.deleted },
            '[backlinks] startup reconcile: offline changes applied',
          );
        }
      } else {
        await this.backlinkIndex.rebuildFromDisk(branch);
      }
      await this.ingestGlobalSkillNodesLogOnly(branch, 'startup');
      await this.saveBacklinksLogOnly('startup', branch);
      return { deletedDocNames, backlinkIndexDegraded: false };
    } catch (err) {
      log.error(
        { err, branch },
        '[backlinks] startup init failed; index will populate incrementally via watcher',
      );
      return { deletedDocNames: [], backlinkIndexDegraded: true };
    }
  }

  private async warmTags(): Promise<void> {
    try {
      if (await this.tagIndex.loadFromDisk()) {
        await this.tagIndex.reconcileWithDisk();
      } else {
        await this.tagIndex.init();
      }
    } catch (err) {
      log.warn(
        { err },
        '[derived-document-index] tag-index warm boot failed; continuing with stale or empty index',
      );
    }
  }

  private updateBoth(documentName: string, markdown: string): void {
    this.updateBacklinks(documentName, markdown);
    if (this.isAdmitted(documentName)) {
      this.tagIndex.updateDocumentFromMarkdown(documentName, markdown);
    } else {
      this.tagIndex.deleteDocument(documentName);
    }
  }

  private updateBacklinks(documentName: string, markdown: string): void {
    if (this.isAdmitted(documentName)) {
      this.backlinkIndex.updateDocumentFromMarkdown(documentName, markdown);
    } else {
      this.backlinkIndex.deleteDocument(documentName);
    }
  }

  private deleteBoth(documentName: string): void {
    this.backlinkIndex.deleteDocument(documentName);
    this.tagIndex.deleteDocument(documentName);
  }

  private renameBoth(oldDocumentName: string, newDocumentName: string, markdown: string): void {
    if (this.isAdmitted(newDocumentName)) {
      this.backlinkIndex.renameDocument(oldDocumentName, newDocumentName, markdown);
      this.tagIndex.renameDocument(oldDocumentName, newDocumentName, markdown);
    } else {
      this.backlinkIndex.deleteDocument(oldDocumentName);
      this.backlinkIndex.deleteDocument(newDocumentName);
      this.tagIndex.deleteDocument(oldDocumentName);
      this.tagIndex.deleteDocument(newDocumentName);
    }
  }

  private isAdmitted(documentName: string): boolean {
    if (isLinkIndexExcludedDoc(documentName)) return false;
    if (isManagedArtifactDoc(documentName)) return true;
    return !this.contentFilter.isExcluded(docNameToRelativePath(documentName));
  }

  private signalBacklinks(): void {
    this.signalChannel('backlinks');
    this.signalChannel('graph');
  }

  private signalAllRelations(): void {
    this.signalBacklinks();
    this.signalChannel('tags');
  }

  private scheduleSave(includeTags = true): void {
    const saveTags = this.saveTagsOnNextDebounce || includeTags;
    this.cancelScheduledSave();
    this.saveTagsOnNextDebounce = saveTags;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      const saveTags = this.saveTagsOnNextDebounce;
      this.saveTagsOnNextDebounce = false;
      void this.enqueueInternal(() => this.saveScheduledCache(saveTags, 'debounced')).catch(
        (err) => {
          log.warn({ err }, 'Failed to enqueue debounced derived-index cache save');
        },
      );
    }, DERIVED_INDEX_SAVE_DEBOUNCE_MS);
  }

  private cancelScheduledSave(): boolean | null {
    const pendingSave = this.saveTimer === null ? null : this.saveTagsOnNextDebounce;
    if (this.saveTimer !== null) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    this.saveTagsOnNextDebounce = false;
    return pendingSave;
  }

  private saveScheduledCache(includeTags: boolean, reason: string): Promise<void> {
    return includeTags
      ? this.saveBothLogOnly(reason)
      : this.saveBacklinksLogOnly(`${reason}-backlinks`);
  }

  private releaseBranchTransition(transition: DerivedDocumentIndexBranchTransition | null): void {
    const active = this.branchTransition;
    if (!transition || active !== transition) return;
    this.branchTransition = null;
    active.barrier.resolve();
  }

  private async saveBothLogOnly(reason: string, branch?: string): Promise<void> {
    await this.saveBacklinksLogOnly(reason, branch);
    await this.saveTagsLogOnly(reason);
  }

  private async saveBacklinksLogOnly(reason: string, branch?: string): Promise<void> {
    try {
      await this.backlinkIndex.saveToDisk(branch);
    } catch (err) {
      log.warn({ err, reason, branch }, 'Failed to persist backlink cache');
    }
  }

  private async saveTagsLogOnly(reason: string): Promise<void> {
    try {
      await this.tagIndex.saveToDisk();
    } catch (err) {
      log.warn({ err, reason }, 'Failed to persist tag snapshot');
    }
  }

  private async ingestGlobalSkillNodesLogOnly(branch: string, reason: string): Promise<void> {
    try {
      await this.backlinkIndex.ingestGlobalSkillBundles(this.getGlobalSkillRoots(), branch);
    } catch (err) {
      log.warn({ err, branch, reason }, 'Global skill bundle ingest failed');
    }
  }

  private async runCommand<T>(operation: () => Promise<T> | T): Promise<T> {
    this.assertOpen();
    await this.startupAdmission.promise;
    this.assertOpen();
    return this.enqueueAfterBranchAdmission(operation);
  }

  private async runQuery<T>(query: () => Promise<T> | T): Promise<T> {
    this.assertOpen();
    await this.startupAdmission.promise;
    await this.readyBarrier.promise;
    this.assertOpen();
    return this.enqueueAfterBranchAdmission(query);
  }

  private async enqueueAfterBranchAdmission<T>(operation: () => Promise<T> | T): Promise<T> {
    while (true) {
      const transition = this.branchTransition;
      if (!transition) {
        this.assertOpen();
        return this.enqueueInternal(() => {
          this.assertOpen();
          return operation();
        });
      }
      await transition.barrier.promise;
      this.assertOpen();
    }
  }

  private enqueueInternal<T>(operation: () => Promise<T> | T): Promise<T> {
    const run = this.tail.then(operation);
    this.tail = run.then(
      () => undefined,
      (err) => {
        if (isDerivedDocumentIndexClosedError(err)) {
          log.debug({ err }, 'Derived document index operation rejected after close');
        } else {
          log.warn({ err }, 'Derived document index operation failed; queue remains available');
        }
      },
    );
    return run;
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new DerivedDocumentIndexClosedError();
    }
  }
}
