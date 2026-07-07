import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { createApiExtension } from './api-extension.ts';
import type { FileIndexEntry } from './file-watcher.ts';
import { TagIndex } from './tag-index.ts';

interface CapturedResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

function makeReq(url: string, method = 'GET'): IncomingMessage {
  const readable = Readable.from(Buffer.from('')) as unknown as IncomingMessage;
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
    setHeader() {},
    end(body?: string) {
      captured.body = body ?? '';
    },
  } as unknown as ServerResponse;
  return { res, captured };
}

async function callRoute(
  contentDir: string,
  url: string,
  fileIndex: ReadonlyMap<string, FileIndexEntry>,
  tagIndex?: TagIndex,
  method = 'GET',
): Promise<CapturedResponse> {
  const ext = createApiExtension({
    hocuspocus: {} as never,
    sessionManager: {} as never,
    contentDir,
    serverInstanceId: 'test-instance',
    getFileIndex: () => fileIndex,
    tagIndex,
  });
  const req = makeReq(url, method);
  const { res, captured } = makeRes();
  await (
    ext as {
      onRequest: (ctx: { request: IncomingMessage; response: ServerResponse }) => Promise<void>;
    }
  ).onRequest({ request: req, response: res });
  return captured;
}

describe('tag endpoints', () => {
  test('GET /api/tags returns 503 when tag index not configured', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ok-tags-503-'));
    try {
      const result = await callRoute(dir, '/api/tags', new Map());
      expect(result.status).toBe(503);
      const body = JSON.parse(result.body);
      expect(body.type).toBe('urn:ok:error:tag-index-not-configured');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('GET /api/tags returns the indexed tags with counts and leaf flags', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ok-tags-list-'));
    try {
      writeFileSync(join(dir, 'alpha.md'), '#proj/team #standalone\n', 'utf-8');
      writeFileSync(join(dir, 'beta.md'), '#proj\n', 'utf-8');
      const idx = new TagIndex({ contentDir: dir });
      await idx.init();

      const result = await callRoute(dir, '/api/tags', new Map(), idx);
      expect(result.status).toBe(200);
      const body = JSON.parse(result.body) as {
        tags: Array<{ name: string; count: number; isLeaf: boolean }>;
      };
      const byName = new Map(body.tags.map((t) => [t.name, t]));
      expect(byName.get('proj')).toEqual({ name: 'proj', count: 2, isLeaf: false });
      expect(byName.get('proj/team')).toEqual({ name: 'proj/team', count: 1, isLeaf: true });
      expect(byName.get('standalone')).toEqual({
        name: 'standalone',
        count: 1,
        isLeaf: true,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('GET /api/tags/:name returns the docs that carry that tag (with rollup)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ok-tags-name-'));
    try {
      writeFileSync(join(dir, 'alpha.md'), '#proj/team/2026\n', 'utf-8');
      writeFileSync(join(dir, 'beta.md'), '#proj/team/2027\n', 'utf-8');
      writeFileSync(join(dir, 'gamma.md'), '#unrelated\n', 'utf-8');

      const idx = new TagIndex({ contentDir: dir });
      await idx.init();

      const result = await callRoute(dir, '/api/tags/proj', new Map(), idx);
      expect(result.status).toBe(200);
      const body = JSON.parse(result.body) as {
        name: string;
        docs: Array<{
          docName: string;
          title: string;
          snippet: string | null;
          matchingTags: string[];
        }>;
      };
      expect(body.name).toBe('proj');
      expect(body.docs.map((d) => d.docName).sort()).toEqual(['alpha', 'beta']);
      expect(body.docs.every((d) => d.snippet === null)).toBe(true);
      // matchingTags surfaces the rollup: each doc's authored tag falls
      // under the queried prefix `proj`. Without this field the dialog
      // can't tell users *why* a doc is in the result list.
      const byName = Object.fromEntries(body.docs.map((d) => [d.docName, d.matchingTags]));
      expect(byName.alpha).toEqual(['proj/team/2026']);
      expect(byName.beta).toEqual(['proj/team/2027']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('GET /api/tags/:name URL-decodes hierarchy slashes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ok-tags-encoded-'));
    try {
      writeFileSync(join(dir, 'alpha.md'), '#proj/team/2026\n', 'utf-8');
      const idx = new TagIndex({ contentDir: dir });
      await idx.init();

      // %2F is the encoded form of '/'
      const result = await callRoute(dir, '/api/tags/proj%2Fteam', new Map(), idx);
      expect(result.status).toBe(200);
      const body = JSON.parse(result.body) as { name: string; docs: unknown[] };
      expect(body.name).toBe('proj/team');
      expect(body.docs).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('GET /api/tags/:name returns empty docs for unknown tag', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ok-tags-unknown-'));
    try {
      const idx = new TagIndex({ contentDir: dir });
      await idx.init();

      const result = await callRoute(dir, '/api/tags/nope', new Map(), idx);
      expect(result.status).toBe(200);
      const body = JSON.parse(result.body) as { docs: unknown[] };
      expect(body.docs).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('frontmatter tags merge with inline tags through the API', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ok-tags-fm-'));
    try {
      writeFileSync(
        join(dir, 'alpha.md'),
        '---\ntags: [showcase]\n---\nInline #demo here.\n',
        'utf-8',
      );
      writeFileSync(
        join(dir, 'beta.md'),
        '---\ntags: [showcase, demo]\n---\nNo inline.\n',
        'utf-8',
      );
      const idx = new TagIndex({ contentDir: dir });
      await idx.init();

      const result = await callRoute(dir, '/api/tags/showcase', new Map(), idx);
      const body = JSON.parse(result.body) as { docs: Array<{ docName: string }> };
      expect(body.docs.map((d) => d.docName).sort()).toEqual(['alpha', 'beta']);

      const result2 = await callRoute(dir, '/api/tags/demo', new Map(), idx);
      const body2 = JSON.parse(result2.body) as { docs: Array<{ docName: string }> };
      expect(body2.docs.map((d) => d.docName).sort()).toEqual(['alpha', 'beta']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('POST /api/tags is rejected (read-only endpoint)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ok-tags-post-'));
    try {
      const idx = new TagIndex({ contentDir: dir });
      const result = await callRoute(dir, '/api/tags', new Map(), idx, 'POST');
      expect(result.status).toBe(405);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('tag endpoint independence from fileIndex content', () => {
  test('tag endpoint is self-sufficient post-init', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ok-tags-fi-'));
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'alpha.md'), '#x\n', 'utf-8');
      const idx = new TagIndex({ contentDir: dir });
      await idx.init();
      const result = await callRoute(dir, '/api/tags/x', new Map(), idx);
      expect(result.status).toBe(200);
      const body = JSON.parse(result.body) as { docs: Array<{ docName: string }> };
      expect(body.docs.map((d) => d.docName)).toEqual(['alpha']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
