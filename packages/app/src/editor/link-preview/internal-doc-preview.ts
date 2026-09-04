import {
  BacklinkCountsSuccessSchema,
  DocumentReadSuccessSchema,
  extractFrontmatterTags,
  stripFrontmatter,
  unwrapFrontmatterFences,
} from '@inkeep/open-knowledge-core';
import { extractDocExcerpt } from './doc-excerpt.ts';

export interface InternalDocPreview {
  docName: string;
  title: string;
  folderPath: string | null;
  lastEditedAt: string | null;
  tags?: string[];
  backlinkCount?: number;
  excerpt?: string;
}

export interface InternalDocContentFields {
  tags: string[];
  excerpt: string;
}

export function deriveFolderPath(docName: string): string | null {
  const slashIndex = docName.lastIndexOf('/');
  return slashIndex > 0 ? docName.slice(0, slashIndex) : null;
}

export function extractDocTags(content: string): string[] {
  const { frontmatter } = stripFrontmatter(content);
  if (!frontmatter) return [];
  return extractFrontmatterTags(unwrapFrontmatterFences(frontmatter));
}

export function deriveContentFields(
  content: string,
  anchor: string | null,
): InternalDocContentFields {
  return {
    tags: extractDocTags(content),
    excerpt: extractDocExcerpt(content, { anchor }),
  };
}

export const CONTENT_CACHE_MAX_ENTRIES = 128;

const contentCache = new Map<string, string>();
const backlinkCountCache = new Map<string, number>();
const inflightContent = new Map<string, Promise<string | null>>();
const inflightBacklink = new Map<string, Promise<number | null>>();

async function fetchDocContent(docName: string): Promise<string> {
  const res = await fetch(`/api/document?docName=${encodeURIComponent(docName)}`);
  if (!res.ok) throw new Error(`document read failed: ${res.status}`);
  return DocumentReadSuccessSchema.parse(await res.json()).content;
}

async function fetchBacklinkCount(docName: string): Promise<number> {
  const res = await fetch(`/api/backlink-counts?docNames=${encodeURIComponent(docName)}`);
  if (!res.ok) throw new Error(`backlink-counts failed: ${res.status}`);
  const { counts } = BacklinkCountsSuccessSchema.parse(await res.json());
  return counts[docName] ?? 0;
}

export function loadDocContent(docName: string): Promise<string | null> {
  const cached = contentCache.get(docName);
  if (cached !== undefined) {
    contentCache.delete(docName);
    contentCache.set(docName, cached);
    return Promise.resolve(cached);
  }
  const existing = inflightContent.get(docName);
  if (existing) return existing;
  const promise = (async () => {
    try {
      const content = await fetchDocContent(docName);
      contentCache.set(docName, content);
      while (contentCache.size > CONTENT_CACHE_MAX_ENTRIES) {
        const oldest = contentCache.keys().next().value;
        if (oldest === undefined) break;
        contentCache.delete(oldest);
      }
      return content;
    } catch (err) {
      if (!(err instanceof Error) || err.name !== 'AbortError') {
        console.warn(
          '[link-preview] internal doc read failed:',
          err instanceof Error ? err.message : String(err),
        );
      }
      return null;
    } finally {
      inflightContent.delete(docName);
    }
  })();
  inflightContent.set(docName, promise);
  return promise;
}

export function loadBacklinkCount(docName: string): Promise<number | null> {
  const cached = backlinkCountCache.get(docName);
  if (cached !== undefined) {
    backlinkCountCache.delete(docName);
    backlinkCountCache.set(docName, cached);
    return Promise.resolve(cached);
  }
  const existing = inflightBacklink.get(docName);
  if (existing) return existing;
  const promise = (async () => {
    try {
      const count = await fetchBacklinkCount(docName);
      backlinkCountCache.set(docName, count);
      while (backlinkCountCache.size > CONTENT_CACHE_MAX_ENTRIES) {
        const oldest = backlinkCountCache.keys().next().value;
        if (oldest === undefined) break;
        backlinkCountCache.delete(oldest);
      }
      return count;
    } catch (err) {
      if (!(err instanceof Error) || err.name !== 'AbortError') {
        console.warn(
          '[link-preview] backlink-count read failed:',
          err instanceof Error ? err.message : String(err),
        );
      }
      return null;
    } finally {
      inflightBacklink.delete(docName);
    }
  })();
  inflightBacklink.set(docName, promise);
  return promise;
}
