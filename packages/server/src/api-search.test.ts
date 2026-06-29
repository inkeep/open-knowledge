import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import {
  createApiExtension,
  DEFAULT_SEARCH_MAX_ENTRIES,
  getSearchMaxEntries,
} from './api-extension.ts';
import type { FileIndexEntry } from './file-watcher.ts';

interface CapturedResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

function makeReq(method: string, url: string, body = ''): IncomingMessage {
  const readable = Readable.from(Buffer.from(body)) as unknown as IncomingMessage;
  readable.method = method;
  readable.url = url;
  readable.headers = { host: 'localhost' };
  return readable;
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
      for (const [key, value] of buildFileIndex(join(dir, entry.name), rel)) {
        index.set(key, value);
      }
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      const stat = statSync(join(dir, entry.name));
      index.set(rel.slice(0, -3), {
        size: stat.size,
        modified: stat.mtime.toISOString(),
        canonicalPath: join(dir, entry.name),
        inode: stat.ino,
        aliases: [],
        kind: 'markdown',
      });
    }
  }
  return index;
}

async function callSearch(contentDir: string, url: string, method = 'GET', body = '') {
  const fileIndex = buildFileIndex(contentDir);
  const ext = createApiExtension({
    hocuspocus: {} as unknown as Parameters<typeof createApiExtension>[0]['hocuspocus'],
    sessionManager: {} as unknown as Parameters<typeof createApiExtension>[0]['sessionManager'],
    contentDir,
    serverInstanceId: 'test-server',
    getFileIndex: () => fileIndex,
  });
  const req = makeReq(method, url, body);
  const { res, captured } = makeRes();
  await (
    ext as {
      onRequest: (ctx: { request: IncomingMessage; response: ServerResponse }) => Promise<void>;
    }
  ).onRequest({ request: req, response: res });
  return captured;
}

describe('GET /api/search', () => {
  test('returns page and folder entity matches for omnibar intent', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ok-search-'));
    try {
      mkdirSync(join(dir, 'architecture'), { recursive: true });
      writeFileSync(join(dir, 'architecture/overview.md'), '# System Overview\n', 'utf-8');
      writeFileSync(join(dir, 'api.md'), '# API\n', 'utf-8');

      const result = await callSearch(dir, '/api/search?query=arch&intent=omnibar');
      expect(result.status).toBe(200);
      const body = JSON.parse(result.body) as {
        results?: Array<{ kind: string; path: string }>;
      };

      expect(body.results?.map((row) => `${row.kind}:${row.path}`)).toEqual([
        'folder:architecture',
        'page:architecture/overview',
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('ranking param orders the same full_text candidate set: navigation by name, relevance by body', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ok-search-ranking-'));
    try {
      writeFileSync(join(dir, 'STORY.md'), '# Collaboration\n\nNotes about teamwork.\n', 'utf-8');
      writeFileSync(
        join(dir, 'storybook-notes.md'),
        '# Storyboard\n\nstory story story story story story story story\n',
        'utf-8',
      );
      const index = new Map<string, FileIndexEntry>([
        ['STORY', indexEntry(join(dir, 'STORY.md'), 'markdown')],
        ['storybook-notes', indexEntry(join(dir, 'storybook-notes.md'), 'markdown')],
      ]);

      const nav = JSON.parse(
        (await runSearch(dir, index, '/api/search?query=story&intent=full_text&ranking=navigation'))
          .body,
      ) as { results: Array<{ path: string }> };
      expect(nav.results[0]?.path).toBe('STORY');

      const rel = JSON.parse(
        (await runSearch(dir, index, '/api/search?query=story&intent=full_text&ranking=relevance'))
          .body,
      ) as { results: Array<{ path: string }> };
      expect(rel.results[0]?.path).toBe('storybook-notes');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('returns full-text content matches with snippets', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ok-search-'));
    try {
      writeFileSync(
        join(dir, 'bridge.md'),
        '# Bridge\n\nObserver bridge keeps CRDT views synchronized.\n',
        'utf-8',
      );
      writeFileSync(join(dir, 'api.md'), '# API\n\nEndpoint list.\n', 'utf-8');

      const result = await callSearch(dir, '/api/search?query=crdt&intent=full_text');
      expect(result.status).toBe(200);
      const body = JSON.parse(result.body) as {
        results?: Array<{ kind: string; path: string; snippet?: string }>;
      };

      expect(body.results?.[0]).toEqual(
        expect.objectContaining({
          kind: 'page',
          path: 'bridge',
          snippet: expect.stringContaining('CRDT'),
        }),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('supports POST bodies for shared search clients', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ok-search-'));
    try {
      writeFileSync(join(dir, 'release-notes.md'), '# Release Notes\n', 'utf-8');

      const result = await callSearch(
        dir,
        '/api/search',
        'POST',
        JSON.stringify({ query: 'release', intent: 'autocomplete', scopes: ['page'] }),
      );
      expect(result.status).toBe(200);
      const body = JSON.parse(result.body) as {
        results?: Array<{ path: string }>;
      };

      expect(body.results?.map((row) => row.path)).toEqual(['release-notes']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('indexes project skills under their content-doc path (findable by content)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ok-search-'));
    try {
      const skillDir = join(dir, '.ok', 'skills', 'data-pipeline');
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(
        join(skillDir, 'SKILL.md'),
        '---\nname: data-pipeline\ndescription: Ingest and normalize telemetry.\n---\n\nUse this when wrangling zephyrglyph datasets.\n',
        'utf-8',
      );

      const result = await callSearch(dir, '/api/search?query=zephyrglyph&intent=full_text');
      expect(result.status).toBe(200);
      const body = JSON.parse(result.body) as {
        results?: Array<{ kind: string; path: string }>;
      };
      const skillHits = (body.results ?? []).filter(
        (r) => r.path === '.ok/skills/data-pipeline/SKILL',
      );
      expect(skillHits).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('returns 400 for malformed POST bodies', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ok-search-'));
    try {
      const result = await callSearch(dir, '/api/search', 'POST', '{not json');

      expect(result.status).toBe(400);
      const body = JSON.parse(result.body) as { type: string };
      expect(body.type).toBe('urn:ok:error:invalid-request');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('returns 413 for oversized POST bodies', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ok-search-'));
    try {
      const result = await callSearch(dir, '/api/search', 'POST', 'x'.repeat(1_048_577));

      expect(result.status).toBe(413);
      const body = JSON.parse(result.body) as { type: string };
      expect(body.type).toBe('urn:ok:error:payload-too-large');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

function indexEntry(canonicalPath: string, kind: FileIndexEntry['kind']): FileIndexEntry {
  const stat = statSync(canonicalPath);
  return {
    size: stat.size,
    modified: stat.mtime.toISOString(),
    canonicalPath,
    inode: stat.ino,
    aliases: [],
    kind,
  };
}

async function runSearch(
  contentDir: string,
  allFilesIndex: ReadonlyMap<string, FileIndexEntry>,
  url: string,
  method = 'GET',
  body = '',
): Promise<CapturedResponse> {
  const markdownOnly = new Map([...allFilesIndex].filter(([, entry]) => entry.kind === 'markdown'));
  const ext = createApiExtension({
    hocuspocus: {} as unknown as Parameters<typeof createApiExtension>[0]['hocuspocus'],
    sessionManager: {} as unknown as Parameters<typeof createApiExtension>[0]['sessionManager'],
    contentDir,
    serverInstanceId: 'test-server',
    getFileIndex: () => markdownOnly,
    getAllFilesIndex: () => allFilesIndex,
  });
  const req = makeReq(method, url, body);
  const { res, captured } = makeRes();
  await (
    ext as {
      onRequest: (ctx: { request: IncomingMessage; response: ServerResponse }) => Promise<void>;
    }
  ).onRequest({ request: req, response: res });
  return captured;
}

function resultPaths(captured: CapturedResponse): string[] {
  const body = JSON.parse(captured.body) as { results?: Array<{ path: string }> };
  return (body.results ?? []).map((row) => row.path);
}

describe('GET /api/search — all-files coverage', () => {
  test('a non-markdown file is returned as a kind:file result with no content snippet', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ok-search-files-'));
    try {
      writeFileSync(join(dir, 'guide.md'), '# Guide\n\nReference body.\n', 'utf-8');
      writeFileSync(join(dir, 'data.csv'), 'a,b\n1,2\n', 'utf-8');
      const index = new Map<string, FileIndexEntry>([
        ['guide', indexEntry(join(dir, 'guide.md'), 'markdown')],
        ['data.csv', indexEntry(join(dir, 'data.csv'), 'file')],
      ]);

      const captured = await runSearch(dir, index, '/api/search?query=data.csv&intent=omnibar');
      expect(captured.status).toBe(200);
      const body = JSON.parse(captured.body) as {
        results: Array<{ kind: string; path: string; snippet?: string }>;
      };
      const hit = body.results.find((row) => row.path === 'data.csv');
      expect(hit).toBeDefined();
      expect(hit?.kind).toBe('file');
      expect(hit?.snippet).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('the search corpus is built from the index, not the disk — a file pruned from the index is not searchable (AC4)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ok-search-ac4-'));
    try {
      writeFileSync(join(dir, 'guide.md'), '# Guide\n', 'utf-8');
      writeFileSync(join(dir, 'present.log'), 'x', 'utf-8');
      writeFileSync(join(dir, 'pruned.log'), 'x', 'utf-8');
      const index = new Map<string, FileIndexEntry>([
        ['guide', indexEntry(join(dir, 'guide.md'), 'markdown')],
        ['present.log', indexEntry(join(dir, 'present.log'), 'file')],
      ]);

      expect(resultPaths(await runSearch(dir, index, '/api/search?query=present.log'))).toContain(
        'present.log',
      );
      expect(
        resultPaths(await runSearch(dir, index, '/api/search?query=pruned.log')),
      ).not.toContain('pruned.log');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('changing a non-markdown file invalidates the corpus cache (fingerprint covers kind:file)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ok-search-fp-'));
    try {
      writeFileSync(join(dir, 'guide.md'), '# Guide\n', 'utf-8');
      writeFileSync(join(dir, 'first.csv'), 'x', 'utf-8');
      const index = new Map<string, FileIndexEntry>([
        ['guide', indexEntry(join(dir, 'guide.md'), 'markdown')],
        ['first.csv', indexEntry(join(dir, 'first.csv'), 'file')],
      ]);
      const getAll = () => index;
      const markdownOnly = () =>
        new Map([...index].filter(([, entry]) => entry.kind === 'markdown'));
      const ext = createApiExtension({
        hocuspocus: {} as unknown as Parameters<typeof createApiExtension>[0]['hocuspocus'],
        sessionManager: {} as unknown as Parameters<typeof createApiExtension>[0]['sessionManager'],
        contentDir: dir,
        serverInstanceId: 'test-server',
        getFileIndex: markdownOnly,
        getAllFilesIndex: getAll,
      });
      const run = async (url: string): Promise<string[]> => {
        const req = makeReq('GET', url);
        const { res, captured } = makeRes();
        await (
          ext as {
            onRequest: (ctx: {
              request: IncomingMessage;
              response: ServerResponse;
            }) => Promise<void>;
          }
        ).onRequest({ request: req, response: res });
        return resultPaths(captured);
      };

      expect(await run('/api/search?query=second.csv')).not.toContain('second.csv');

      writeFileSync(join(dir, 'second.csv'), 'y', 'utf-8');
      index.set('second.csv', indexEntry(join(dir, 'second.csv'), 'file'));

      expect(await run('/api/search?query=second.csv')).toContain('second.csv');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('GET /api/search — folder synthesis from all paths', () => {
  test('a folder containing only non-markdown files appears as a folder result (AC2)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ok-search-folder-'));
    try {
      writeFileSync(join(dir, 'guide.md'), '# Guide\n', 'utf-8');
      mkdirSync(join(dir, 'assets'), { recursive: true });
      writeFileSync(join(dir, 'assets', 'logo.png'), 'x', 'utf-8');
      const index = new Map<string, FileIndexEntry>([
        ['guide', indexEntry(join(dir, 'guide.md'), 'markdown')],
        ['assets/logo.png', indexEntry(join(dir, 'assets', 'logo.png'), 'file')],
      ]);

      const captured = await runSearch(dir, index, '/api/search?query=assets&intent=omnibar');
      expect(captured.status).toBe(200);
      const body = JSON.parse(captured.body) as { results: Array<{ kind: string; path: string }> };
      expect(body.results.some((r) => r.kind === 'folder' && r.path === 'assets')).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a partial folder-path query resolves a markdown-free folder (AC16)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ok-search-folderpath-'));
    try {
      writeFileSync(join(dir, 'readme.md'), '# Root\n', 'utf-8');
      const deep = join(dir, 'packages', 'server', 'src');
      mkdirSync(deep, { recursive: true });
      writeFileSync(join(deep, 'server-factory.ts'), 'export {};\n', 'utf-8');
      const index = new Map<string, FileIndexEntry>([
        ['readme', indexEntry(join(dir, 'readme.md'), 'markdown')],
        [
          'packages/server/src/server-factory.ts',
          indexEntry(join(deep, 'server-factory.ts'), 'file'),
        ],
      ]);

      const captured = await runSearch(
        dir,
        index,
        `/api/search?query=${encodeURIComponent('server/src')}&intent=omnibar`,
      );
      expect(captured.status).toBe(200);
      const body = JSON.parse(captured.body) as { results: Array<{ kind: string; path: string }> };
      expect(
        body.results.some((r) => r.kind === 'folder' && r.path === 'packages/server/src'),
      ).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('GET /api/search — name-only file tier admission cap (D6)', () => {
  const KEY = 'OK_SEARCH_MAX_ENTRIES';

  test('caps the file tier deepest-first, keeps markdown, and signals truncated (AC6)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ok-search-cap-'));
    const prev = process.env[KEY];
    process.env[KEY] = '2';
    try {
      writeFileSync(join(dir, 'data-notes.md'), '# Data Notes\n', 'utf-8');
      writeFileSync(join(dir, 'data-a.txt'), 'x', 'utf-8');
      mkdirSync(join(dir, 'x'), { recursive: true });
      writeFileSync(join(dir, 'x', 'data-b.txt'), 'x', 'utf-8');
      mkdirSync(join(dir, 'x', 'y'), { recursive: true });
      writeFileSync(join(dir, 'x', 'y', 'data-c.txt'), 'x', 'utf-8');
      const index = new Map<string, FileIndexEntry>([
        ['data-notes', indexEntry(join(dir, 'data-notes.md'), 'markdown')],
        ['data-a.txt', indexEntry(join(dir, 'data-a.txt'), 'file')],
        ['x/data-b.txt', indexEntry(join(dir, 'x', 'data-b.txt'), 'file')],
        ['x/y/data-c.txt', indexEntry(join(dir, 'x', 'y', 'data-c.txt'), 'file')],
      ]);

      const captured = await runSearch(
        dir,
        index,
        '/api/search?query=data&intent=omnibar&limit=100',
      );
      expect(captured.status).toBe(200);
      const body = JSON.parse(captured.body) as {
        truncated?: boolean;
        results: Array<{ kind: string; path: string }>;
      };
      const paths = body.results.map((r) => r.path);
      expect(body.truncated).toBe(true);
      expect(paths).toContain('data-a.txt');
      expect(paths).toContain('x/data-b.txt');
      expect(paths).not.toContain('x/y/data-c.txt');
      expect(paths).toContain('data-notes');
    } finally {
      if (prev === undefined) delete process.env[KEY];
      else process.env[KEY] = prev;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('no truncated flag when the file tier is under the cap', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ok-search-uncapped-'));
    const prev = process.env[KEY];
    process.env[KEY] = '1000';
    try {
      writeFileSync(join(dir, 'report.csv'), 'x', 'utf-8');
      const index = new Map<string, FileIndexEntry>([
        ['report.csv', indexEntry(join(dir, 'report.csv'), 'file')],
      ]);
      const captured = await runSearch(dir, index, '/api/search?query=report&intent=omnibar');
      const body = JSON.parse(captured.body) as { truncated?: boolean };
      expect(body.truncated).toBeUndefined();
    } finally {
      if (prev === undefined) delete process.env[KEY];
      else process.env[KEY] = prev;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('cap tie-break: at equal depth the locale-earlier path wins', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ok-search-tiebreak-'));
    const prev = process.env[KEY];
    process.env[KEY] = '1';
    try {
      writeFileSync(join(dir, 'data-aaa.csv'), 'x', 'utf-8');
      writeFileSync(join(dir, 'data-bbb.csv'), 'x', 'utf-8');
      const index = new Map<string, FileIndexEntry>([
        ['data-aaa.csv', indexEntry(join(dir, 'data-aaa.csv'), 'file')],
        ['data-bbb.csv', indexEntry(join(dir, 'data-bbb.csv'), 'file')],
      ]);
      const captured = await runSearch(dir, index, '/api/search?query=data&intent=omnibar');
      const body = JSON.parse(captured.body) as {
        truncated?: boolean;
        results: Array<{ kind: string; path: string }>;
      };
      expect(body.truncated).toBe(true);
      const filePaths = body.results.filter((r) => r.kind === 'file').map((r) => r.path);
      expect(filePaths).toContain('data-aaa.csv');
      expect(filePaths).not.toContain('data-bbb.csv');
    } finally {
      if (prev === undefined) delete process.env[KEY];
      else process.env[KEY] = prev;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('truncated persists across a corpus-cache hit (same instance, second request)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ok-search-truncated-cache-'));
    const prev = process.env[KEY];
    process.env[KEY] = '1';
    try {
      writeFileSync(join(dir, 'data-a.csv'), 'x', 'utf-8');
      writeFileSync(join(dir, 'data-b.csv'), 'x', 'utf-8');
      const index = new Map<string, FileIndexEntry>([
        ['data-a.csv', indexEntry(join(dir, 'data-a.csv'), 'file')],
        ['data-b.csv', indexEntry(join(dir, 'data-b.csv'), 'file')],
      ]);
      const getAll = () => index;
      const markdownOnly = () =>
        new Map([...index].filter(([, entry]) => entry.kind === 'markdown'));
      const ext = createApiExtension({
        hocuspocus: {} as unknown as Parameters<typeof createApiExtension>[0]['hocuspocus'],
        sessionManager: {} as unknown as Parameters<typeof createApiExtension>[0]['sessionManager'],
        contentDir: dir,
        serverInstanceId: 'test-server',
        getFileIndex: markdownOnly,
        getAllFilesIndex: getAll,
      });
      const run = async (url: string): Promise<{ truncated?: boolean }> => {
        const req = makeReq('GET', url);
        const { res, captured } = makeRes();
        await (
          ext as {
            onRequest: (ctx: {
              request: IncomingMessage;
              response: ServerResponse;
            }) => Promise<void>;
          }
        ).onRequest({ request: req, response: res });
        return JSON.parse(captured.body) as { truncated?: boolean };
      };

      const first = await run('/api/search?query=data&intent=omnibar');
      expect(first.truncated).toBe(true);
      const second = await run('/api/search?query=data-a&intent=omnibar');
      expect(second.truncated).toBe(true);
    } finally {
      if (prev === undefined) delete process.env[KEY];
      else process.env[KEY] = prev;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('getSearchMaxEntries — env parse', () => {
  const KEY = 'OK_SEARCH_MAX_ENTRIES';
  const cases: Array<[string, number]> = [
    ['0', DEFAULT_SEARCH_MAX_ENTRIES],
    ['-1', DEFAULT_SEARCH_MAX_ENTRIES],
    ['1.5', DEFAULT_SEARCH_MAX_ENTRIES],
    ['abc', DEFAULT_SEARCH_MAX_ENTRIES],
    ['7', 7],
  ];
  for (const [raw, expected] of cases) {
    test(`env=${JSON.stringify(raw)} → ${expected}`, () => {
      const prev = process.env[KEY];
      process.env[KEY] = raw;
      try {
        expect(getSearchMaxEntries()).toBe(expected);
      } finally {
        if (prev === undefined) delete process.env[KEY];
        else process.env[KEY] = prev;
      }
    });
  }

  test('missing env → default', () => {
    const prev = process.env[KEY];
    delete process.env[KEY];
    try {
      expect(getSearchMaxEntries()).toBe(DEFAULT_SEARCH_MAX_ENTRIES);
    } finally {
      if (prev !== undefined) process.env[KEY] = prev;
    }
  });
});

describe('GET /api/search — symlink alias handling (D16)', () => {
  test('a symlinked file is findable by either path and appears once (AC17)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ok-search-symlink-'));
    try {
      writeFileSync(join(dir, 'data.csv'), 'x', 'utf-8');
      const entry: FileIndexEntry = {
        ...indexEntry(join(dir, 'data.csv'), 'file'),
        aliases: ['mirror/data.csv'],
      };
      const index = new Map<string, FileIndexEntry>([['data.csv', entry]]);

      const byCanonical = resultPaths(
        await runSearch(dir, index, '/api/search?query=data.csv&intent=omnibar'),
      );
      expect(byCanonical.filter((p) => p === 'data.csv')).toEqual(['data.csv']);

      const byAlias = resultPaths(
        await runSearch(dir, index, '/api/search?query=mirror&intent=omnibar'),
      );
      expect(byAlias.filter((p) => p === 'data.csv')).toEqual(['data.csv']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('GET /api/search — operational budget (D15)', () => {
  test('a name-only file entry is searchable without its content being read (AC20)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ok-search-noread-'));
    try {
      const index = new Map<string, FileIndexEntry>([
        [
          'ghost-data.csv',
          {
            size: 1,
            modified: new Date(0).toISOString(),
            canonicalPath: join(dir, 'does-not-exist.csv'),
            inode: 1,
            aliases: [],
            kind: 'file',
          },
        ],
      ]);
      const paths = resultPaths(
        await runSearch(dir, index, '/api/search?query=ghost&intent=omnibar'),
      );
      expect(paths).toContain('ghost-data.csv');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('builds a large all-files corpus within budget (AC18/AC19, measured)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ok-search-scale-'));
    try {
      const N = 5000;
      const index = new Map<string, FileIndexEntry>();
      for (let i = 0; i < N; i++) {
        const path = `pkg${i % 50}/mod${i % 20}/file-${i}.ts`;
        index.set(path, {
          size: 1,
          modified: new Date(0).toISOString(),
          canonicalPath: join(dir, `f${i}`),
          inode: i + 1,
          aliases: [],
          kind: 'file',
        });
      }
      const rssBefore = process.memoryUsage().rss;
      const startedAt = performance.now();
      const captured = await runSearch(
        dir,
        index,
        '/api/search?query=file-42&intent=omnibar&limit=20',
      );
      const elapsedMs = performance.now() - startedAt;
      const rssDeltaMb = (process.memoryUsage().rss - rssBefore) / 1e6;
      console.warn(
        `[US-013] ${N}-file corpus: build+search ${elapsedMs.toFixed(0)}ms, rssDelta ${rssDeltaMb.toFixed(1)}MB`,
      );
      expect(captured.status).toBe(200);
      expect(resultPaths(captured).length).toBeGreaterThan(0);
      expect(elapsedMs).toBeLessThan(10_000);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('GET /api/search — dot-path searchability', () => {
  test('a tracked dot-path markdown is searchable (AC3)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ok-search-dotpath-'));
    try {
      writeFileSync(join(dir, 'guide.md'), '# Guide\n', 'utf-8');
      mkdirSync(join(dir, '.changeset'), { recursive: true });
      writeFileSync(
        join(dir, '.changeset', 'release.md'),
        '# Release\n\nChangeset notes.\n',
        'utf-8',
      );
      const index = new Map<string, FileIndexEntry>([
        ['guide', indexEntry(join(dir, 'guide.md'), 'markdown')],
        ['.changeset/release', indexEntry(join(dir, '.changeset', 'release.md'), 'markdown')],
      ]);

      expect(
        resultPaths(await runSearch(dir, index, '/api/search?query=release&intent=omnibar')),
      ).toContain('.changeset/release');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a config synthetic doc stays out of search even with the dot-path filter softened', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ok-search-configdoc-'));
    try {
      writeFileSync(join(dir, 'guide.md'), '# Guide\n', 'utf-8');
      mkdirSync(join(dir, '__config__'), { recursive: true });
      writeFileSync(join(dir, '__config__', 'project.md'), '# Project Config\n', 'utf-8');
      const index = new Map<string, FileIndexEntry>([
        ['guide', indexEntry(join(dir, 'guide.md'), 'markdown')],
        ['__config__/project', indexEntry(join(dir, '__config__', 'project.md'), 'markdown')],
      ]);

      expect(
        resultPaths(await runSearch(dir, index, '/api/search?query=project&intent=omnibar')),
      ).not.toContain('__config__/project');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('GET /api/search — cold-start readiness', () => {
  async function onRequest(ext: ReturnType<typeof createApiExtension>, url: string) {
    const req = makeReq('GET', url);
    const { res, captured } = makeRes();
    await (
      ext as {
        onRequest: (ctx: { request: IncomingMessage; response: ServerResponse }) => Promise<void>;
      }
    ).onRequest({ request: req, response: res });
    return captured;
  }

  test('answers ready:false with empty results while the boot index is warming, then ready:true with results once the boot gate resolves', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ok-search-warming-'));
    try {
      mkdirSync(join(dir, 'architecture'), { recursive: true });
      writeFileSync(join(dir, 'architecture/overview.md'), '# System Overview\n', 'utf-8');
      const fileIndex = buildFileIndex(dir);

      let resolveReady: () => void = () => {};
      const ready = new Promise<void>((resolve) => {
        resolveReady = resolve;
      });
      const ext = createApiExtension({
        hocuspocus: {} as unknown as Parameters<typeof createApiExtension>[0]['hocuspocus'],
        sessionManager: {} as unknown as Parameters<typeof createApiExtension>[0]['sessionManager'],
        contentDir: dir,
        serverInstanceId: 'test-server',
        getFileIndex: () => fileIndex,
        ready,
      });

      const warming = JSON.parse((await onRequest(ext, '/api/search?query=overview')).body) as {
        ready?: boolean;
        results?: unknown[];
      };
      expect(warming.ready).toBe(false);
      expect(warming.results).toEqual([]);

      resolveReady();
      await ready;
      await new Promise((r) => setTimeout(r, 0));

      const captured = await onRequest(ext, '/api/search?query=overview');
      expect(captured.status).toBe(200);
      const settled = JSON.parse(captured.body) as {
        ready?: boolean;
        results?: Array<{ path: string }>;
      };
      expect(settled.ready).toBe(true);
      expect(settled.results?.some((row) => row.path === 'architecture/overview')).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a rejected boot gate flips to ready so search does not warm forever (degraded boot)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ok-search-rejected-gate-'));
    try {
      writeFileSync(join(dir, 'guide.md'), '# Guide\n', 'utf-8');
      const fileIndex = buildFileIndex(dir);

      let rejectReady: (err: Error) => void = () => {};
      const ready = new Promise<void>((_resolve, reject) => {
        rejectReady = reject;
      });
      ready.catch(() => {});
      const ext = createApiExtension({
        hocuspocus: {} as unknown as Parameters<typeof createApiExtension>[0]['hocuspocus'],
        sessionManager: {} as unknown as Parameters<typeof createApiExtension>[0]['sessionManager'],
        contentDir: dir,
        serverInstanceId: 'test-server',
        getFileIndex: () => fileIndex,
        ready,
      });

      rejectReady(new Error('init failed'));
      await new Promise((r) => setTimeout(r, 0));

      const body = JSON.parse((await onRequest(ext, '/api/search?query=guide')).body) as {
        ready?: boolean;
        results?: Array<{ path: string }>;
      };
      expect(body.ready).toBe(true);
      expect(body.results?.some((row) => row.path === 'guide')).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('without a boot gate (test/library harness), search is ready immediately', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ok-search-nogate-'));
    try {
      writeFileSync(join(dir, 'guide.md'), '# Guide\n', 'utf-8');
      const fileIndex = buildFileIndex(dir);
      const ext = createApiExtension({
        hocuspocus: {} as unknown as Parameters<typeof createApiExtension>[0]['hocuspocus'],
        sessionManager: {} as unknown as Parameters<typeof createApiExtension>[0]['sessionManager'],
        contentDir: dir,
        serverInstanceId: 'test-server',
        getFileIndex: () => fileIndex,
      });
      const body = JSON.parse((await onRequest(ext, '/api/search?query=guide')).body) as {
        ready?: boolean;
        results?: Array<{ path: string }>;
      };
      expect(body.ready).toBe(true);
      expect(body.results?.some((row) => row.path === 'guide')).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('GET /api/search — incremental corpus (per-page document cache)', () => {
  async function onRequest(ext: ReturnType<typeof createApiExtension>, url: string) {
    const req = makeReq('GET', url);
    const { res, captured } = makeRes();
    await (
      ext as {
        onRequest: (ctx: { request: IncomingMessage; response: ServerResponse }) => Promise<void>;
      }
    ).onRequest({ request: req, response: res });
    return captured;
  }

  test('reuses an unchanged page across rebuilds, re-reads a changed entry, and prunes deletes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ok-search-incremental-'));
    try {
      const alphaPath = join(dir, 'alpha.md');
      const betaPath = join(dir, 'beta.md');
      writeFileSync(alphaPath, '# Alpha\n\nalphaversionone\n', 'utf-8');
      const alphaV1 = indexEntry(alphaPath, 'markdown');
      const index = new Map<string, FileIndexEntry>([['alpha', alphaV1]]);
      const ext = createApiExtension({
        hocuspocus: {} as unknown as Parameters<typeof createApiExtension>[0]['hocuspocus'],
        sessionManager: {} as unknown as Parameters<typeof createApiExtension>[0]['sessionManager'],
        contentDir: dir,
        serverInstanceId: 'test-server',
        getFileIndex: () => index,
        getAllFilesIndex: () => index,
      });
      const run = (q: string) => onRequest(ext, `/api/search?query=${q}&intent=full_text`);
      const paths = (c: CapturedResponse) =>
        (JSON.parse(c.body) as { results?: Array<{ path: string }> }).results?.map((r) => r.path) ??
        [];

      expect(paths(await run('alphaversionone'))).toContain('alpha');

      writeFileSync(alphaPath, '# Alpha\n\nalphaversiontwo-now-longer\n', 'utf-8');
      writeFileSync(betaPath, '# Beta\n\nbetafreshbody\n', 'utf-8');
      index.set('beta', indexEntry(betaPath, 'markdown'));

      expect(paths(await run('alphaversiontwo'))).not.toContain('alpha');
      expect(paths(await run('alphaversionone'))).toContain('alpha');
      expect(paths(await run('betafreshbody'))).toContain('beta');

      index.set('alpha', indexEntry(alphaPath, 'markdown'));
      expect(paths(await run('alphaversiontwo'))).toContain('alpha');

      index.delete('beta');
      expect(paths(await run('betafreshbody'))).not.toContain('beta');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a failed read is NOT cached — the page self-heals on the next rebuild', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ok-search-readfail-'));
    try {
      const alphaPath = join(dir, 'alpha.md');
      const alphaEntry: FileIndexEntry = {
        size: 0,
        modified: new Date(0).toISOString(),
        canonicalPath: alphaPath,
        inode: 424242,
        aliases: [],
        kind: 'markdown',
      };
      const index = new Map<string, FileIndexEntry>([['alpha', alphaEntry]]);
      const ext = createApiExtension({
        hocuspocus: {} as unknown as Parameters<typeof createApiExtension>[0]['hocuspocus'],
        sessionManager: {} as unknown as Parameters<typeof createApiExtension>[0]['sessionManager'],
        contentDir: dir,
        serverInstanceId: 'test-server',
        getFileIndex: () => index,
        getAllFilesIndex: () => index,
      });
      const run = (q: string) => onRequest(ext, `/api/search?query=${q}&intent=full_text`);
      const paths = (c: CapturedResponse) =>
        (JSON.parse(c.body) as { results?: Array<{ path: string }> }).results?.map((r) => r.path) ??
        [];

      expect(paths(await run('healedtoken'))).not.toContain('alpha');

      writeFileSync(alphaPath, '# Alpha\n\nhealedtoken body\n', 'utf-8');
      writeFileSync(join(dir, 'beta.md'), '# Beta\n\nbetabody\n', 'utf-8');
      index.set('beta', indexEntry(join(dir, 'beta.md'), 'markdown'));

      expect(paths(await run('healedtoken'))).toContain('alpha');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
