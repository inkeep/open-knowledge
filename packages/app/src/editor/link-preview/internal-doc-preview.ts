/**
 * Data layer for the internal doc-preview card. Assembles a document's preview
 * fields from local sources only: title, folder, and modified time come from
 * the in-memory page-list index (synchronous, elsewhere); tags, excerpt, and
 * backlink count come from the local server over existing read endpoints
 * (`/api/document`, `/api/backlink-counts`) — nothing leaves the machine and
 * no new endpoint is added. Each async field is read independently and omitted
 * on failure so the card renders whatever is ready without blocking.
 */

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
  /** Folder path segment of the docName, or null at the content root. */
  folderPath: string | null;
  /** ISO timestamp of the last local modification, or null when unknown. */
  lastEditedAt: string | null;
  /** Undefined until the document read resolves (or on failure); `[]` when none. */
  tags?: string[];
  /** Undefined until the count read resolves (or on failure). */
  backlinkCount?: number;
  /** Undefined until the document read resolves (or on failure); `''` for an empty body. */
  excerpt?: string;
}

/** Fields derived from a document's raw markdown once the local read resolves. */
export interface InternalDocContentFields {
  tags: string[];
  excerpt: string;
}

/** Folder path segment of a docName, or null when the doc is at the content root. */
export function deriveFolderPath(docName: string): string | null {
  const slashIndex = docName.lastIndexOf('/');
  return slashIndex > 0 ? docName.slice(0, slashIndex) : null;
}

/** Parse frontmatter tags from a document's raw markdown. */
export function extractDocTags(content: string): string[] {
  const { frontmatter } = stripFrontmatter(content);
  if (!frontmatter) return [];
  return extractFrontmatterTags(unwrapFrontmatterFences(frontmatter));
}

/** Derive both content-sourced fields (tags + excerpt) from raw markdown. */
export function deriveContentFields(
  content: string,
  anchor: string | null,
): InternalDocContentFields {
  return {
    tags: extractDocTags(content),
    excerpt: extractDocExcerpt(content, { anchor }),
  };
}

/**
 * Success-cache bound, shared by both per-session caches; exported so the
 * eviction test stays in sync (mirrors external-link-preview's LRU bound).
 */
export const CONTENT_CACHE_MAX_ENTRIES = 128;

// Per-session caches. A hover preview tolerates staleness (an edited or renamed
// target degrades to the pill on real navigation), so successful reads are held
// in a small bounded LRU for the life of the tab (evicted oldest-first once the
// cap is exceeded, so a long session can't grow renderer memory without bound);
// failures are not cached so a transient error retries on the next hover. The
// in-flight maps coalesce concurrent identical reads.
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

/** Read a document's raw markdown from the local server. Cached + single-flight. */
export function loadDocContent(docName: string): Promise<string | null> {
  const cached = contentCache.get(docName);
  if (cached !== undefined) {
    // LRU touch: delete-and-reinsert so the oldest key stays at the Map front.
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
      // A real fault in the local read is surfaced so an endpoint regression is
      // visible; this path threads no abort signal, so any error is genuine.
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

/** Read a document's inbound-link count from the local server. Cached + single-flight. */
export function loadBacklinkCount(docName: string): Promise<number | null> {
  const cached = backlinkCountCache.get(docName);
  if (cached !== undefined) {
    // LRU touch: delete-and-reinsert so the oldest key stays at the Map front.
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
      // A real fault in the local read is surfaced so an endpoint regression is
      // visible; this path threads no abort signal, so any error is genuine.
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
