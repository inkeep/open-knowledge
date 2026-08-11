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
import { recordIndexGenerationLag } from './index-telemetry.ts';
import type { LocalTargetAssessment } from './local-target-assessment.ts';
import {
  LocalTargetIndex,
  type LocalTargetIndexStats,
  type LocalTargetRebuildInventory,
  type LocalTargetSourceAssessments,
} from './local-target-index.ts';
import type { WatcherLocalTargetInventory } from './local-target-inventory.ts';
import { getLogger } from './logger.ts';
import { TagIndex, type TagSummaryEntry } from './tag-index.ts';

const log = getLogger('derived-document-index');

const DERIVED_INDEX_SAVE_DEBOUNCE_MS = 2000;
const LOCAL_TARGET_REBUILD_RETRY_BASE_MS = 1000;
const LOCAL_TARGET_REBUILD_RETRY_MAX_MS = 30_000;
const LOCAL_TARGET_FILE_EXISTENCE_SWEEP_MS = 5000;

export type DerivedDocumentRelationChannel = Extract<
  DerivedViewChannel,
  'files' | 'backlinks' | 'graph' | 'tags' | 'local-targets'
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
  /**
   * Assessed local-target occurrences per source, optionally scoped to a source
   * set — the project/folder-scope enumeration the links validator projects into
   * the unified validation plane. Exposed on the API port (a query, not a raw
   * index handle) so the validator reads assessment truth without owning the index.
   */
  getLocalTargetAssessmentsForSources(
    sourceDocumentNames?: readonly string[],
  ): Promise<LocalTargetSourceAssessments[]>;
  /** Synchronous equality token for request coalescing/supersession. */
  readLocalTargetGeneration?(): string | number;
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
  /** Late-bound watcher inventory. Null means unavailable, not authoritatively empty. */
  getLocalTargetInventory?: () => WatcherLocalTargetInventory | null;
  onRecoveredFileTarget?: (relativePath: string, exists: boolean) => void;
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

class LocalTargetIndexNotReadyError extends Error {
  constructor() {
    super('Local-target index is not ready');
    this.name = 'LocalTargetIndexNotReadyError';
  }
}

export function isLocalTargetIndexNotReadyError(err: unknown): boolean {
  return err instanceof LocalTargetIndexNotReadyError;
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
  private readonly localTargetIndex: LocalTargetIndex;
  private readonly contentFilter: ContentFilter;
  private readonly getGlobalSkillRoots: () => string[];
  private readonly getLocalTargetInventory: () => WatcherLocalTargetInventory | null;
  private readonly signalChannel: (channel: DerivedDocumentRelationChannel) => void;
  private readonly onRecoveredFileTarget?: (relativePath: string, exists: boolean) => void;
  private readonly startupAdmission = createDeferred();
  private readonly readyBarrier = createDeferred();
  private tail: Promise<void> = Promise.resolve();
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private localTargetRebuildRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly localTargetFileExistenceTimer: ReturnType<typeof setInterval>;
  private localTargetRebuildRetryAttempt = 0;
  /** Identity of the watcher `fileTargets` array the graph oracle was built from. */
  private graphFileTargetsSource: readonly string[] | null = null;
  private graphFileTargets: Set<string> | null = null;
  /** Branch the startup graph pass ran against, for the file-inventory reconcile. */
  private startupBranch: string | null = null;
  /**
   * Whether any graph extraction ran while the watcher inventory was still
   * unavailable, and therefore read every extension-less href as a document.
   */
  private graphBuiltWithoutFileOracle = false;
  private saveTagsOnNextDebounce = false;
  private branchTransition: BranchTransition | null = null;
  private startupBegun = false;
  private startupSettled = false;
  private liveUpdateToken = 0;
  private lastSignaledLocalTargetGeneration = 0;
  private closed = false;
  private closePromise: Promise<void> | null = null;

  constructor(options: DerivedDocumentIndexOptions) {
    this.backlinkIndex = new BacklinkIndex({
      projectDir: options.projectDir,
      contentDir: options.contentDir,
      contentFilter: options.contentFilter,
      // Sourced from the WATCHER inventory, not from `localTargetIndex`. The
      // local-target rebuild consumes `backlinkIndex.getIndexedDocNames()`, so
      // taking the oracle from that index would make the two indexes mutually
      // dependent and the graph would build against an empty file set. The
      // watcher is the actual source of truth for which files exist, and both
      // indexes read it, so there is no cycle and no ordering to get wrong.
      getFileOracle: () => this.graphFileOracle(),
    });
    this.tagIndex = new TagIndex({
      projectDir: options.projectDir,
      contentDir: options.contentDir,
      contentFilter: options.contentFilter,
    });
    this.localTargetIndex = new LocalTargetIndex({
      contentDir: options.contentDir,
      contentFilter: options.contentFilter,
    });
    this.contentFilter = options.contentFilter;
    this.getGlobalSkillRoots = options.getGlobalSkillRoots;
    this.getLocalTargetInventory =
      options.getLocalTargetInventory ?? (() => ({ documentTargets: [], fileTargets: [] }));
    this.signalChannel = options.signalChannel;
    this.onRecoveredFileTarget = options.onRecoveredFileTarget;
    this.testOnly = {
      resetDocumentForTest: (documentName) => this.resetDocumentForTest(documentName),
      rescanBacklinksForTest: () => this.rescanBacklinksForTest(),
    };
    this.localTargetFileExistenceTimer = setInterval(() => {
      if (this.closed || !this.startupSettled || !this.localTargetIndex.isReady()) return;
      void this.runCommand(async () => {
        const affected = await this.localTargetIndex.reconcileDependentFileTargetsFromDisk(
          this.onRecoveredFileTarget,
        );
        this.maybeSignalLocalTargets();
        if (affected > 0) this.signalChannel('files');
      }).catch((err) => {
        if (!this.closed) {
          log.warn({ err }, '[local-target] dependent file-existence sweep failed');
        }
      });
    }, LOCAL_TARGET_FILE_EXISTENCE_SWEEP_MS);
    this.localTargetFileExistenceTimer.unref?.();
  }

  beginStartup(branch: string): { backlinksReady: Promise<DerivedIndexStartupBacklinksResult> } {
    this.assertOpen();
    if (this.startupBegun) {
      throw new Error('Derived document index startup has already begun');
    }
    this.startupBegun = true;
    this.startupBranch = branch;
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
        let tagIndexDegraded = false;
        try {
          const diff = await this.tagIndex.reconcileWithDisk();
          if (diff.added > 0 || diff.updated > 0 || diff.deleted > 0) {
            log.info(diff, '[tag-index] startup reconcile: offline changes applied');
          }
          await this.saveTagsLogOnly('startup');
        } catch (err) {
          log.error(
            { err },
            '[tag-index] startup reconcile failed; tag index updates incrementally via watcher events',
          );
          tagIndexDegraded = true;
        }
        if (await this.rebuildLocalTargets('startup')) this.syncLocalTargetBaseline();
        // The startup graph pass ran before the watcher existed, so it had no
        // way to tell an extension-less file target from a document. The
        // inventory is available now.
        if (this.startupBranch !== null) {
          await this.reconcileGraphWithFileInventory(this.startupBranch);
        }
        return { tagIndexDegraded };
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
        if (await this.rebuildLocalTargets('branch-switch')) this.syncLocalTargetBaseline();
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
      this.reconcileLocalTargetInventory();
      this.scheduleSave();
      this.signalAllRelations();
    });
  }

  recordDiskDelete(documentName: string): Promise<void> {
    return this.runCommand(async () => {
      this.deleteBoth(documentName);
      this.reconcileLocalTargetInventory();
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
      this.reconcileLocalTargetInventory();
      this.scheduleSave();
      this.signalAllRelations();
    });
  }

  /**
   * An ordinary (non-markdown) file target appeared or its content changed.
   * Only its reverse-dependent sources reassess, and the local-targets signal
   * fires only if one actually healed — an unreferenced file create is silent.
   * Ordinary-file renames arrive as delete + upsert (the watcher has no rename
   * variant for them), settling to the union of both identities' dependents.
   */
  recordFileTargetUpsert(relativePath: string): Promise<void> {
    return this.runCommand(async () => {
      const inventory = this.reconcileLocalTargetInventory();
      if (inventory === null || !inventory.fileTargets.includes(relativePath)) {
        this.localTargetIndex.setFileTarget(relativePath, true);
      }
      this.maybeSignalLocalTargets();
    });
  }

  /** An ordinary file target was removed; its reverse dependents break. */
  recordFileTargetDelete(relativePath: string): Promise<void> {
    return this.runCommand(async () => {
      const inventory = this.reconcileLocalTargetInventory();
      if (inventory === null || inventory.fileTargets.includes(relativePath)) {
        this.localTargetIndex.setFileTarget(relativePath, false);
      }
      this.maybeSignalLocalTargets();
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
        this.reconcileLocalTargetInventory();
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
      this.reconcileLocalTargetInventory();
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
      await this.rebuildLocalTargets('content-filter');
      await this.saveBothLogOnly('content-filter', branch);
      // Content scope changed wholesale; signalAllRelations() -> maybeSignalLocalTargets
      // emits `local-targets` off the rebuild's generation jump (no baseline sync).
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

  /**
   * Assessed local-target occurrences for one source. Gated behind the ready
   * barrier like every query, so it never returns a falsely clean empty result
   * against a half-seeded inventory. The occurrence range travels on each
   * assessment for positioned diagnostics.
   */
  getLocalTargetAssessments(documentName: string): Promise<readonly LocalTargetAssessment[]> {
    return this.runLocalTargetQuery(() => this.localTargetIndex.getAssessments(documentName));
  }

  /**
   * Assessed local-target occurrences per source (all sources, or a scoped set),
   * for project/folder-scope validation enumeration. Gated behind the ready
   * barrier like every query, so it never publishes a falsely clean empty result
   * against a half-seeded inventory.
   */
  getLocalTargetAssessmentsForSources(
    sourceDocumentNames?: readonly string[],
  ): Promise<LocalTargetSourceAssessments[]> {
    return this.runLocalTargetQuery(() =>
      this.localTargetIndex.getAssessmentsForSources(sourceDocumentNames),
    );
  }

  /** Monotonic generation of the local-target index — consumers diff it to detect staleness. */
  getLocalTargetGeneration(): Promise<number> {
    return this.runLocalTargetQuery(() => this.localTargetIndex.generation);
  }

  /** Read-only freshness token; unlike assessment queries it never publishes index contents. */
  readLocalTargetGeneration(): string {
    return this.localTargetIndex.freshnessToken;
  }

  /** Bounded-cardinality counts for the local-target index (no paths). */
  getLocalTargetStats(): Promise<LocalTargetIndexStats> {
    return this.runLocalTargetQuery(() => this.localTargetIndex.getStats());
  }

  /** Sources whose local-target assessment depends on a document identity's existence. */
  getLocalTargetDocumentDependents(documentName: string): Promise<string[]> {
    return this.runLocalTargetQuery(() =>
      this.localTargetIndex.getDocumentDependents(documentName),
    );
  }

  /** Sources whose local-target assessment depends on an ordinary-file identity's existence. */
  getLocalTargetFileDependents(relativePath: string): Promise<string[]> {
    return this.runLocalTargetQuery(() => this.localTargetIndex.getFileDependents(relativePath));
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    const pendingSave = this.cancelScheduledSave();
    if (pendingSave !== null) {
      void this.enqueueInternal(() => this.saveScheduledCache(pendingSave, 'close-flush'));
    }
    this.closed = true;
    clearInterval(this.localTargetFileExistenceTimer);
    this.cancelLocalTargetRebuildRetry();
    this.localTargetIndex.close();
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
      this.reconcileLocalTargetInventory();
      await this.saveBacklinksLogOnly('test-rescan', branch);
      this.signalBacklinks();
    });
  }

  private async initializeBacklinks(branch: string): Promise<DerivedIndexStartupBacklinksResult> {
    try {
      let deletedDocNames: readonly string[] = [];
      // Startup graph extraction runs before the watcher inventory exists.
      // Even a warm cache must be checked after watcher seed: ordinary files
      // can appear or disappear while the app is offline without changing a
      // Markdown mtime, which can change an extension-less target's identity.
      this.graphFileOracle();
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
      this.localTargetIndex.setSource(documentName, markdown);
    } else {
      this.backlinkIndex.deleteDocument(documentName);
      this.localTargetIndex.removeSource(documentName);
    }
  }

  private deleteBoth(documentName: string): void {
    this.backlinkIndex.deleteDocument(documentName);
    this.tagIndex.deleteDocument(documentName);
    this.localTargetIndex.removeSource(documentName);
  }

  private renameBoth(oldDocumentName: string, newDocumentName: string, markdown: string): void {
    if (this.isAdmitted(newDocumentName)) {
      this.backlinkIndex.renameDocument(oldDocumentName, newDocumentName, markdown);
      this.tagIndex.renameDocument(oldDocumentName, newDocumentName, markdown);
      this.localTargetIndex.renameSource(oldDocumentName, newDocumentName, markdown);
    } else {
      this.backlinkIndex.deleteDocument(oldDocumentName);
      this.backlinkIndex.deleteDocument(newDocumentName);
      this.tagIndex.deleteDocument(oldDocumentName);
      this.tagIndex.deleteDocument(newDocumentName);
      this.localTargetIndex.removeSource(oldDocumentName);
      this.localTargetIndex.removeSource(newDocumentName);
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
    this.maybeSignalLocalTargets();
  }

  private signalAllRelations(): void {
    this.signalBacklinks();
    this.signalChannel('tags');
  }

  /**
   * Emit `local-targets` only when an assessment actually moved since the last
   * emission — a wiki-only or occurrence-free edit leaves the generation
   * untouched and stays silent, so document/backlink surfaces don't refetch the
   * local-target projection for nothing. The baseline is re-synced after the
   * startup and branch reconciles (whose wholesale generation jump is covered by
   * mount-driven load and the `branch-switched` channel), so it is not mistaken
   * for a delta on the next ordinary command.
   */
  private maybeSignalLocalTargets(): void {
    const generation = this.localTargetIndex.generation;
    const lag = generation - this.lastSignaledLocalTargetGeneration;
    if (lag === 0) return;
    recordIndexGenerationLag('local-target', 'signal', lag);
    this.lastSignaledLocalTargetGeneration = generation;
    this.signalChannel('local-targets');
  }

  /**
   * File-existence oracle handed to the document graph, memoized against the
   * watcher's own `fileTargets` array so a whole-document link scan does not
   * rebuild the set per link. The watcher hands back a fresh array whenever the
   * inventory changes, so identity is a sound cache key.
   */
  private graphFileOracle(): { hasFile(path: string): boolean } | undefined {
    const inventory = this.getLocalTargetInventory();
    if (!inventory) {
      // The watcher is not up during the startup graph build, so this is the
      // normal first-boot path, not an error. Remember it: every extension-less
      // href in that pass was read as a document, and the graph has to be
      // re-derived once the inventory exists or `assets/NOTICE` keeps its
      // dead-document edge until the file happens to change.
      this.graphBuiltWithoutFileOracle = true;
      return undefined;
    }
    if (this.graphFileTargetsSource !== inventory.fileTargets) {
      this.graphFileTargetsSource = inventory.fileTargets;
      this.graphFileTargets = new Set(inventory.fileTargets);
    }
    const files = this.graphFileTargets;
    return files ? { hasFile: (path) => files.has(path) } : undefined;
  }

  /**
   * Re-derive the graph once the file inventory first becomes available, so the
   * document/file disambiguation the startup pass could not make is applied.
   *
   * Bounded: the flag clears on the first successful pass, so this is at most
   * one extra rebuild per boot, and only when a graph pass actually ran without
   * the oracle.
   */
  private async reconcileGraphWithFileInventory(branch: string): Promise<void> {
    if (!this.graphBuiltWithoutFileOracle) return;
    if (!this.graphFileOracle()) return;
    // Cleared before the rebuild rather than after, so the rebuild itself can
    // legitimately re-set it: the oracle is polled per extraction, and a pass
    // that loses the inventory mid-rebuild has again built without it.
    this.graphBuiltWithoutFileOracle = false;
    try {
      await this.backlinkIndex.rebuildFromDisk(branch);
      await this.saveBacklinksLogOnly('file-inventory-reconcile', branch);
      this.signalChannel('backlinks');
      this.signalChannel('graph');
    } catch (err) {
      // The reconcile did not land, so the flag must keep saying the graph was
      // built without the oracle. Nothing retries it this boot — the one call
      // site runs once, at startup settlement — and the audit plane still
      // suppresses a dead-link claim the canonical classifier contradicts.
      this.graphBuiltWithoutFileOracle = true;
      log.warn(
        { err, branch },
        '[backlinks] file-inventory reconciliation failed; graph retains its startup extraction',
      );
    }
  }

  private async rebuildLocalTargets(reason: string): Promise<boolean> {
    try {
      const watcherInventory = this.getLocalTargetInventory();
      if (watcherInventory === null) {
        this.localTargetIndex.markUnavailable();
        log.warn(
          { reason },
          '[local-target] watcher inventory unavailable; index remains not ready',
        );
        return false;
      }
      const inventory: LocalTargetRebuildInventory = {
        documentTargets: new Set([
          ...this.backlinkIndex.getIndexedDocNames(),
          ...watcherInventory.documentTargets,
        ]),
        fileTargets: watcherInventory.fileTargets,
      };
      await this.localTargetIndex.rebuildFromDisk(inventory);
      this.localTargetRebuildRetryAttempt = 0;
      this.cancelLocalTargetRebuildRetry();
      return true;
    } catch (err) {
      log.warn(
        { err, reason },
        '[local-target] rebuild failed; retaining the last complete snapshot and scheduling recovery',
      );
      this.scheduleLocalTargetRebuildRetry(reason);
      return false;
    }
  }

  private reconcileLocalTargetInventory(): WatcherLocalTargetInventory | null {
    const watcherInventory = this.getLocalTargetInventory();
    if (watcherInventory === null) {
      this.localTargetIndex.markUnavailable();
      return null;
    }
    this.localTargetIndex.reconcileDocumentTargets(
      new Set([...this.backlinkIndex.getIndexedDocNames(), ...watcherInventory.documentTargets]),
    );
    this.localTargetIndex.reconcileFileTargets(watcherInventory.fileTargets);
    return watcherInventory;
  }

  private syncLocalTargetBaseline(): void {
    const generation = this.localTargetIndex.generation;
    const lag = generation - this.lastSignaledLocalTargetGeneration;
    if (lag > 0) recordIndexGenerationLag('local-target', 'baseline', lag);
    this.lastSignaledLocalTargetGeneration = generation;
  }

  private scheduleLocalTargetRebuildRetry(reason: string): void {
    if (this.closed || this.localTargetRebuildRetryTimer !== null) return;
    const delay = Math.min(
      LOCAL_TARGET_REBUILD_RETRY_BASE_MS * 2 ** this.localTargetRebuildRetryAttempt,
      LOCAL_TARGET_REBUILD_RETRY_MAX_MS,
    );
    this.localTargetRebuildRetryAttempt++;
    this.localTargetRebuildRetryTimer = setTimeout(() => {
      this.localTargetRebuildRetryTimer = null;
      void this.runCommand(async () => {
        if (await this.rebuildLocalTargets(`retry:${reason}`)) this.maybeSignalLocalTargets();
      }).catch((err) => {
        if (!this.closed) log.warn({ err, reason }, '[local-target] recovery enqueue failed');
      });
    }, delay);
    this.localTargetRebuildRetryTimer.unref?.();
  }

  private cancelLocalTargetRebuildRetry(): void {
    if (this.localTargetRebuildRetryTimer !== null) {
      clearTimeout(this.localTargetRebuildRetryTimer);
      this.localTargetRebuildRetryTimer = null;
    }
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

  private runLocalTargetQuery<T>(query: () => Promise<T> | T): Promise<T> {
    return this.runQuery(() => {
      if (!this.localTargetIndex.isReady()) throw new LocalTargetIndexNotReadyError();
      return query();
    });
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
