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

function projectableAssessments(
  assessments: readonly LocalTargetAssessment[],
): LocalTargetAssessment[] {
  return assessments.filter((assessment) =>
    isProjectableToLocalTargetSurfaces(assessment.occurrence),
  );
}

export interface LocalTargetSourceAssessments {
  source: string;
  assessments: readonly LocalTargetAssessment[];
}

export interface LocalTargetIndexStats {
  sources: number;
  occurrences: number;
  documentTargets: number;
  fileTargets: number;
}

export interface LocalTargetIndexOptions {
  contentDir: string;
  contentFilter?: ContentFilter;
  readDocument?: (filePath: string) => Promise<string>;
  readDirectory?: (dir: string) => Promise<Dirent[]>;
}

export interface LocalTargetRebuildResult {
  sources: number;
  occurrences: number;
}

export interface LocalTargetRebuildInventory {
  documentTargets: Iterable<string>;
  fileTargets: Iterable<string>;
  folderTargets?: Iterable<string>;
}

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
  if (assessment.occurrence.role === 'link') {
    const classified = classifyMarkdownHref(assessment.occurrence.href, sourceDocName);
    if (classified?.kind === 'doc') {
      docs.push(classified.docName);
      const filePath = resolveAssetProjectPath(assessment.occurrence.href, sourceDocName, {
        literal: false,
      });
      if (filePath === classified.docName) files.push(filePath);
    }
  }
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
  let slash = docName.indexOf('/');
  while (slash !== -1) {
    keys.push(`folder:${docName.slice(0, slash)}`);
    slash = docName.indexOf('/', slash + 1);
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

  private sourceAssessments = new Map<string, LocalTargetAssessment[]>();
  private sourceDocDeps = new Map<string, Set<string>>();
  private sourceFileDeps = new Map<string, Set<string>>();
  private reverseByDoc = new Map<string, Set<string>>();
  private reverseByFile = new Map<string, Set<string>>();
  private reverseByTolerant = new Map<string, Set<string>>();
  private sourceTolerantDeps = new Map<string, Set<string>>();

  private documents = new Set<string>();
  private tolerantDocumentResolver: (docName: string) => string | null = () => null;
  private files = new Set<string>();

  private generationValue = 0;
  private freshnessEpoch = 0;
  private readyValue = false;
  private closed = false;

  private folderPaths = new Set<string>();
  private injectedFolderPaths = new Set<string>();

  private readonly inventory: LocalTargetInventory = {
    hasDocument: (docName) => this.documents.has(docName),
    hasFile: (relativePath) => this.files.has(relativePath),
    resolveTolerantDocument: (docName) => this.tolerantDocumentResolver(docName),
    hasFolder: (folderPath) =>
      this.folderPaths.has(folderPath) || this.injectedFolderPaths.has(folderPath),
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

  get generation(): number {
    return this.generationValue;
  }

  isReady(): boolean {
    return this.readyValue;
  }

  markUnavailable(): void {
    if (this.readyValue) this.freshnessEpoch++;
    this.readyValue = false;
  }

  get freshnessToken(): string {
    return `${this.generationValue}:${this.freshnessEpoch}`;
  }

  getAssessments(docName: string): readonly LocalTargetAssessment[] {
    return this.sourceAssessments.get(docName) ?? [];
  }

  getAssessmentsForSources(sourceDocNames?: readonly string[]): LocalTargetSourceAssessments[] {
    const filter = sourceDocNames && sourceDocNames.length > 0 ? new Set(sourceDocNames) : null;
    const out: LocalTargetSourceAssessments[] = [];
    for (const [source, assessments] of this.sourceAssessments) {
      if (filter && !filter.has(source)) continue;
      out.push({ source, assessments });
    }
    return out;
  }

  getDocumentDependents(docName: string): string[] {
    const sources = new Set(this.reverseByDoc.get(docName) ?? []);
    for (const key of documentMutationKeys(docName)) {
      for (const source of this.reverseByTolerant.get(key) ?? []) sources.add(source);
    }
    return [...sources].sort((a, b) => a.localeCompare(b));
  }

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

  renameSource(oldDocName: string, newDocName: string, markdown: string): boolean {
    const removed = this.removeSource(oldDocName);
    const set = this.setSource(newDocName, markdown);
    return removed || set;
  }

  setFileTarget(relativePath: string, exists: boolean): number {
    if (this.files.has(relativePath) === exists) return 0;
    const update = instrumentIndexUpdate(
      'local-target',
      'file-target',
      () => {
        if (exists) this.files.add(relativePath);
        else this.files.delete(relativePath);
        const occurrences = this.countFileOccurrences(relativePath);
        const affected = this.reassessFileDependents(relativePath);
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

  reconcileFolderTargets(folderTargets: Iterable<string>): number {
    const next = new Set(folderTargets);
    const changedFolders = new Set<string>();
    for (const folderPath of this.injectedFolderPaths) {
      if (!next.has(folderPath)) changedFolders.add(folderPath);
    }
    for (const folderPath of next) {
      if (!this.injectedFolderPaths.has(folderPath)) changedFolders.add(folderPath);
    }
    if (changedFolders.size === 0) return 0;

    const affected = new Set<string>();
    for (const folderPath of changedFolders) {
      for (const source of this.reverseByTolerant.get(`folder:${folderPath}`) ?? []) {
        affected.add(source);
      }
    }
    this.injectedFolderPaths = next;
    let reassessed = 0;
    for (const source of affected) {
      if (this.reassessSource(source)) reassessed++;
    }
    if (reassessed > 0) this.generationValue++;
    return reassessed;
  }

  reconcileFileTargets(fileTargets: Iterable<string>): number {
    const next = new Set(fileTargets);
    const changedIdentities = new Set<string>();
    for (const relativePath of this.files) {
      if (!next.has(relativePath)) changedIdentities.add(relativePath);
    }
    for (const relativePath of next) {
      if (!this.files.has(relativePath)) changedIdentities.add(relativePath);
    }
    if (changedIdentities.size === 0) return 0;

    return instrumentIndexUpdate(
      'local-target',
      'file-target',
      () => {
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
    this.folderPaths = staged.folderPaths;
    this.injectedFolderPaths = staged.injectedFolderPaths;
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
    for (const folderPath of inventory.folderTargets ?? []) {
      this.injectedFolderPaths.add(folderPath);
    }
    this.refreshTolerantDocumentIndexes();

    if (!existsSync(this.contentDir)) {
      this.readyValue = true;
      return { sources: 0, occurrences: 0 };
    }

    const docs = await this.listDocsWithPaths();
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
        assessment.resolvedTarget !== null &&
        (assessment.status !== 'exact' || !this.documents.has(assessment.resolvedTarget))
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
    const folderPaths = new Set<string>();
    for (const docName of this.documents) {
      let slash = docName.indexOf('/');
      while (slash !== -1) {
        folderPaths.add(docName.slice(0, slash));
        slash = docName.indexOf('/', slash + 1);
      }
    }
    this.folderPaths = folderPaths;
  }

  private async listDocsWithPaths(): Promise<Array<{ docName: string; filePath: string }>> {
    const out: Array<{ docName: string; filePath: string }> = [];
    await this.walkContentDir(this.contentDir, out);
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
