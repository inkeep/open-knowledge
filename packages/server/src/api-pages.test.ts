/**
 * Tests for extractPageTitle — the title extraction logic used by GET /api/pages.
 *
 * Priority: frontmatter `title:` field → first `# heading` line → filename without extension.
 */
import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { createApiExtension, extractHeadings, extractPageTitle } from './api-extension.ts';
import type { FileIndexEntry } from './file-watcher.ts';

describe('extractPageTitle', () => {
  test('returns frontmatter title when present', () => {
    const content = '---\ntitle: My Great Page\nauthor: Alice\n---\n\n# Different Heading\n\nBody.';
    expect(extractPageTitle(content, 'my-great-page')).toBe('My Great Page');
  });

  test('trims whitespace from frontmatter title', () => {
    const content = '---\ntitle:   Trimmed Title   \n---\n\nBody.';
    expect(extractPageTitle(content, 'filename')).toBe('Trimmed Title');
  });

  test('falls through to first heading when frontmatter has no title', () => {
    const content = '---\nauthor: Bob\n---\n\n# First Heading\n\nBody.';
    expect(extractPageTitle(content, 'filename')).toBe('First Heading');
  });

  test('falls through to heading when no frontmatter', () => {
    const content = '# Just a Heading\n\nBody text here.';
    expect(extractPageTitle(content, 'filename')).toBe('Just a Heading');
  });

  test('falls through to filename when no frontmatter title and no heading', () => {
    const content = 'Just plain text with no heading.';
    expect(extractPageTitle(content, 'my-page')).toBe('my-page');
  });

  test('falls through to filename for empty file', () => {
    expect(extractPageTitle('', 'empty-doc')).toBe('empty-doc');
  });

  test('does not pick up title: in the body (outside frontmatter)', () => {
    const content = 'No frontmatter here.\n\ntitle: This is in the body.\n\n# Real Heading\n';
    expect(extractPageTitle(content, 'filename')).toBe('Real Heading');
  });

  test('handles frontmatter with no closing delimiter gracefully — falls to heading', () => {
    // Malformed frontmatter: no closing ---
    const content = '---\ntitle: Orphaned\n\n# Heading\n\nBody.';
    // No closing ---, so frontmatter is not recognized — falls to heading
    expect(extractPageTitle(content, 'filename')).toBe('Heading');
  });

  test('trims ## and deeper headings — only # heading used', () => {
    const content = '## Second Level\n\n### Third Level\n\nBody.';
    // No # heading, falls to filename
    expect(extractPageTitle(content, 'filename')).toBe('filename');
  });

  test('picks up # heading that follows frontmatter', () => {
    const content = '---\ndate: 2026-01-01\n---\n\n# Actual Title\n\nContent.';
    expect(extractPageTitle(content, 'filename')).toBe('Actual Title');
  });

  test('strips double quotes from frontmatter title', () => {
    const content = '---\ntitle: "Quoted: Title"\n---\n\nBody.';
    expect(extractPageTitle(content, 'filename')).toBe('Quoted: Title');
  });

  test('strips single quotes from frontmatter title', () => {
    const content = "---\ntitle: 'Single Quoted'\n---\n\nBody.";
    expect(extractPageTitle(content, 'filename')).toBe('Single Quoted');
  });

  test('does not strip mismatched quotes from frontmatter title', () => {
    const content = '---\ntitle: "Mismatched\'\n---\n\nBody.';
    expect(extractPageTitle(content, 'filename')).toBe('"Mismatched\'');
  });
});

describe('extractHeadings', () => {
  test('deduplicates repeated heading slugs and strips frontmatter before scanning', () => {
    const content = [
      '---',
      'title: Duplicate Heading Test',
      '---',
      '',
      '# Notes',
      '',
      '## Notes',
      '',
      '## 東京',
      '',
      '## 東京',
    ].join('\n');

    expect(extractHeadings(content)).toEqual([
      { level: 1, text: 'Notes', slug: 'notes' },
      { level: 2, text: 'Notes', slug: 'notes-1' },
      { level: 2, text: '東京', slug: '東京' },
      { level: 2, text: '東京', slug: '東京-1' },
    ]);
  });

  test('ignores `#` comments inside fenced code blocks (parity with TipTap DOM output)', () => {
    // Mirrors a case where
    // a `# electron-builder.yml` YAML comment inside a ```yaml fence was being
    // mis-counted as a level-1 heading, shifting every subsequent outline index by one.
    const content = [
      '# Top',
      '',
      '## Section 8.9',
      '',
      '```yaml',
      '# electron-builder.yml',
      'appId: com.example',
      '```',
      '',
      '## Section 9 Risks',
      '',
      '## Section 10 Decision Log',
    ].join('\n');

    expect(extractHeadings(content)).toEqual([
      { level: 1, text: 'Top', slug: 'top' },
      { level: 2, text: 'Section 8.9', slug: 'section-8-9' },
      { level: 2, text: 'Section 9 Risks', slug: 'section-9-risks' },
      { level: 2, text: 'Section 10 Decision Log', slug: 'section-10-decision-log' },
    ]);
  });

  test('ignores `#` comments inside tilde-fenced code blocks too', () => {
    const content = ['# Top', '~~~bash', '# not a heading', '~~~', '## After'].join('\n');
    expect(extractHeadings(content)).toEqual([
      { level: 1, text: 'Top', slug: 'top' },
      { level: 2, text: 'After', slug: 'after' },
    ]);
  });

  test('an unclosed fence swallows the rest of the document', () => {
    const content = ['# Real', '```js', '# inside', '## still inside'].join('\n');
    expect(extractHeadings(content)).toEqual([{ level: 1, text: 'Real', slug: 'real' }]);
  });

  test('strips frontmatter whose opening fence carries a trailing space', () => {
    // `--- ` is one in-tolerance keystroke away from `---`; FM recognition
    // must not flip on it. A YAML comment line inside the FM block would
    // otherwise leak into the outline as a level-1 heading.
    const content = [
      '--- ',
      'title: Fence hazard',
      '# yaml comment, not a heading',
      '---',
      '',
      '# Real Heading',
    ].join('\n');

    expect(extractHeadings(content)).toEqual([
      { level: 1, text: 'Real Heading', slug: 'real-heading' },
    ]);
  });

  test('strips frontmatter whose opening fence carries a trailing tab', () => {
    const content = [
      '---\t',
      'title: Fence hazard',
      '# yaml comment, not a heading',
      '---',
      '',
      '# Real Heading',
    ].join('\n');

    expect(extractHeadings(content)).toEqual([
      { level: 1, text: 'Real Heading', slug: 'real-heading' },
    ]);
  });

  test('strips frontmatter whose closing fence carries trailing whitespace', () => {
    // `extractHeadings` routes through core `stripFrontmatter`; pins that a
    // `--- ` closing line still partitions as FM so YAML comment lines never
    // leak into the outline.
    const content = [
      '---',
      'title: Fence hazard',
      '# yaml comment, not a heading',
      '--- ',
      '',
      '# Real Heading',
    ].join('\n');

    expect(extractHeadings(content)).toEqual([
      { level: 1, text: 'Real Heading', slug: 'real-heading' },
    ]);
  });
});

function makeReq(method: string): IncomingMessage {
  const readable = Readable.from(Buffer.from('')) as unknown as IncomingMessage;
  readable.method = method;
  readable.url = '/api/pages';
  readable.headers = { host: 'localhost' };
  return readable;
}

interface CapturedResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

function makeRes(): { res: ServerResponse; captured: CapturedResponse } {
  const captured: CapturedResponse = { status: 0, headers: {}, body: '' };
  const res = {
    writeHead(status: number, headers?: Record<string, string>) {
      captured.status = status;
      if (headers) Object.assign(captured.headers, headers);
    },
    end(body?: string) {
      captured.body = body ?? '';
    },
  } as unknown as ServerResponse;
  return { res, captured };
}

function buildFileIndex(dir: string, base = ''): ReadonlyMap<string, FileIndexEntry> {
  const index = new Map<string, FileIndexEntry>();
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      for (const [k, v] of buildFileIndex(join(dir, entry.name), rel)) {
        index.set(k, v);
      }
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      const st = statSync(join(dir, entry.name));
      index.set(rel.slice(0, -3), {
        size: st.size,
        modified: st.mtime.toISOString(),
        canonicalPath: join(dir, entry.name),
        inode: st.ino,
        aliases: [],
      });
    }
  }
  return index;
}

async function callPagesWithIndex(
  contentDir: string,
  fileIndex: ReadonlyMap<string, FileIndexEntry>,
  method = 'GET',
): Promise<CapturedResponse> {
  const ext = createApiExtension({
    hocuspocus: {} as unknown as Parameters<typeof createApiExtension>[0]['hocuspocus'],
    sessionManager: {} as unknown as Parameters<typeof createApiExtension>[0]['sessionManager'],
    contentDir,
    getFileIndex: () => fileIndex,
  });
  const req = makeReq(method);
  const { res, captured } = makeRes();
  await (
    ext as {
      onRequest: (ctx: { request: IncomingMessage; response: ServerResponse }) => Promise<void>;
    }
  ).onRequest({ request: req, response: res });
  return captured;
}

async function callPages(contentDir: string, method = 'GET'): Promise<CapturedResponse> {
  // buildFileIndex leaves title/icon unset, so this exercises handlePages'
  // disk-read fallback path (the pre-cache behavior).
  return callPagesWithIndex(contentDir, buildFileIndex(contentDir), method);
}

describe('GET /api/pages', () => {
  test('returns flat { pages } success body and lists markdown files recursively', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ok-pages-'));
    try {
      writeFileSync(join(dir, 'root.md'), '# Root\n', 'utf-8');
      mkdirSync(join(dir, 'nested/deeper'), { recursive: true });
      writeFileSync(join(dir, 'nested/deeper/page.md'), '# Nested Page\n', 'utf-8');

      const result = await callPages(dir);

      expect(result.status).toBe(200);
      const body = JSON.parse(result.body) as {
        ok?: boolean;
        pages?: Array<{ docName: string; title: string; size: number; modified: string }>;
      };
      expect(body.ok).toBeUndefined();
      expect(body.pages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ docName: 'nested/deeper/page', title: 'Nested Page' }),
          expect.objectContaining({ docName: 'root', title: 'Root' }),
        ]),
      );
      // Verify new fields are present
      for (const page of body.pages ?? []) {
        expect(typeof page.size).toBe('number');
        expect(typeof page.modified).toBe('string');
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('surfaces the frontmatter icon scalar on each page entry', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ok-pages-icon-'));
    try {
      writeFileSync(join(dir, 'with-icon.md'), '---\nicon: 📝\n---\n# With Icon\n', 'utf-8');
      writeFileSync(join(dir, 'no-icon.md'), '# No Icon\n', 'utf-8');

      const result = await callPages(dir);
      expect(result.status).toBe(200);
      const body = JSON.parse(result.body) as {
        pages?: Array<{ docName: string; icon?: string }>;
      };
      const byName = new Map((body.pages ?? []).map((p) => [p.docName, p]));
      expect(byName.get('with-icon')?.icon).toBe('📝');
      // Absent icon: the field is either undefined or missing — both
      // are valid JSON-on-the-wire shapes per the optional schema.
      const noIconEntry = byName.get('no-icon');
      expect(noIconEntry).toBeDefined();
      expect(noIconEntry?.icon ?? undefined).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('serves cached title/icon from the index without reading disk', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ok-pages-cache-'));
    try {
      // No file exists on disk. If handlePages re-read the file, the ENOENT
      // catch would fall the title back to the docName ('ghost'). The enriched
      // entry (title present) must instead be served straight from memory —
      // the cache hit is what keeps GET /api/pages O(n)-in-memory, not O(n)-disk.
      const index = new Map<string, FileIndexEntry>([
        [
          'ghost',
          {
            size: 123,
            modified: new Date(0).toISOString(),
            canonicalPath: join(dir, 'ghost.md'),
            inode: 1,
            aliases: [],
            kind: 'markdown',
            title: 'Cached Title',
            icon: '🎯',
          },
        ],
      ]);

      const result = await callPagesWithIndex(dir, index);
      expect(result.status).toBe(200);
      const body = JSON.parse(result.body) as {
        pages?: Array<{ docName: string; title: string; icon?: string }>;
      };
      const entry = (body.pages ?? []).find((p) => p.docName === 'ghost');
      expect(entry?.title).toBe('Cached Title');
      expect(entry?.icon).toBe('🎯');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('bare entry whose file is missing falls back to the docName title (ENOENT path)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ok-pages-bare-'));
    try {
      // Bare entry (no cached title) → handlePages takes the disk-read fallback;
      // the file does not exist, so the ENOENT catch defaults the title to the
      // docName and leaves the icon absent. Pins the safe-default branch.
      const index = new Map<string, FileIndexEntry>([
        [
          'orphan',
          {
            size: 0,
            modified: new Date(0).toISOString(),
            canonicalPath: join(dir, 'orphan.md'),
            inode: 1,
            aliases: [],
            kind: 'markdown',
          },
        ],
      ]);

      const result = await callPagesWithIndex(dir, index);
      expect(result.status).toBe(200);
      const body = JSON.parse(result.body) as {
        pages?: Array<{ docName: string; title: string; icon?: string }>;
      };
      const entry = (body.pages ?? []).find((p) => p.docName === 'orphan');
      expect(entry?.title).toBe('orphan');
      expect(entry?.icon ?? undefined).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('returns RFC 9457 problem+json 405 envelope for unsupported methods', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ok-pages-'));
    try {
      const result = await callPages(dir, 'POST');

      expect(result.status).toBe(405);
      const body = JSON.parse(result.body) as Record<string, unknown>;
      expect(body.type).toBe('urn:ok:error:method-not-allowed');
      expect(body.title).toBe('Method not allowed.');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
