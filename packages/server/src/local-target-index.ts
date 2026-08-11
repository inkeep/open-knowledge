/**
 * Server-owned local-target assessment index — a sibling to `BacklinkIndex`
 * and `TagIndex` behind `DerivedDocumentIndex`. It holds one assessment per
 * authored local-target occurrence and the reverse dependencies that let a
 * target mutation heal or break only the sources that reference it, never the
 * whole project.
 *
 * Two maps form the narrow waist:
 *   - source → occurrence assessments (what each document authored)
 *   - target → sources (who depends on each document/ordinary-file identity)
 *
 * A source edit replaces only that source's occurrence memberships and drops
 * the reverse-dependency edges it no longer authors. A target create/delete
 * reassesses exactly the reverse dependents of that identity — the authored
 * hrefs are unchanged, so only each occurrence's `exact`/`missing` status
 * flips; work is O(reverse dependents), not O(project).
 *
 * Existence is owned here, unlike `BacklinkIndex` (which takes an admitted set
 * per query): a document exists once it has been recorded as a source, and an
 * ordinary file exists once the watcher's all-files inventory reports it. That
 * keeps the inventory and the occurrences on one generation so a restart or
 * branch switch can withhold a `ready` result rather than publish a falsely
 * clean one against a half-seeded inventory.
 *
 * Recognition, resolution, and existence policy live upstream
 * (`local-target-occurrences.ts`, `local-target-assessment.ts`); this module
 * owns only membership, reverse dependencies, and lifecycle. Classification
 * upstream is total, but this index stores only what the local-target surfaces
 * project — wiki forms keep their graph-backed validation, so `BacklinkIndex`
 * semantics are untouched and a wiki-only edit stays silent here.
 */

import { type Dirent, existsSync, realpathSync } from 'node:fs';
import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';
import {
  classifyMarkdownHref,
  resolveAssetProjectPath,
  toWikiLinkSlug,
} from '@inkeep/open-knowledge-core';
import { isLinkIndexExcludedDoc } from './cc1-broadcast.ts';
import type { ContentFilter } from './content-filter.ts';
import { isSupportedDocFile, stripDocExtension } from './doc-extensions.ts';
import { instrumentIndexRebuild, instrumentIndexUpdate } from './index-telemetry.ts';
import {
  assessLocalTargetOccurrences,
  createTolerantDocumentResolver,
  isProjectableToLocalTargetSurfaces,
  type LocalTargetAssessment,
  type LocalTargetInventory,
} from './local-target-assessment.ts';
import { extractLocalTargetOccurrences } from './local-target-occurrences.ts';
import { toPosix } from './path-utils.ts';

/**
 * Narrow a total classification to the subset this index backs.
 *
 * Classification is total — every recognized form gets a canonical answer, so
 * no surface has to guess. This index, though, is the store behind the
 * local-target SURFACES specifically, and wiki forms do not project there: a
 * wiki document link is a graph edge `forwardLinks` already carries, and a
 * file-shaped wiki embed resolves by vault-wide basename under its own
 * contract. Storing what it does not serve would move this index's generation —
 * and fire the `local-targets` signal — for edits that change nothing any
 * consumer of it can see.
 */
function projectableAssessments(
  assessments: readonly LocalTargetAssessment[],
): LocalTargetAssessment[] {
  return assessments.filter((assessment) =>
    isProjectableToLocalTargetSurfaces(assessment.occurrence),
  );
}

/** One source and its assessed occurrences — the unit of project/scope enumeration. */
export interface LocalTargetSourceAssessments {
  source: string;
  assessments: readonly LocalTargetAssessment[];
}

/** Bounded-cardinality snapshot for telemetry and freshness assertions — counts only, never paths. */
export interface LocalTargetIndexStats {
  /** Sources carrying at least one assessed occurrence. */
  sources: number;
  /** Total assessed occurrences across all sources. */
  occurrences: number;
  /** Distinct document target identities with at least one reverse dependent. */
  documentTargets: number;
  /** Distinct ordinary-file target identities with at least one reverse dependent. */
  fileTargets: number;
}

export interface LocalTargetIndexOptions {
  contentDir: string;
  contentFilter?: ContentFilter;
  /** Test seam for fail-closed rebuild coverage. Production uses `readFile(path, 'utf-8')`. */
  readDocument?: (filePath: string) => Promise<string>;
  /** Test seam for fail-closed directory-walk coverage. */
  readDirectory?: (dir: string) => Promise<Dirent[]>;
}

/** Outcome of a rebuild — bounded counts for telemetry (`instrumentIndexRebuild`). */
export interface LocalTargetRebuildResult {
  sources: number;
  occurrences: number;
}

/** Authoritative existence identities supplied by the watcher/coordinator. */
export interface LocalTargetRebuildInventory {
  documentTargets: Iterable<string>;
  fileTargets: Iterable<string>;
}

/**
 * Every target identity an occurrence's assessment depends on for its verdict.
 * The authored (possibly missing) identity is what flips `exact`/`missing`; a
 * tolerant fallback identity (document-only) is
 * included so that if it later disappears the dependent reassesses.
 */
function assessmentTargetDeps(
  assessment: LocalTargetAssessment,
  sourceDocName: string,
): {
  docs: string[];
  files: string[];
} {
  const docs: string[] = [];
  const files: string[] = [];
  if (assessment.resolvedTarget !== null) {
    if (assessment.targetKind === 'document') docs.push(assessment.resolvedTarget);
    else if (assessment.targetKind === 'file') files.push(assessment.resolvedTarget);
  }
  // Extension-less links are inventory-disambiguated. Retain both candidate
  // edges even while one wins so a file delete/recreate or document
  // create/delete can move the verdict back in either direction.
  if (assessment.occurrence.role === 'link') {
    const classified = classifyMarkdownHref(assessment.occurrence.href, sourceDocName);
    if (classified?.kind === 'doc') {
      docs.push(classified.docName);
      const filePath = resolveAssetProjectPath(assessment.occurrence.href, sourceDocName);
      if (filePath === classified.docName) files.push(filePath);
    }
  }
  // A fallback is always a document identity (ordinary files have no tolerant
  // navigation affordance), so its deletion is a document-target change.
  if (assessment.fallbackTarget !== null) docs.push(assessment.fallbackTarget);
  return { docs, files };
}

function addReverseEdge(reverse: Map<string, Set<string>>, target: string, source: string): void {
  let sources = reverse.get(target);
  if (!sources) {
    sources = new Set();
    reverse.set(target, sources);
  }
  sources.add(source);
}

function removeReverseEdge(
  reverse: Map<string, Set<string>>,
  target: string,
  source: string,
): void {
  const sources = reverse.get(target);
  if (!sources) return;
  sources.delete(source);
  if (sources.size === 0) reverse.delete(target);
}

function tolerantDependencyKeys(docName: string): string[] {
  const keys: string[] = [];
  const slug = toWikiLinkSlug(docName);
  if (slug) keys.push(`slug:${slug}`);
  if (!docName.includes('/') && slug) keys.push(`basename:${slug}`);
  keys.push(`folder:${docName}`);
  return keys;
}

function documentMutationKeys(docName: string): string[] {
  const keys: string[] = [];
  const slug = toWikiLinkSlug(docName);
  if (slug) keys.push(`slug:${slug}`);
  const leaf = docName.slice(docName.lastIndexOf('/') + 1);
  const leafSlug = toWikiLinkSlug(leaf);
  if (leafSlug) keys.push(`basename:${leafSlug}`);
  const slash = docName.lastIndexOf('/');
  if (slash > 0) {
    const parent = docName.slice(0, slash);
    const parentLeaf = parent.slice(parent.lastIndexOf('/') + 1);
    if (leaf === 'index' || leaf === parentLeaf) keys.push(`folder:${parent}`);
  }
  return keys;
}

function assessmentsEqual(
  left: readonly LocalTargetAssessment[],
  right: readonly LocalTargetAssessment[],
): boolean {
  if (left.length !== right.length) return false;
  return left.every((a, index) => {
    const b = right[index];
    if (!b) return false;
    const ar = a.occurrence.reference;
    const br = b.occurrence.reference;
    return (
      a.targetKind === b.targetKind &&
      a.resolvedTarget === b.resolvedTarget &&
      a.status === b.status &&
      a.reason === b.reason &&
      a.resolutionMethod === b.resolutionMethod &&
      a.fallbackTarget === b.fallbackTarget &&
      a.occurrence.role === b.occurrence.role &&
      a.occurrence.sourceForm === b.occurrence.sourceForm &&
      a.occurrence.href === b.occurrence.href &&
      a.occurrence.range.start === b.occurrence.range.start &&
      a.occurrence.range.end === b.occurrence.range.end &&
      a.occurrence.line === b.occurrence.line &&
      a.occurrence.column === b.occurrence.column &&
      ar?.label === br?.label &&
      ar?.kind === br?.kind &&
      ar?.definition.href === br?.definition.href &&
      ar?.definition.repairRange.start === br?.definition.repairRange.start &&
      ar?.definition.repairRange.end === br?.definition.repairRange.end
    );
  });
}

export class LocalTargetIndex {
  private readonly contentDir: string;
  private readonly canonicalContentDir: string;
  private readonly contentFilter?: ContentFilter;
  private readonly readDocument: (filePath: string) => Promise<string>;
  private readonly readDirectory: (dir: string) => Promise<Dirent[]>;

  /** docName → its assessed occurrences (only sources with ≥1 occurrence are kept). */
  private sourceAssessments = new Map<string, LocalTargetAssessment[]>();
  /** docName → document identities it currently depends on (for O(deps) ghost removal). */
  private sourceDocDeps = new Map<string, Set<string>>();
  /** docName → ordinary-file identities it currently depends on. */
  private sourceFileDeps = new Map<string, Set<string>>();
  /** document identity → sources whose assessment depends on it. */
  private reverseByDoc = new Map<string, Set<string>>();
  /** ordinary-file identity → sources whose assessment depends on it. */
  private reverseByFile = new Map<string, Set<string>>();
  /** Tolerant-resolution key → sources that could gain/lose that fallback. */
  private reverseByTolerant = new Map<string, Set<string>>();
  /** docName → tolerant-resolution keys currently authored by that source. */
  private sourceTolerantDeps = new Map<string, Set<string>>();

  /** Admitted live documents — the `hasDocument` oracle. A source's own identity is added when it is recorded. */
  private documents = new Set<string>();
  private tolerantDocumentResolver: (docName: string) => string | null = () => null;
  /** Admitted ordinary files (watcher all-files inventory) — the `hasFile` oracle. */
  private files = new Set<string>();

  private generationValue = 0;
  private freshnessEpoch = 0;
  private readyValue = false;
  private closed = false;

  /** Existence oracle backed by this index's own inventory sets. */
  private readonly inventory: LocalTargetInventory = {
    hasDocument: (docName) => this.documents.has(docName),
    hasFile: (relativePath) => this.files.has(relativePath),
    resolveTolerantDocument: (docName) => this.tolerantDocumentResolver(docName),
  };

  constructor(options: LocalTargetIndexOptions) {
    this.contentDir = options.contentDir;
    try {
      this.canonicalContentDir = realpathSync(options.contentDir);
    } catch {
      this.canonicalContentDir = options.contentDir;
    }
    this.contentFilter = options.contentFilter;
    this.readDocument = options.readDocument ?? ((filePath) => readFile(filePath, 'utf-8'));
    this.readDirectory = options.readDirectory ?? ((dir) => readdir(dir, { withFileTypes: true }));
  }

  /** Monotonic generation; consumers diff it to detect staleness without a full refetch. */
  get generation(): number {
    return this.generationValue;
  }

  /**
   * Whether the index has settled against a seeded inventory. Queries served
   * before this is true would be against a half-seeded inventory — the
   * coordinator withholds them rather than publish a falsely clean result.
   */
  isReady(): boolean {
    return this.readyValue;
  }

  /** Preserve the last complete snapshot but prevent it from being published. */
  markUnavailable(): void {
    if (this.readyValue) this.freshnessEpoch++;
    this.readyValue = false;
  }

  /** Equality token for work that must be abandoned across lifecycle changes. */
  get freshnessToken(): string {
    return `${this.generationValue}:${this.freshnessEpoch}`;
  }

  /** Assessments for one source, or an empty array. The occurrence range travels on each assessment. */
  getAssessments(docName: string): readonly LocalTargetAssessment[] {
    return this.sourceAssessments.get(docName) ?? [];
  }

  /**
   * Assessments for every source, optionally narrowed to a source set — the
   * project/folder-scope enumeration a validator drives. Only sources carrying
   * ≥1 occurrence are held, so iteration is O(sources with occurrences); each
   * occurrence's range travels on its assessment for positioned diagnostics.
   */
  getAssessmentsForSources(sourceDocNames?: readonly string[]): LocalTargetSourceAssessments[] {
    const filter = sourceDocNames && sourceDocNames.length > 0 ? new Set(sourceDocNames) : null;
    const out: LocalTargetSourceAssessments[] = [];
    for (const [source, assessments] of this.sourceAssessments) {
      if (filter && !filter.has(source)) continue;
      out.push({ source, assessments });
    }
    return out;
  }

  /** Sources whose assessment depends on this document identity's existence (sorted). */
  getDocumentDependents(docName: string): string[] {
    const sources = new Set(this.reverseByDoc.get(docName) ?? []);
    for (const key of documentMutationKeys(docName)) {
      for (const source of this.reverseByTolerant.get(key) ?? []) sources.add(source);
    }
    return [...sources].sort((a, b) => a.localeCompare(b));
  }

  /** Sources whose assessment depends on this ordinary-file identity's existence (sorted). */
  getFileDependents(relativePath: string): string[] {
    return [...(this.reverseByFile.get(relativePath) ?? [])].sort((a, b) => a.localeCompare(b));
  }

  getStats(): LocalTargetIndexStats {
    let occurrences = 0;
    for (const assessments of this.sourceAssessments.values()) occurrences += assessments.length;
    return {
      sources: this.sourceAssessments.size,
      occurrences,
      documentTargets: this.reverseByDoc.size,
      fileTargets: this.reverseByFile.size,
    };
  }

  close(): void {
    this.closed = true;
  }

  /**
   * Record a source's markdown: extract its occurrences, assess them against
   * the current inventory, and replace this source's memberships. The source's
   * own identity becomes an existing document; when that flips a previously
   * absent identity to present, the documents referencing it are healed.
   *
   * Returns whether a local-target-relevant change occurred, so the coordinator
   * pushes the `local-targets` signal only when an assessment moved — a
   * wiki-only or occurrence-free edit is silent.
   */
  setSource(docName: string, markdown: string): boolean {
    if (isLinkIndexExcludedDoc(docName)) return false;
    const update = instrumentIndexUpdate(
      'local-target',
      'source',
      () => {
        const previous = this.sourceAssessments.get(docName) ?? [];
        const becameDocument = !this.documents.has(docName);
        this.documents.add(docName);
        if (becameDocument) this.refreshTolerantDocumentIndexes();

        const occurrences = extractLocalTargetOccurrences(markdown);
        const assessments = projectableAssessments(
          assessLocalTargetOccurrences(occurrences, docName, this.inventory),
        );
        const sourceChanged = !assessmentsEqual(previous, assessments);
        if (sourceChanged) this.applySourceAssessments(docName, assessments);

        const healed = becameDocument ? this.reassessDocumentDependents(docName) : 0;
        const changed = sourceChanged || healed > 0;
        if (changed) this.generationValue++;
        return {
          changed,
          occurrences: assessments.length,
          affectedSources: healed + (sourceChanged ? 1 : 0),
        };
      },
      (result) => ({
        'index.occurrences': result.occurrences,
        'index.affected_sources': result.affectedSources,
      }),
    );
    return update.changed;
  }

  /**
   * Forget a source and its identity as a document. Reference-holders that
   * pointed at this now-absent identity are broken. Idempotent. Returns whether
   * an assessment moved.
   */
  removeSource(docName: string): boolean {
    if (isLinkIndexExcludedDoc(docName)) return false;
    const update = instrumentIndexUpdate(
      'local-target',
      'document-target',
      () => {
        const occurrences = this.sourceAssessments.get(docName)?.length ?? 0;
        const hadOccurrences = occurrences > 0;
        const wasDocument = this.documents.delete(docName);
        if (wasDocument) this.refreshTolerantDocumentIndexes();
        this.applySourceAssessments(docName, []);
        const broke = wasDocument ? this.reassessDocumentDependents(docName) : 0;
        const changed = hadOccurrences || broke > 0;
        if (changed) this.generationValue++;
        return {
          changed,
          occurrences,
          affectedSources: broke + (hadOccurrences ? 1 : 0),
        };
      },
      (result) => ({
        'index.occurrences': result.occurrences,
        'index.affected_sources': result.affectedSources,
      }),
    );
    return update.changed;
  }

  /**
   * Rename a source atomically: the old identity's occurrences and existence
   * drop, the new identity's are recorded from the post-rename content. Both
   * identities' reverse dependents are reassessed, so links to the old name
   * break and links to the new name heal in one settled step.
   */
  renameSource(oldDocName: string, newDocName: string, markdown: string): boolean {
    const removed = this.removeSource(oldDocName);
    const set = this.setSource(newDocName, markdown);
    return removed || set;
  }

  /**
   * Reflect an ordinary-file target's existence and reassess only its reverse
   * dependents. A no-op when existence did not flip (a content-only file-update
   * event), so churn stays proportional to real create/delete transitions.
   * Returns the number of sources reassessed (bounded telemetry).
   */
  setFileTarget(relativePath: string, exists: boolean): number {
    const update = instrumentIndexUpdate(
      'local-target',
      'file-target',
      () => {
        const present = this.files.has(relativePath);
        if (exists === present) return { affected: 0, occurrences: 0 };
        if (exists) this.files.add(relativePath);
        else this.files.delete(relativePath);
        const occurrences = this.countFileOccurrences(relativePath);
        const affected = this.reassessFileDependents(relativePath);
        // Existence moved, but only a reassessed dependent is consumer-visible; an
        // unreferenced file create/delete changes no assessment, so hold generation.
        if (affected > 0) this.generationValue++;
        return { affected, occurrences };
      },
      (result) => ({
        'index.occurrences': result.occurrences,
        'index.affected_sources': result.affected,
      }),
    );
    return update.affected;
  }

  /** Replace document existence from an authoritative alias-complete snapshot. */
  reconcileDocumentTargets(documentTargets: Iterable<string>): number {
    const next = new Set(documentTargets);
    const changedIdentities = new Set<string>();
    for (const docName of this.documents) {
      if (!next.has(docName)) changedIdentities.add(docName);
    }
    for (const docName of next) {
      if (!this.documents.has(docName)) changedIdentities.add(docName);
    }
    if (changedIdentities.size === 0) return 0;

    const affected = new Set<string>();
    for (const docName of changedIdentities) {
      for (const source of this.reverseByDoc.get(docName) ?? []) affected.add(source);
      for (const key of documentMutationKeys(docName)) {
        for (const source of this.reverseByTolerant.get(key) ?? []) affected.add(source);
      }
    }
    this.documents = next;
    this.refreshTolerantDocumentIndexes();
    let reassessed = 0;
    for (const source of affected) {
      if (this.reassessSource(source)) reassessed++;
    }
    if (reassessed > 0) this.generationValue++;
    return reassessed;
  }

  /** Replace ordinary-file existence from an authoritative alias-complete snapshot. */
  reconcileFileTargets(fileTargets: Iterable<string>): number {
    return instrumentIndexUpdate(
      'local-target',
      'file-target',
      () => {
        const next = new Set(fileTargets);
        const changedIdentities = new Set<string>();
        for (const relativePath of this.files) {
          if (!next.has(relativePath)) changedIdentities.add(relativePath);
        }
        for (const relativePath of next) {
          if (!this.files.has(relativePath)) changedIdentities.add(relativePath);
        }
        const affected = new Set<string>();
        let occurrences = 0;
        for (const relativePath of changedIdentities) {
          occurrences += this.countFileOccurrences(relativePath);
          for (const source of this.reverseByFile.get(relativePath) ?? []) affected.add(source);
        }
        this.files = next;
        let reassessed = 0;
        for (const source of affected) {
          if (this.reassessSource(source)) reassessed++;
        }
        if (reassessed > 0) this.generationValue++;
        return { affected: reassessed, occurrences };
      },
      (result) => ({
        'index.occurrences': result.occurrences,
        'index.affected_sources': result.affected,
      }),
    ).affected;
  }

  /**
   * Repair watcher events that the host filesystem backend dropped. The sweep
   * is bounded to identities with reverse dependents, so an unreferenced
   * workspace file never adds polling work. Admission and realpath containment
   * mirror the watcher boundary before disk existence can affect an assessment.
   */
  async reconcileDependentFileTargetsFromDisk(
    onChange?: (relativePath: string, exists: boolean) => void,
  ): Promise<number> {
    const targets = [...this.reverseByFile.keys()];
    const existence = await Promise.all(
      targets.map((relativePath) => this.isAdmittedFileOnDisk(relativePath)),
    );
    let affected = 0;
    for (const [index, relativePath] of targets.entries()) {
      const exists = existence[index] ?? false;
      const targetAffected = this.setFileTarget(relativePath, exists);
      if (targetAffected > 0) onChange?.(relativePath, exists);
      affected += targetAffected;
    }
    return affected;
  }

  private async isAdmittedFileOnDisk(relativePath: string): Promise<boolean> {
    if (this.contentFilter?.isPathIgnored(relativePath)) return false;
    try {
      const canonicalPath = await realpath(join(this.contentDir, relativePath));
      const canonicalRelative = relative(this.canonicalContentDir, canonicalPath);
      if (
        canonicalRelative === '' ||
        canonicalRelative === '..' ||
        canonicalRelative.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) ||
        isAbsolute(canonicalRelative)
      ) {
        return false;
      }
      return (await stat(canonicalPath)).isFile();
    } catch {
      return false;
    }
  }

  private countFileOccurrences(relativePath: string): number {
    let occurrences = 0;
    for (const source of this.reverseByFile.get(relativePath) ?? []) {
      for (const assessment of this.sourceAssessments.get(source) ?? []) {
        if (assessmentTargetDeps(assessment, source).files.includes(relativePath)) {
          occurrences++;
        }
      }
    }
    return occurrences;
  }

  /**
   * Rebuild from disk: seed the document inventory from the content-dir walk,
   * the file inventory from the watcher's authoritative all-files snapshot,
   * then assess every source against the complete inventory. Replaces all
   * state and marks the index ready. This is the startup / branch-switch /
   * content-scope reconciliation.
   */
  rebuildFromDisk(inventory: LocalTargetRebuildInventory): Promise<LocalTargetRebuildResult> {
    return instrumentIndexRebuild(
      'local-target',
      'full',
      () => this.rebuildOnce(inventory),
      (result) => ({
        'index.sources': result.sources,
        'index.occurrences': result.occurrences,
        'index.affected_sources': result.sources,
      }),
    );
  }

  private async rebuildOnce(
    inventory: LocalTargetRebuildInventory,
  ): Promise<LocalTargetRebuildResult> {
    const hadContent = this.sourceAssessments.size > 0;
    this.freshnessEpoch++;
    this.readyValue = false;
    const staged = new LocalTargetIndex({
      contentDir: this.contentDir,
      contentFilter: this.contentFilter,
      readDocument: this.readDocument,
      readDirectory: this.readDirectory,
    });
    const result = await staged.populateFromDisk(inventory);

    this.sourceAssessments = staged.sourceAssessments;
    this.sourceDocDeps = staged.sourceDocDeps;
    this.sourceFileDeps = staged.sourceFileDeps;
    this.reverseByDoc = staged.reverseByDoc;
    this.reverseByFile = staged.reverseByFile;
    this.reverseByTolerant = staged.reverseByTolerant;
    this.sourceTolerantDeps = staged.sourceTolerantDeps;
    this.documents = staged.documents;
    this.tolerantDocumentResolver = staged.tolerantDocumentResolver;
    this.files = staged.files;
    this.readyValue = true;
    if (hadContent || this.sourceAssessments.size > 0) this.generationValue++;
    return result;
  }

  private async populateFromDisk(
    inventory: LocalTargetRebuildInventory,
  ): Promise<LocalTargetRebuildResult> {
    for (const docName of inventory.documentTargets) this.documents.add(docName);
    for (const relativePath of inventory.fileTargets) this.files.add(relativePath);
    this.refreshTolerantDocumentIndexes();

    if (!existsSync(this.contentDir)) {
      this.readyValue = true;
      return { sources: 0, occurrences: 0 };
    }

    const docs = await this.listDocsWithPaths();
    // Source bodies are still discovered locally, but target existence comes
    // from the injected canonical inventory. Unioning walked sources keeps a
    // just-authored document self-consistent before its watcher event settles.
    for (const { docName } of docs) this.documents.add(docName);
    this.refreshTolerantDocumentIndexes();

    let occurrenceCount = 0;
    const BATCH_SIZE = 50;
    for (let i = 0; i < docs.length && !this.closed; i += BATCH_SIZE) {
      const batch = docs.slice(i, i + BATCH_SIZE);
      const results = await Promise.all(
        batch.map(async ({ docName, filePath }) => ({
          docName,
          markdown: await this.readDocument(filePath),
        })),
      );
      for (const result of results) {
        if (isLinkIndexExcludedDoc(result.docName)) continue;
        const occurrences = extractLocalTargetOccurrences(result.markdown);
        const assessments = projectableAssessments(
          assessLocalTargetOccurrences(occurrences, result.docName, this.inventory),
        );
        this.applySourceAssessments(result.docName, assessments);
        occurrenceCount += assessments.length;
      }
    }

    this.readyValue = true;
    return { sources: this.sourceAssessments.size, occurrences: occurrenceCount };
  }

  /**
   * Install a source's assessments and reconcile its reverse-dependency edges:
   * edges it no longer authors are removed (ghost removal), new ones added.
   * The occurrences are unchanged for a pure reassessment and replaced for a
   * source edit — either way the dependency set is recomputed from the result.
   */
  private applySourceAssessments(docName: string, assessments: LocalTargetAssessment[]): void {
    const nextDocDeps = new Set<string>();
    const nextFileDeps = new Set<string>();
    const nextTolerantDeps = new Set<string>();
    for (const assessment of assessments) {
      const { docs, files } = assessmentTargetDeps(assessment, docName);
      for (const doc of docs) nextDocDeps.add(doc);
      for (const file of files) nextFileDeps.add(file);
      if (
        assessment.targetKind === 'document' &&
        assessment.status !== 'exact' &&
        assessment.resolvedTarget !== null
      ) {
        for (const key of tolerantDependencyKeys(assessment.resolvedTarget)) {
          nextTolerantDeps.add(key);
        }
      }
    }

    const prevDocDeps = this.sourceDocDeps.get(docName);
    if (prevDocDeps) {
      for (const target of prevDocDeps) {
        if (!nextDocDeps.has(target)) removeReverseEdge(this.reverseByDoc, target, docName);
      }
    }
    for (const target of nextDocDeps) {
      if (!prevDocDeps?.has(target)) addReverseEdge(this.reverseByDoc, target, docName);
    }

    const prevFileDeps = this.sourceFileDeps.get(docName);
    if (prevFileDeps) {
      for (const target of prevFileDeps) {
        if (!nextFileDeps.has(target)) removeReverseEdge(this.reverseByFile, target, docName);
      }
    }
    for (const target of nextFileDeps) {
      if (!prevFileDeps?.has(target)) addReverseEdge(this.reverseByFile, target, docName);
    }

    const prevTolerantDeps = this.sourceTolerantDeps.get(docName);
    if (prevTolerantDeps) {
      for (const key of prevTolerantDeps) {
        if (!nextTolerantDeps.has(key)) removeReverseEdge(this.reverseByTolerant, key, docName);
      }
    }
    for (const key of nextTolerantDeps) {
      if (!prevTolerantDeps?.has(key)) addReverseEdge(this.reverseByTolerant, key, docName);
    }

    if (assessments.length === 0) {
      this.sourceAssessments.delete(docName);
      this.sourceDocDeps.delete(docName);
      this.sourceFileDeps.delete(docName);
      this.sourceTolerantDeps.delete(docName);
      return;
    }
    this.sourceAssessments.set(docName, assessments);
    this.sourceDocDeps.set(docName, nextDocDeps);
    this.sourceFileDeps.set(docName, nextFileDeps);
    this.sourceTolerantDeps.set(docName, nextTolerantDeps);
  }

  /** Reassess one source against the current inventory without re-extracting its occurrences. */
  private reassessSource(docName: string): boolean {
    const assessments = this.sourceAssessments.get(docName);
    if (!assessments) return false;
    const occurrences = assessments.map((assessment) => assessment.occurrence);
    const next = assessLocalTargetOccurrences(occurrences, docName, this.inventory);
    if (assessmentsEqual(assessments, next)) return false;
    this.applySourceAssessments(docName, next);
    return true;
  }

  private reassessDocumentDependents(docName: string): number {
    // Snapshot the union before reassessment mutates the reverse sets.
    const affected = new Set(this.reverseByDoc.get(docName) ?? []);
    for (const key of documentMutationKeys(docName)) {
      for (const source of this.reverseByTolerant.get(key) ?? []) affected.add(source);
    }
    let changed = 0;
    for (const source of affected) {
      if (this.reassessSource(source)) changed += 1;
    }
    return changed;
  }

  private reassessFileDependents(relativePath: string): number {
    const affected = [...(this.reverseByFile.get(relativePath) ?? [])];
    let changed = 0;
    for (const source of affected) {
      if (this.reassessSource(source)) changed += 1;
    }
    return changed;
  }

  private refreshTolerantDocumentIndexes(): void {
    this.tolerantDocumentResolver = createTolerantDocumentResolver(this.documents);
  }

  private async listDocsWithPaths(): Promise<Array<{ docName: string; filePath: string }>> {
    const out: Array<{ docName: string; filePath: string }> = [];
    await this.walkContentDir(this.contentDir, out);
    // Same-stem `.md`/`.mdx` dedupe with `.mdx` precedence, mirroring TagIndex.
    out.sort((a, b) =>
      a.docName === b.docName
        ? b.filePath.localeCompare(a.filePath)
        : a.docName.localeCompare(b.docName),
    );
    const seen = new Set<string>();
    return out.filter(({ docName }) => {
      if (seen.has(docName)) return false;
      seen.add(docName);
      return true;
    });
  }

  private async walkContentDir(
    dir: string,
    out: Array<{ docName: string; filePath: string }>,
  ): Promise<void> {
    const entries = await this.readDirectory(dir);
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        const relDir = toPosix(relative(this.contentDir, fullPath));
        if (this.contentFilter && relDir && this.contentFilter.isDirExcluded(relDir)) continue;
        await this.walkContentDir(fullPath, out);
        continue;
      }
      if (!entry.isFile() || !isSupportedDocFile(entry.name)) continue;
      const relPath = toPosix(relative(this.contentDir, fullPath));
      if (this.contentFilter?.isExcluded(relPath)) continue;
      out.push({ docName: stripDocExtension(relPath), filePath: fullPath });
    }
  }
}
