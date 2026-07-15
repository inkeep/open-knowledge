import { afterEach, describe, expect, mock, test } from 'bun:test';
import {
  CONTENT_CACHE_MAX_ENTRIES,
  deriveContentFields,
  deriveFolderPath,
  extractDocTags,
  loadBacklinkCount,
  loadDocContent,
} from './internal-doc-preview.ts';

describe('deriveFolderPath', () => {
  test('returns the folder segment of a nested docName', () => {
    expect(deriveFolderPath('guides/setup/install')).toBe('guides/setup');
    expect(deriveFolderPath('notes/todo')).toBe('notes');
  });

  test('returns null for a root-level docName', () => {
    expect(deriveFolderPath('readme')).toBe(null);
    expect(deriveFolderPath('')).toBe(null);
  });
});

describe('extractDocTags', () => {
  test('parses a frontmatter tags array', () => {
    const md = '---\ntitle: Doc\ntags: [alpha, beta]\n---\nBody text.';
    expect(extractDocTags(md)).toEqual(['alpha', 'beta']);
  });

  test('accepts a single scalar tag', () => {
    const md = '---\ntags: showcase\n---\nBody.';
    expect(extractDocTags(md)).toEqual(['showcase']);
  });

  test('returns an empty array when there is no frontmatter', () => {
    expect(extractDocTags('Just body text, no frontmatter.')).toEqual([]);
  });

  test('returns an empty array when frontmatter has no tags key', () => {
    expect(extractDocTags('---\ntitle: Doc\n---\nBody.')).toEqual([]);
  });
});

describe('deriveContentFields', () => {
  test('derives tags and an excerpt that excludes frontmatter', () => {
    const md = '---\ntitle: Hidden\ntags: [x]\n---\n# Title\n\nThe body prose to preview.';
    const fields = deriveContentFields(md, null);
    expect(fields.tags).toEqual(['x']);
    expect(fields.excerpt).toBe('The body prose to preview.');
    expect(fields.excerpt).not.toContain('Hidden');
  });

  test('scopes the excerpt to the anchored section', () => {
    const md = '## Overview\n\nOverview text.\n\n## Details\n\nDetails text.';
    const fields = deriveContentFields(md, 'details');
    expect(fields.excerpt).toContain('Details text.');
    expect(fields.excerpt).not.toContain('Overview text.');
  });
});

/**
 * Eviction coverage for the module-level content + backlink caches. Only the
 * network boundary (`globalThis.fetch`) is stubbed; the real caches, LRU touch,
 * and eviction run and are asserted through `loadDocContent` / `loadBacklinkCount`.
 * Each case uses fresh docNames so the module-level caches never bleed across it.
 */
const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

/** Fetch stub that answers both local read endpoints and records the docName of each call. */
function countingFetch(): { docCalls: string[]; backlinkCalls: string[] } {
  const docCalls: string[] = [];
  const backlinkCalls: string[] = [];
  globalThis.fetch = mock((input: RequestInfo | URL) => {
    const url = new URL(String(input), 'http://local');
    if (url.pathname === '/api/document') {
      const docName = url.searchParams.get('docName') ?? '';
      docCalls.push(docName);
      return Promise.resolve(
        jsonResponse({ docName, content: `body of ${docName}`, lifecycle: null }),
      );
    }
    const docName = url.searchParams.get('docNames') ?? '';
    backlinkCalls.push(docName);
    return Promise.resolve(jsonResponse({ counts: { [docName]: 0 } }));
  }) as unknown as typeof fetch;
  return { docCalls, backlinkCalls };
}

let docSeq = 0;
function uniqueDoc(): string {
  docSeq += 1;
  return `evict-doc-${docSeq}`;
}

describe('loadDocContent — bounded LRU content cache', () => {
  test('an entry older than the cap is evicted and re-fetched', async () => {
    const { docCalls } = countingFetch();
    const victim = uniqueDoc();
    await loadDocContent(victim);
    // A full cap of newer entries lands after the victim, so it must be gone
    // regardless of what earlier tests left in the module-level cache.
    for (let i = 0; i < CONTENT_CACHE_MAX_ENTRIES; i += 1) {
      await loadDocContent(uniqueDoc());
    }
    await loadDocContent(victim);
    expect(docCalls.filter((d) => d === victim)).toHaveLength(2);
  });

  test('a cache hit bumps recency, so a re-read doc survives later inserts', async () => {
    const { docCalls } = countingFetch();
    const survivor = uniqueDoc();
    await loadDocContent(survivor);
    for (let i = 0; i < CONTENT_CACHE_MAX_ENTRIES - 1; i += 1) {
      await loadDocContent(uniqueDoc());
    }
    // The survivor is now the oldest entry; this hit must move it to the back.
    await loadDocContent(survivor);
    for (let i = 0; i < CONTENT_CACHE_MAX_ENTRIES - 1; i += 1) {
      await loadDocContent(uniqueDoc());
    }
    // Without the recency bump the fillers above would have evicted it.
    await loadDocContent(survivor);
    expect(docCalls.filter((d) => d === survivor)).toHaveLength(1);
  });
});

describe('loadBacklinkCount — bounded LRU count cache', () => {
  test('an entry older than the cap is evicted and re-fetched', async () => {
    const { backlinkCalls } = countingFetch();
    const victim = uniqueDoc();
    await loadBacklinkCount(victim);
    for (let i = 0; i < CONTENT_CACHE_MAX_ENTRIES; i += 1) {
      await loadBacklinkCount(uniqueDoc());
    }
    await loadBacklinkCount(victim);
    expect(backlinkCalls.filter((d) => d === victim)).toHaveLength(2);
  });
});
