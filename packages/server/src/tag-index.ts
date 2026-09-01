import { type Dirent, existsSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import {
  createTagInTextRegex,
  expandTagToHierarchy,
  extractFrontmatterTags,
  stripFrontmatter,
  tagsMatchingPrefix,
  unwrapFrontmatterFences,
} from '@inkeep/open-knowledge-core';
import { isLinkIndexExcludedDoc } from './cc1-broadcast.ts';
import { getLocalDir } from './config/paths.ts';
import type { ContentFilter } from './content-filter.ts';
import { isSupportedDocFile, stripDocExtension } from './doc-extensions.ts';
import { tracedMkdir, tracedWriteFile } from './fs-traced.ts';
import { instrumentIndexRebuild } from './index-telemetry.ts';
import { getLogger } from './logger.ts';
import { toPosix } from './path-utils.ts';

const log = getLogger('tag-index');

const TAG_VALUE_RE = createTagInTextRegex();

export interface TagSummaryEntry {
  name: string;
  count: number;
  isLeaf: boolean;
}

export interface TagIndexOptions {
  contentDir: string;
  contentFilter?: ContentFilter;
  projectDir?: string;
}

interface FileMeta {
  mtimeMs: number;
  size: number;
}

interface SerializedTagIndexSnapshot {
  version: 1;
  docs: Record<string, string[]>;
  files: Record<string, FileMeta>;
}

const SNAPSHOT_VERSION = 1;

function isValidSnapshot(data: unknown): data is SerializedTagIndexSnapshot {
  if (typeof data !== 'object' || data === null) return false;
  const snapshot = data as Record<string, unknown>;
  if (snapshot.version !== SNAPSHOT_VERSION) return false;
  const { docs, files } = snapshot;
  if (typeof docs !== 'object' || docs === null || Array.isArray(docs)) return false;
  if (typeof files !== 'object' || files === null || Array.isArray(files)) return false;
  for (const tags of Object.values(docs)) {
    if (!Array.isArray(tags)) return false;
    if (!tags.every((tag) => typeof tag === 'string' && tag.length > 0)) return false;
  }
  for (const meta of Object.values(files)) {
    if (typeof meta !== 'object' || meta === null) return false;
    const { mtimeMs, size } = meta as Record<string, unknown>;
    if (typeof mtimeMs !== 'number' || typeof size !== 'number') return false;
  }
  return true;
}

interface TagIndexState {
  byTag: Map<string, Set<string>>;
  byDoc: Map<string, Set<string>>;
  byDocLiteral: Map<string, Set<string>>;
}

function createEmptyState(): TagIndexState {
  return {
    byTag: new Map(),
    byDoc: new Map(),
    byDocLiteral: new Map(),
  };
}

interface TagDocMatch {
  docName: string;
  matchingTags: string[];
}

function stripInlineCodeSpans(line: string): string {
  return line.replace(/`[^`]*`/g, '');
}

function extractInlineTagsFromBody(body: string): string[] {
  const lines = body.replaceAll('\r\n', '\n').split('\n');
  const out: string[] = [];
  let inFence = false;
  let fenceMarker = '';
  for (const line of lines) {
    const fenceMatch = /^\s{0,3}([`~]{3,})/.exec(line);
    if (fenceMatch) {
      if (!inFence) {
        inFence = true;
        fenceMarker = fenceMatch[1];
      } else {
        const closer = new RegExp(
          `^\\s{0,3}${fenceMarker[0] === '`' ? '`' : '~'}{${fenceMarker.length},}\\s*$`,
        );
        if (closer.test(line)) {
          inFence = false;
          fenceMarker = '';
        }
      }
      continue;
    }
    if (inFence) continue;
    const scannable = stripInlineCodeSpans(line);
    TAG_VALUE_RE.lastIndex = 0;
    for (;;) {
      const match = TAG_VALUE_RE.exec(scannable);
      if (match === null) break;
      const value = match[2];
      if (value) out.push(value);
    }
  }
  return out;
}

export class TagIndex {
  private readonly contentDir: string;
  private readonly contentFilter?: ContentFilter;
  private readonly projectDir?: string;
  private state: TagIndexState = createEmptyState();
  private fileMeta = new Map<string, FileMeta>();
  private initChain: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(options: TagIndexOptions) {
    this.contentDir = options.contentDir;
    this.contentFilter = options.contentFilter;
    this.projectDir = options.projectDir;
  }

  private snapshotPath(): string | null {
    if (!this.projectDir) return null;
    return resolve(getLocalDir(this.projectDir), 'cache', 'tags.json');
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.initChain.then(fn);
    this.initChain = run.then(
      () => undefined,
      (err) => {
        log.warn({ err }, 'queued tag-index task failed (chain cleared for next task)');
      },
    );
    return run;
  }

  close(): Promise<void> {
    this.closed = true;
    return this.initChain;
  }

  updateDocumentFromMarkdown(docName: string, markdown: string): void {
    if (isLinkIndexExcludedDoc(docName)) return;
    try {
      const { frontmatter, body } = stripFrontmatter(markdown);
      const yamlBody = frontmatter ? unwrapFrontmatterFences(frontmatter) : '';
      const fmTags = extractFrontmatterTags(yamlBody);
      const inlineTags = extractInlineTagsFromBody(body);

      const authoredTags = new Set<string>([...fmTags, ...inlineTags]);

      const expanded = new Set<string>();
      for (const tag of authoredTags) {
        for (const prefix of expandTagToHierarchy(tag)) {
          expanded.add(prefix);
        }
      }

      this.applyDocSnapshot(docName, authoredTags, expanded);
    } catch (err) {
      log.warn({ docName, err }, `Failed to scan ${docName} for tag extraction`);
      this.deleteDocument(docName);
    }
  }

  deleteDocument(docName: string): void {
    if (isLinkIndexExcludedDoc(docName)) return;
    const prior = this.state.byDoc.get(docName);
    if (!prior) return;
    for (const tag of prior) {
      const docs = this.state.byTag.get(tag);
      if (!docs) continue;
      docs.delete(docName);
      if (docs.size === 0) this.state.byTag.delete(tag);
    }
    this.state.byDoc.delete(docName);
    this.state.byDocLiteral.delete(docName);
  }

  renameDocument(oldDocName: string, newDocName: string, markdown: string): void {
    this.deleteDocument(oldDocName);
    this.updateDocumentFromMarkdown(newDocName, markdown);
  }

  getDocsForTag(tag: string): string[] {
    const docs = this.state.byTag.get(tag);
    if (!docs) return [];
    return [...docs].sort((a, b) => a.localeCompare(b));
  }

  getDocsForTagWithMatches(tag: string): TagDocMatch[] {
    const docs = this.state.byTag.get(tag);
    if (!docs) return [];
    const result: TagDocMatch[] = [];
    for (const docName of docs) {
      const literal = this.state.byDocLiteral.get(docName);
      if (!literal) continue;
      const matching = tagsMatchingPrefix(literal, tag);
      result.push({
        docName,
        matchingTags: [...matching].sort((a, b) => a.localeCompare(b)),
      });
    }
    return result.sort((a, b) => a.docName.localeCompare(b.docName));
  }

  getAllTags(): TagSummaryEntry[] {
    const entries = [...this.state.byTag.entries()];
    const allNames = entries.map(([name]) => name);
    const childPrefixSet = new Set<string>();
    for (const name of allNames) {
      const slashIdx = name.indexOf('/');
      if (slashIdx > 0) childPrefixSet.add(name.slice(0, slashIdx));
      let cursor = slashIdx;
      while (cursor > 0) {
        childPrefixSet.add(name.slice(0, cursor));
        cursor = name.indexOf('/', cursor + 1);
      }
    }
    return entries
      .map(([name, docs]) => ({
        name,
        count: docs.size,
        isLeaf: !childPrefixSet.has(name),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  init(): Promise<void> {
    return this.enqueue(() => instrumentIndexRebuild('tag', 'full', () => this.initOnce()));
  }

  private async initOnce(): Promise<void> {
    if (this.closed) return;
    this.state = createEmptyState();
    this.fileMeta = new Map();
    if (!existsSync(this.contentDir)) return;
    const entries = await this.listDocsWithPaths();
    const BATCH_SIZE = 50;
    for (let i = 0; i < entries.length; i += BATCH_SIZE) {
      const batch = entries.slice(i, i + BATCH_SIZE);
      const results = await Promise.all(
        batch.map(async ({ docName, filePath }) => {
          try {
            const [fileStat, markdown] = await Promise.all([
              stat(filePath),
              readFile(filePath, 'utf-8'),
            ]);
            return { docName, markdown, mtimeMs: fileStat.mtimeMs, size: fileStat.size };
          } catch (err) {
            log.warn({ docName, err }, `Failed to read ${docName} during init`);
            return null;
          }
        }),
      );
      for (const result of results) {
        if (!result) continue;
        try {
          this.updateDocumentFromMarkdown(result.docName, result.markdown);
          this.fileMeta.set(result.docName, { mtimeMs: result.mtimeMs, size: result.size });
        } catch (err) {
          log.warn(
            { docName: result.docName, err },
            `Failed to index ${result.docName} during init`,
          );
        }
      }
    }
  }

  loadFromDisk(): Promise<boolean> {
    return this.enqueue(() => this.loadOnce());
  }

  private async loadOnce(): Promise<boolean> {
    if (this.closed) return false;
    const filePath = this.snapshotPath();
    if (!filePath || !existsSync(filePath)) return false;
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(filePath, 'utf-8'));
    } catch (err) {
      log.warn({ err }, 'Failed to load tag snapshot; falling back to full rebuild');
      return false;
    }
    if (!isValidSnapshot(parsed)) {
      log.warn({}, 'Tag snapshot failed validation; falling back to full rebuild');
      return false;
    }
    this.state = createEmptyState();
    this.fileMeta = new Map(Object.entries(parsed.files));
    for (const [docName, tags] of Object.entries(parsed.docs)) {
      if (isLinkIndexExcludedDoc(docName)) continue;
      const authoredTags = new Set(tags);
      const expanded = new Set<string>();
      for (const tag of authoredTags) {
        for (const prefix of expandTagToHierarchy(tag)) {
          expanded.add(prefix);
        }
      }
      this.applyDocSnapshot(docName, authoredTags, expanded);
    }
    return true;
  }

  saveToDisk(): Promise<void> {
    return this.enqueue(() => this.saveOnce());
  }

  private async saveOnce(): Promise<void> {
    if (this.closed) return;
    const filePath = this.snapshotPath();
    if (!filePath) return;
    const snapshot: SerializedTagIndexSnapshot = {
      version: SNAPSHOT_VERSION,
      docs: Object.fromEntries(
        [...this.state.byDocLiteral.entries()].map(([docName, tags]) => [
          docName,
          [...tags].sort((a, b) => a.localeCompare(b)),
        ]),
      ),
      files: Object.fromEntries(this.fileMeta),
    };
    await tracedMkdir(dirname(filePath), { recursive: true });
    await tracedWriteFile(filePath, JSON.stringify(snapshot, null, 2), 'utf-8');
  }

  reconcileWithDisk(): Promise<{ added: number; updated: number; deleted: number }> {
    return this.enqueue(() =>
      instrumentIndexRebuild(
        'tag',
        'reconcile',
        () => this.reconcileOnce(),
        (diff) => ({
          'index.added': diff.added,
          'index.updated': diff.updated,
          'index.deleted': diff.deleted,
        }),
      ),
    );
  }

  private async reconcileOnce(): Promise<{ added: number; updated: number; deleted: number }> {
    if (this.closed || !existsSync(this.contentDir)) return { added: 0, updated: 0, deleted: 0 };
    const docs = await this.listDocsWithPaths();
    const currentDocSet = new Set(docs.map((d) => d.docName));
    const newMeta = new Map<string, FileMeta>();
    let added = 0;
    let updated = 0;

    const toProcess: Array<{ docName: string; filePath: string; meta: FileMeta; isNew: boolean }> =
      [];
    const statResults = await Promise.allSettled(
      docs.map(async ({ docName, filePath }) => {
        const fileStat = await stat(filePath);
        return { docName, filePath, meta: { mtimeMs: fileStat.mtimeMs, size: fileStat.size } };
      }),
    );
    for (const result of statResults) {
      if (result.status === 'rejected') continue;
      const { docName, filePath, meta } = result.value;
      const stored = this.fileMeta.get(docName);
      if (stored !== undefined && stored.mtimeMs === meta.mtimeMs && stored.size === meta.size) {
        newMeta.set(docName, meta);
        continue;
      }
      toProcess.push({ docName, filePath, meta, isNew: stored === undefined });
    }

    const BATCH_SIZE = 50;
    for (let i = 0; i < toProcess.length; i += BATCH_SIZE) {
      const batch = toProcess.slice(i, i + BATCH_SIZE);
      const settled = await Promise.allSettled(
        batch.map(async ({ docName, meta, isNew, filePath }) => ({
          docName,
          meta,
          isNew,
          markdown: await readFile(filePath, 'utf-8'),
        })),
      );
      for (const result of settled) {
        if (result.status === 'rejected') {
          log.warn({ err: result.reason }, 'Failed to reconcile file');
          continue;
        }
        const { docName, meta, isNew, markdown } = result.value;
        this.updateDocumentFromMarkdown(docName, markdown);
        newMeta.set(docName, meta);
        if (isNew) added++;
        else updated++;
      }
    }

    let deleted = 0;
    const allKnownDocs = new Set([...this.fileMeta.keys(), ...this.state.byDoc.keys()]);
    for (const docName of allKnownDocs) {
      if (!currentDocSet.has(docName)) {
        this.deleteDocument(docName);
        deleted++;
      }
    }

    this.fileMeta = newMeta;
    return { added, updated, deleted };
  }

  private applyDocSnapshot(
    docName: string,
    authoredTags: Set<string>,
    expanded: Set<string>,
  ): void {
    const prior = this.state.byDoc.get(docName) ?? new Set<string>();

    for (const tag of prior) {
      if (expanded.has(tag)) continue;
      const docs = this.state.byTag.get(tag);
      if (!docs) continue;
      docs.delete(docName);
      if (docs.size === 0) this.state.byTag.delete(tag);
    }

    for (const tag of expanded) {
      let docs = this.state.byTag.get(tag);
      if (!docs) {
        docs = new Set();
        this.state.byTag.set(tag, docs);
      }
      docs.add(docName);
    }

    if (expanded.size === 0) {
      this.state.byDoc.delete(docName);
      this.state.byDocLiteral.delete(docName);
    } else {
      this.state.byDoc.set(docName, expanded);
      this.state.byDocLiteral.set(docName, authoredTags);
    }
  }

  private async listDocsWithPaths(): Promise<Array<{ docName: string; filePath: string }>> {
    const out: Array<{ docName: string; filePath: string }> = [];
    await this.walkContentDir(this.contentDir, out);
    out.sort((a, b) => {
      if (a.docName !== b.docName) return a.docName.localeCompare(b.docName);
      return b.filePath.localeCompare(a.filePath);
    });
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
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (err) {
      log.warn({ dir, err }, `Failed to read directory ${dir}`);
      return;
    }
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
