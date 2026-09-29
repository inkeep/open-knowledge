import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import type { Document } from '@hocuspocus/server';
import { resolveGitDirDetailed } from '@inkeep/open-knowledge-core/shadow-repo-layout';
import type * as Y from 'yjs';
import { type CC1Broadcaster, isConfigDoc, isSystemDoc } from './cc1-broadcast.ts';
import { getLocalDir } from './config/paths.ts';
import { ConflictMarkersInContentError, NoConflictTrackedError } from './conflict-errors.ts';
import {
  type Conflict,
  type ConflictKind,
  type ConflictStages,
  holdsMarkersOnDisk,
  isConflictKind,
  isReconcileReason,
  type LifecycleView,
  type ReconcileReason,
  type ResolveStrategy,
  strategiesFor,
} from './conflict-kinds.ts';
import {
  commitMergeIfEmpty,
  projectAbsPath,
  resolveMergeNative,
  resolveReconcile,
  resolveWorkingTree,
  selectReconcileOurs,
} from './conflict-resolution.ts';
import { requireConflictResolutionContent } from './conflict-resolution-input.ts';
import { isShareableOkArtifact } from './content-filter.ts';
import { docNameToRelativePath } from './doc-extensions.ts';
import { pathToDocName } from './file-watcher.ts';
import { tracedMkdirSync, tracedRenameSync, tracedWriteFileSync } from './fs-traced.ts';
import { splitNulSeparatedPaths } from './git-paths.ts';
import { errnoCode } from './http/handler-utils.ts';
import { getLogger } from './logger.ts';
import { toPosix } from './path-utils.ts';
import { containsUnresolvedConflictBlock } from './reconciliation.ts';
import { assertRealpathWithinDir } from './symlink-guard.ts';

const log = getLogger('conflict-authority');

export type { Conflict, ResolveStrategy };

const LEDGER_VERSION = 2 as const;
const SUPPORTED_LEDGER_VERSIONS: readonly number[] = [1, LEDGER_VERSION];

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

export type RaiseInput = DistributiveOmit<Conflict, 'detectedAt' | 'branch'> & {
  detectedAt?: string;
};

type ClearCause = 'resolved' | 'git-pruned' | 'dissolved' | 'branch-changed';

export type ConflictChange =
  | { type: 'raised'; conflict: Conflict; docName: string | null }
  | { type: 'cleared'; file: string; docName: string | null; cause: ClearCause };

export interface ConflictIo {
  gitRaw(args: string[]): Promise<string>;
  writeProjectFileUntracked(absPath: string, bytes: string): void;
  unlinkProjectFileUndeclared(absPath: string): void;
  deleteResolvedContent(docName: string, absPath: string): void;
  applyResolvedContent(docName: string, absPath: string, bytes: string): Promise<void>;
  readLiveContent?(docName: string): string | null;
  finalizeReconcileResolution?(
    entry: Extract<Conflict, { kind: 'reconcile' }>,
    strategy: ResolveStrategy,
    docName: string,
  ): Promise<void> | void;
}

export interface ConflictAuthorityOptions {
  projectDir: string;
  contentDir: string;
  branch?: string;
  signal?: Pick<CC1Broadcaster, 'signal'> | null;
  io: ConflictIo;
}

export interface ConflictReader {
  has(docName: string): boolean;
}

const boundAuthorities = new WeakMap<Y.Doc, ConflictReader>();

export function bindConflictAuthority(document: Y.Doc, authority: ConflictReader): void {
  boundAuthorities.set(document, authority);
}

export function isDocInConflict(document: Document): boolean {
  const reader = boundAuthorities.get(document);
  if (reader === undefined) {
    log.error(
      { 'doc.name': document.name },
      '[conflicts] no authority is bound to this document — the write gate cannot answer',
    );
    return false;
  }
  return reader.has(document.name);
}

function resolvedBytesFor(
  entry: Conflict,
  strategy: ResolveStrategy,
  content: string | undefined,
  liveOurs: string | null = null,
): string | undefined {
  if (strategy === 'delete') return undefined;
  if (strategy === 'content') return content;
  if (entry.kind !== 'reconcile') return undefined;
  return strategy === 'mine' ? selectReconcileOurs(entry, liveOurs) : entry.stages.theirs;
}

function samePayload(a: Conflict, b: Conflict): boolean {
  if (a.kind !== b.kind || a.file !== b.file) return false;
  switch (a.kind) {
    case 'merge-native':
      return true;
    case 'working-tree':
      return b.kind === 'working-tree' && a.theirsSha === b.theirsSha && a.baseSha === b.baseSha;
    case 'reconcile':
      return (
        b.kind === 'reconcile' &&
        a.branch === b.branch &&
        a.reason === b.reason &&
        a.stages.base === b.stages.base &&
        a.stages.ours === b.stages.ours &&
        a.stages.theirs === b.stages.theirs
      );
    default: {
      const _exhaustive: never = a;
      return false;
    }
  }
}

interface LegacyLedgerEntry {
  file?: unknown;
  detectedAt?: unknown;
  branch?: unknown;
  kind?: unknown;
  reason?: unknown;
  stages?: unknown;
  theirsSha?: unknown;
  baseSha?: unknown;
  variant?: unknown;
}

function migrateLedgerEntry(raw: LegacyLedgerEntry, currentBranch: string): Conflict | null {
  const file = typeof raw.file === 'string' && raw.file.length > 0 ? raw.file : null;
  if (file === null) return null;
  const detectedAt =
    typeof raw.detectedAt === 'string' && raw.detectedAt.length > 0
      ? raw.detectedAt
      : new Date().toISOString();
  const theirsSha =
    typeof raw.theirsSha === 'string' && raw.theirsSha.length > 0 ? raw.theirsSha : null;
  const baseSha =
    typeof raw.baseSha === 'string' && raw.baseSha.length > 0 ? raw.baseSha : undefined;

  const declaredKind = isConflictKind(raw.kind) ? raw.kind : null;
  if (declaredKind === null && raw.kind !== undefined) {
    log.warn(
      {
        file,
        kind: typeof raw.kind === 'string' ? raw.kind.slice(0, 80) : `<${typeof raw.kind}>`,
      },
      '[conflicts] dropped a ledger entry with an unrecognized conflict kind',
    );
    return null;
  }
  const kind: ConflictKind =
    declaredKind ?? (raw.variant === 'working-tree' ? 'working-tree' : 'merge-native');

  if (kind === 'working-tree') {
    if (theirsSha === null) {
      log.warn(
        { file },
        '[conflicts] dropped a working-tree ledger entry with no pinned theirs blob',
      );
      return null;
    }
    return {
      kind,
      file,
      detectedAt,
      theirsSha,
      ...(baseSha === undefined ? {} : { baseSha }),
    };
  }

  if (kind === 'reconcile') {
    const reason = raw.reason;
    const rawStages = raw.stages;
    const stages =
      typeof rawStages === 'object' && rawStages !== null
        ? (rawStages as Partial<ConflictStages>)
        : undefined;
    if (
      !isReconcileReason(reason) ||
      stages === undefined ||
      typeof stages.base !== 'string' ||
      typeof stages.ours !== 'string' ||
      typeof stages.theirs !== 'string'
    ) {
      log.warn(
        { file },
        '[conflicts] dropped a reconcile ledger entry with no reason or incomplete stages',
      );
      return null;
    }
    return {
      kind,
      file,
      detectedAt,
      branch: typeof raw.branch === 'string' && raw.branch.length > 0 ? raw.branch : currentBranch,
      reason,
      stages: { base: stages.base, ours: stages.ours, theirs: stages.theirs },
    };
  }

  return { kind: 'merge-native', file, detectedAt };
}

export class ConflictAuthority implements ConflictReader {
  private readonly storePath: string;
  private readonly projectDir: string;
  private readonly contentDir: string;
  private readonly io: ConflictIo;
  private readonly signal: Pick<CC1Broadcaster, 'signal'> | null;
  private readonly listeners = new Set<(change: ConflictChange) => void>();
  private readonly byFile = new Map<string, Conflict>();
  private readonly byDocName = new Map<string, Conflict>();
  private branch: string;

  constructor(options: ConflictAuthorityOptions) {
    this.projectDir = options.projectDir;
    this.contentDir = options.contentDir;
    this.io = options.io;
    this.signal = options.signal ?? null;
    this.branch = options.branch ?? 'main';
    this.storePath = join(getLocalDir(this.projectDir), 'conflicts.json');
    this.load(options.branch === undefined);
  }

  fileOf(docName: string): string {
    const abs = join(this.contentDir, docNameToRelativePath(docName));
    return toPosix(relative(this.projectDir, abs));
  }

  docNameOf(conflict: Conflict): string | null {
    return this.docNameForFile(conflict.file);
  }

  private docNameForFile(file: string): string | null {
    const abs = join(this.projectDir, file);
    const contentRel = toPosix(relative(this.contentDir, abs));
    if (contentRel.length === 0 || contentRel.startsWith('..')) return null;
    const docName = pathToDocName(abs, this.contentDir);
    if (isSystemDoc(docName) || isConfigDoc(docName)) return null;
    return docName;
  }

  private index(conflict: Conflict): string | null {
    this.byFile.set(conflict.file, conflict);
    const docName = this.docNameForFile(conflict.file);
    if (docName !== null) this.byDocName.set(docName, conflict);
    return docName;
  }

  private unindex(file: string): string | null {
    const entry = this.byFile.get(file);
    this.byFile.delete(file);
    const docName = this.docNameForFile(file);
    if (docName === null) return null;
    if (this.byDocName.get(docName) !== entry) return docName;
    this.byDocName.delete(docName);
    for (const candidate of this.byFile.values()) {
      if (this.docNameForFile(candidate.file) === docName) {
        this.byDocName.set(docName, candidate);
        break;
      }
    }
    return docName;
  }

  private commit(changes: readonly ConflictChange[]): void {
    if (changes.length === 0) return;
    this.persist();
    for (const change of changes) {
      for (const listener of this.listeners) {
        try {
          listener(change);
        } catch (err) {
          log.warn({ err }, '[conflicts] subscriber threw while handling a conflict change');
        }
      }
    }
    this.signal?.signal('sync-status');
  }

  private quarantineStore(reason: 'unparseable' | 'unsupported-version', err?: unknown): void {
    const stamp = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-');
    const asidePath = `${this.storePath}.corrupt-${stamp}`;
    try {
      tracedRenameSync(this.storePath, asidePath);
      log.error(
        { err, reason, asidePath },
        '[conflicts] conflicts.json was unreadable — moved aside and started empty',
      );
    } catch (renameErr) {
      log.error(
        { err, reason, renameErr },
        '[conflicts] conflicts.json was unreadable and could not be moved aside — starting empty',
      );
    }
  }

  private load(adoptLedgerBranch: boolean): void {
    this.byFile.clear();
    this.byDocName.clear();
    if (!existsSync(this.storePath)) return;
    let parsed: { version?: unknown; branch?: unknown; conflicts?: unknown };
    try {
      const value: unknown = JSON.parse(readFileSync(this.storePath, 'utf-8'));
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        this.quarantineStore('unparseable');
        return;
      }
      parsed = value;
    } catch (err) {
      this.quarantineStore('unparseable', err);
      return;
    }
    if (typeof parsed.version !== 'number' || !SUPPORTED_LEDGER_VERSIONS.includes(parsed.version)) {
      this.quarantineStore('unsupported-version');
      return;
    }
    if (adoptLedgerBranch && typeof parsed.branch === 'string') this.branch = parsed.branch;
    const rows = Array.isArray(parsed.conflicts) ? parsed.conflicts : [];
    try {
      for (const row of rows) {
        if (row === null || typeof row !== 'object') continue;
        const raw = row as LegacyLedgerEntry;
        const migrated = migrateLedgerEntry(raw, this.branch);
        if (migrated === null) continue;
        const staleness = this.stalenessAtLoad(migrated);
        if (staleness !== null) {
          log.info(
            { file: migrated.file, staleness, branch: this.branch },
            '[conflicts] dropped a reconcile entry that no longer matches this branch or its disk state',
          );
          continue;
        }
        this.index(migrated);
      }
      if (parsed.version !== LEDGER_VERSION) this.persist();
    } catch (err) {
      this.byFile.clear();
      this.byDocName.clear();
      this.quarantineStore('unparseable', err);
    }
  }

  private stalenessAtLoad(entry: Conflict): 'other-branch' | 'markers-gone' | null {
    if (entry.kind !== 'reconcile') return null;
    if (entry.branch !== this.branch) return 'other-branch';
    if (!holdsMarkersOnDisk(entry)) return null;
    return this.fileStillHoldsMarkers(entry.file) ? null : 'markers-gone';
  }

  private fileStillHoldsMarkers(file: string): boolean {
    try {
      return containsUnresolvedConflictBlock(readFileSync(join(this.projectDir, file), 'utf-8'));
    } catch (err) {
      if (errnoCode(err) === 'ENOENT') return false;
      log.warn(
        { err, file },
        '[conflicts] could not re-read a marker-bearing file at load — keeping its entry',
      );
      return true;
    }
  }

  private persist(): void {
    const tmpPath = `${this.storePath}.tmp`;
    try {
      const dir = dirname(this.storePath);
      if (!existsSync(dir)) tracedMkdirSync(dir, { recursive: true });
      const payload = {
        version: LEDGER_VERSION,
        branch: this.branch,
        conflicts: [...this.byFile.values()],
      };
      tracedWriteFileSync(tmpPath, JSON.stringify(payload), 'utf-8');
      tracedRenameSync(tmpPath, this.storePath);
    } catch (err) {
      log.error(
        { err, branch: this.branch },
        '[conflicts] failed to persist conflicts.json — the ledger will not survive restart',
      );
    }
  }

  raise(input: RaiseInput): void {
    const docName = this.docNameForFile(input.file);
    if (docName === null && input.kind === 'reconcile') {
      log.warn(
        { file: input.file, kind: input.kind },
        '[conflicts] refused a reconcile raise for a path with no content doc — the document stays writable',
      );
      return;
    }
    const existing = this.byFile.get(input.file);
    if (existing !== undefined && input.kind === 'reconcile' && existing.kind !== 'reconcile') {
      return;
    }
    const detectedAt = input.detectedAt ?? new Date().toISOString();
    let conflict: Conflict;
    switch (input.kind) {
      case 'merge-native':
        conflict = { kind: 'merge-native', file: input.file, detectedAt };
        break;
      case 'working-tree':
        conflict = {
          kind: 'working-tree',
          file: input.file,
          detectedAt,
          theirsSha: input.theirsSha,
          ...(input.baseSha === undefined ? {} : { baseSha: input.baseSha }),
        };
        break;
      case 'reconcile':
        conflict = {
          kind: 'reconcile',
          file: input.file,
          detectedAt,
          branch: this.branch,
          reason: input.reason,
          stages:
            existing !== undefined && existing.kind === 'reconcile'
              ? { ...input.stages, ours: existing.stages.ours }
              : { ...input.stages },
        };
        break;
      default: {
        const _exhaustive: never = input;
        return;
      }
    }
    if (existing !== undefined && samePayload(existing, conflict)) return;
    if (existing !== undefined && existing.kind === 'reconcile' && conflict.kind !== 'reconcile') {
      log.warn(
        { file: input.file, reason: existing.reason, replacedBy: conflict.kind },
        '[conflicts] a git conflict displaced a reconcile entry — its captured editor text is gone',
      );
    }
    this.index(conflict);
    this.commit([{ type: 'raised', conflict, docName }]);
  }

  dissolveReconcile(docName: string, reason?: ReconcileReason): void {
    const entry = this.byDocName.get(docName);
    if (entry?.kind === 'reconcile' && reason !== undefined && entry.reason !== reason) return;
    this.dissolveKind(entry, 'reconcile');
  }

  dissolveWorkingTree(file: string): void {
    this.dissolveKind(this.byFile.get(file), 'working-tree');
  }

  private dissolveKind(entry: Conflict | undefined, kind: ConflictKind): void {
    if (entry === undefined) return;
    if (entry.kind !== kind) return;
    const docName = this.unindex(entry.file);
    this.commit([{ type: 'cleared', file: entry.file, docName, cause: 'dissolved' }]);
  }

  async pruneMergeNativeAgainstGit(): Promise<number> {
    const mergeNative = [...this.byFile.values()].filter((e) => e.kind === 'merge-native');
    if (mergeNative.length === 0) return 0;

    const gitDir = resolveGitDirDetailed(this.projectDir);
    if (gitDir.kind === 'malformed-pointer' || gitDir.kind === 'inaccessible') {
      log.warn(
        { gitDirKind: gitDir.kind, gitPath: gitDir.gitPath },
        '[conflicts] the git directory could not be read — leaving the ledger untouched',
      );
      return 0;
    }
    const mergeInProgress = gitDir.kind !== 'absent' && existsSync(join(gitDir.path, 'MERGE_HEAD'));

    let stale: Conflict[];
    if (!mergeInProgress) {
      stale = mergeNative;
    } else {
      let stillUnmerged: Set<string>;
      try {
        stillUnmerged = new Set(
          splitNulSeparatedPaths(
            await this.io.gitRaw(['diff', '-z', '--name-only', '--diff-filter=U']),
          ),
        );
      } catch (err) {
        log.warn({ err }, '[conflicts] git unmerged probe failed — leaving the ledger untouched');
        return 0;
      }
      stale = mergeNative.filter((e) => !stillUnmerged.has(e.file));
    }

    if (stale.length === 0) return 0;
    const changes: ConflictChange[] = [];
    for (const entry of stale) {
      if (this.byFile.get(entry.file) !== entry) continue;
      const docName = this.unindex(entry.file);
      changes.push({ type: 'cleared', file: entry.file, docName, cause: 'git-pruned' });
    }
    if (changes.length === 0) return 0;
    log.info(
      { cleared: changes.length, remaining: this.byFile.size, mergeInProgress },
      '[conflicts] external resolve detected — pruned merge-native entries',
    );
    this.commit(changes);
    return changes.length;
  }

  async resolve(file: string, strategy: ResolveStrategy, content?: string): Promise<void> {
    const entry = this.byFile.get(file);
    if (entry === undefined) throw new NoConflictTrackedError({ file });

    if (strategy === 'content') requireConflictResolutionContent(file, content);

    const reason = entry.kind === 'reconcile' ? entry.reason : undefined;
    if (!strategiesFor(entry.kind, reason).includes(strategy)) {
      throw new ConflictMarkersInContentError({ file, refusal: 'strategy-not-offered' });
    }

    const reconcileDocName = entry.kind === 'reconcile' ? this.docNameForFile(file) : null;
    const liveOurs =
      entry.kind === 'reconcile' && strategy === 'mine' && reconcileDocName !== null
        ? (this.io.readLiveContent?.(reconcileDocName) ?? null)
        : null;
    const landing = resolvedBytesFor(entry, strategy, content, liveOurs);
    if (landing !== undefined && containsUnresolvedConflictBlock(landing)) {
      throw new ConflictMarkersInContentError({ file, refusal: 'markers-in-content' });
    }

    switch (entry.kind) {
      case 'merge-native': {
        await resolveMergeNative(entry, strategy, content, this.io, this.projectDir);
        if (this.countOfKind('merge-native') <= 1) {
          await this.commitMergeBeforeClearing(entry);
        }
        const docName = this.unindex(file);
        this.logResolved(file, entry.kind, strategy);
        this.commit([{ type: 'cleared', file, docName, cause: 'resolved' }]);
        return;
      }
      case 'working-tree': {
        await resolveWorkingTree(entry, strategy, content, this.io, this.projectDir);
        const docName = this.unindex(file);
        this.logResolved(file, entry.kind, strategy);
        this.commit([{ type: 'cleared', file, docName, cause: 'resolved' }]);
        return;
      }
      case 'reconcile': {
        const docName = reconcileDocName;
        if (docName === null) {
          throw new Error(`[conflicts] reconcile conflict for ${file} has no content doc`);
        }
        const requestedPath = resolve(this.projectDir, file);
        projectAbsPath(this.projectDir, file);
        const canonicalPath = assertRealpathWithinDir(requestedPath, this.contentDir, {
          allowShareableOkArtifact: isShareableOkArtifact,
        });
        const absPath = strategy === 'delete' ? requestedPath : canonicalPath;
        await resolveReconcile(strategy, landing, docName, absPath, this.io);
        await this.io.finalizeReconcileResolution?.(entry, strategy, docName);
        this.unindex(file);
        this.logResolved(file, entry.kind, strategy);
        this.commit([{ type: 'cleared', file, docName, cause: 'resolved' }]);
        return;
      }
      default: {
        const exhaustive: never = entry;
        throw new Error(`[conflicts] unknown conflict kind: ${JSON.stringify(exhaustive)}`);
      }
    }
  }

  private logResolved(file: string, kind: ConflictKind, choice: ResolveStrategy): void {
    log.info({ file, kind, choice }, '[conflicts] conflict resolved by choice');
  }

  private async commitMergeBeforeClearing(entry: Conflict): Promise<void> {
    const resolvedFile = entry.file;
    const result = await commitMergeIfEmpty(this.io);
    if (result.ok) {
      log.info({ file: resolvedFile }, '[conflicts] all conflicts resolved — merge commit created');
      return;
    }
    const causeText = result.cause instanceof Error ? result.cause.message : String(result.cause);
    if (result.unmerged === null) {
      log.error(
        { err: result.cause, probeErr: result.probeError, file: resolvedFile },
        '[conflicts] merge commit failed and the unmerged probe crashed — the ledger could not be re-synced against git',
      );
      throw new Error(
        `Merge commit failed after resolving ${resolvedFile}; the conflict entry was kept — ${causeText}`,
        { cause: result.cause },
      );
    }
    const changes: ConflictChange[] = [];
    for (const file of result.unmerged) {
      if (this.byFile.has(file)) continue;
      const conflict: Conflict = {
        kind: 'merge-native',
        file,
        detectedAt: new Date().toISOString(),
      };
      const docName = this.index(conflict);
      changes.push({ type: 'raised', conflict, docName });
    }
    this.commit(changes);
    log.warn(
      { err: result.cause, files: result.unmerged },
      '[conflicts] failed to commit merge after all conflicts resolved — the ledger entry stays',
    );
    throw new Error(
      `Merge commit failed after resolving ${resolvedFile}; the conflict entry was kept — ${causeText}`,
      { cause: result.cause },
    );
  }

  list(): readonly Conflict[] {
    return [...this.byFile.values()];
  }

  findByFile(file: string): Conflict | undefined {
    return this.byFile.get(file);
  }

  findByDocName(docName: string): Conflict | undefined {
    return this.byDocName.get(docName);
  }

  has(docName: string): boolean {
    return this.byDocName.has(docName);
  }

  count(): number {
    return this.byFile.size;
  }

  private countOfKind(kind: ConflictKind): number {
    let total = 0;
    for (const entry of this.byFile.values()) if (entry.kind === kind) total++;
    return total;
  }

  lifecycleOf(document: Y.Doc, docName: string): LifecycleView | null {
    const map = document.getMap('lifecycle');
    const status = map.get('status');
    if (status === 'deleted-upstream') return { status: 'deleted-upstream' };
    if (status === 'renamed') {
      const newPath = map.get('newPath');
      return { status: 'renamed', newPath: typeof newPath === 'string' ? newPath : '' };
    }
    const entry = this.byDocName.get(docName);
    if (entry === undefined) return null;
    switch (entry.kind) {
      case 'reconcile':
        return { status: 'conflict', kind: entry.kind, reason: entry.reason };
      case 'merge-native':
        return { status: 'conflict', kind: entry.kind, reason: 'merge-conflict' };
      case 'working-tree':
        return { status: 'conflict', kind: entry.kind, reason: 'pull-only-collision' };
      default: {
        const _exhaustive: never = entry;
        return null;
      }
    }
  }

  setBranch(branch: string): void {
    if (branch === this.branch) return;
    this.branch = branch;
    const changes: ConflictChange[] = [];
    for (const entry of Array.from(this.byFile.values())) {
      if (entry.kind !== 'reconcile' || entry.branch === branch) continue;
      const docName = this.unindex(entry.file);
      changes.push({ type: 'cleared', file: entry.file, docName, cause: 'branch-changed' });
    }
    if (changes.length === 0) {
      if (this.byFile.size > 0) this.persist();
      return;
    }
    log.info(
      { branch, cleared: changes.length },
      '[conflicts] branch changed — dropped the reconcile entries raised on the branch we left',
    );
    this.commit(changes);
  }

  subscribe(listener: (change: ConflictChange) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}
