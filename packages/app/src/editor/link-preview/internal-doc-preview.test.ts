import { afterEach, describe, expect, test, vi } from 'vitest';
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

function countingFetch(): { docCalls: string[]; backlinkCalls: string[] } {
  const docCalls: string[] = [];
  const backlinkCalls: string[] = [];
  globalThis.fetch = vi.fn((input: RequestInfo | URL) => {
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
    await loadDocContent(survivor);
    for (let i = 0; i < CONTENT_CACHE_MAX_ENTRIES - 1; i += 1) {
      await loadDocContent(uniqueDoc());
    }
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
