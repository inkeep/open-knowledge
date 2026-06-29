
import { type Dirent, existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import {
  createTagInTextRegex,
  expandTagToHierarchy,
  extractFrontmatterTags,
  stripFrontmatter,
  tagsMatchingPrefix,
  unwrapFrontmatterFences,
} from '@inkeep/open-knowledge-core';
import { isLinkIndexExcludedDoc } from './cc1-broadcast.ts';
import type { ContentFilter } from './content-filter.ts';
import { isSupportedDocFile, stripDocExtension } from './doc-extensions.ts';
import { toPosix } from './path-utils.ts';

const TAG_VALUE_RE = createTagInTextRegex();

export interface TagSummaryEntry {
  name: string;
  count: number;
  isLeaf: boolean;
}

export interface TagIndexOptions {
  contentDir: string;
  contentFilter?: ContentFilter;
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
  private state: TagIndexState = createEmptyState();
  private initChain: Promise<void> = Promise.resolve();

  constructor(options: TagIndexOptions) {
    this.contentDir = options.contentDir;
    this.contentFilter = options.contentFilter;
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
      console.warn(`[tag-index] Failed to scan ${docName} for tag extraction:`, err);
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
    const run = this.initChain.then(() => this.initOnce());
    this.initChain = run.catch((err) => {
      console.warn('[tag-index] init failed (chain cleared for next init):', err);
    });
    return run;
  }

  private async initOnce(): Promise<void> {
    this.state = createEmptyState();
    if (!existsSync(this.contentDir)) return;
    const entries = await this.listDocsWithPaths();
    const BATCH_SIZE = 50;
    for (let i = 0; i < entries.length; i += BATCH_SIZE) {
      const batch = entries.slice(i, i + BATCH_SIZE);
      const results = await Promise.all(
        batch.map(async ({ docName, filePath }) => {
          try {
            return { docName, markdown: await readFile(filePath, 'utf-8') };
          } catch (err) {
            console.warn(`[tag-index] Failed to read ${docName} during init:`, err);
            return null;
          }
        }),
      );
      for (const result of results) {
        if (!result) continue;
        try {
          this.updateDocumentFromMarkdown(result.docName, result.markdown);
        } catch (err) {
          console.warn(`[tag-index] Failed to index ${result.docName} during init:`, err);
        }
      }
    }
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
      console.warn(`[tag-index] Failed to read directory ${dir}:`, err);
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
