import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { Hocuspocus } from '@hocuspocus/server';
import { describe, expect, test } from 'vitest';
import { createApiExtension } from './api-extension.ts';
import type { FileIndexEntry } from './file-watcher.ts';

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
    end(body?: string) {
      captured.body = body ?? '';
    },
  } as unknown as ServerResponse;
  return { res, captured };
}

function buildFileIndex(
  contentDir: string,
  docNames: string[],
): ReadonlyMap<string, FileIndexEntry> {
  const index = new Map<string, FileIndexEntry>();
  for (const docName of docNames) {
    const filePath = join(contentDir, `${docName}.md`);
    const stats = statSync(filePath);
    index.set(docName, {
      size: stats.size,
      modified: stats.mtime.toISOString(),
      canonicalPath: filePath,
      inode: stats.ino,
      aliases: [],
    });
  }
  return index;
}

async function callRoute(
  contentDir: string,
  url: string,
  fileIndex: ReadonlyMap<string, FileIndexEntry>,
): Promise<CapturedResponse> {
  const ext = createApiExtension({
    hocuspocus: { documents: new Map() } as unknown as Hocuspocus,
    sessionManager: {} as never,
    contentDir,
    getFileIndex: () => fileIndex,
  });
  const req = makeReq(url);
  const { res, captured } = makeRes();
  await (
    ext as {
      onRequest: (ctx: { request: IncomingMessage; response: ServerResponse }) => Promise<void>;
    }
  ).onRequest({ request: req, response: res });
  return captured;
}

describe('GET /api/suggest-links', () => {
  test('returns the shared suggest-links payload for a valid target page', async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'ok-api-suggest-links-'));
    const contentDir = join(projectDir, 'content');

    try {
      mkdirSync(contentDir, { recursive: true });
      writeFileSync(join(contentDir, 'project-alpha.md'), '# Project Alpha\n', 'utf-8');
      writeFileSync(
        join(contentDir, 'notes.md'),
        'We should document Project Alpha before launch.\n',
        'utf-8',
      );

      const response = await callRoute(
        contentDir,
        '/api/suggest-links?docName=project-alpha',
        buildFileIndex(contentDir, ['project-alpha', 'notes']),
      );

      expect(response.status).toBe(200);
      expect(JSON.parse(response.body)).toEqual({
        target: {
          docName: 'project-alpha',
          title: 'Project Alpha',
          aliases: [],
        },
        mentions: [
          {
            source: 'notes',
            excerpt: 'We should document Project Alpha before launch.',
            offset: 19,
          },
        ],
        truncated: false,
      });
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  test('returns ok with an empty mentions array when no candidates are found', async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'ok-api-suggest-links-'));
    const contentDir = join(projectDir, 'content');

    try {
      mkdirSync(contentDir, { recursive: true });
      writeFileSync(join(contentDir, 'project-alpha.md'), '# Project Alpha\n', 'utf-8');
      writeFileSync(join(contentDir, 'notes.md'), 'No mention here.\n', 'utf-8');

      const response = await callRoute(
        contentDir,
        '/api/suggest-links?docName=project-alpha',
        buildFileIndex(contentDir, ['project-alpha', 'notes']),
      );

      expect(response.status).toBe(200);
      expect(JSON.parse(response.body)).toEqual({
        target: {
          docName: 'project-alpha',
          title: 'Project Alpha',
          aliases: [],
        },
        mentions: [],
        truncated: false,
      });
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  test('returns RFC 9457 problem details for missing, invalid, reserved, and unknown docName inputs', async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'ok-api-suggest-links-'));
    const contentDir = join(projectDir, 'content');

    try {
      mkdirSync(contentDir, { recursive: true });
      writeFileSync(join(contentDir, 'project-alpha.md'), '# Project Alpha\n', 'utf-8');

      const fileIndex = buildFileIndex(contentDir, ['project-alpha']);

      const missingDocName = await callRoute(contentDir, '/api/suggest-links', fileIndex);
      expect(missingDocName.status).toBe(400);
      const missingBody = JSON.parse(missingDocName.body) as { type: string; title: string };
      expect(missingBody.type).toBe('urn:ok:error:invalid-request');
      expect(missingBody.title).toContain('Missing docName');

      const invalidDocName = await callRoute(
        contentDir,
        '/api/suggest-links?docName=../project-alpha',
        fileIndex,
      );
      expect(invalidDocName.status).toBe(400);
      const invalidBody = JSON.parse(invalidDocName.body) as { type: string; title: string };
      expect(invalidBody.type).toBe('urn:ok:error:invalid-request');
      expect(invalidBody.title).toContain('Invalid docName');

      const reservedDocName = await callRoute(
        contentDir,
        '/api/suggest-links?docName=__system__',
        fileIndex,
      );
      expect(reservedDocName.status).toBe(400);
      const reservedBody = JSON.parse(reservedDocName.body) as { type: string; title: string };
      expect(reservedBody.type).toBe('urn:ok:error:reserved-doc-name');
      expect(reservedBody.title).toContain('__system__');

      const missingPage = await callRoute(
        contentDir,
        '/api/suggest-links?docName=missing-page',
        fileIndex,
      );
      expect(missingPage.status).toBe(404);
      const missingPageBody = JSON.parse(missingPage.body) as { type: string; title: string };
      expect(missingPageBody.type).toBe('urn:ok:error:doc-not-found');
      expect(missingPageBody.title).toContain('Page not found');
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });
});
