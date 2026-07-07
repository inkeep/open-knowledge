/**
 * Malformed `docName` must be rejected with a clean 400 before the write path
 * runs. Previously a whitespace-only name passed request validation and threw
 * a 500 deep in the doc layer ("Document name must not be empty"), while `.`,
 * `a/`, `.foo`, and tab-bearing names were silently accepted and created junk,
 * hidden, or unaddressable files on disk. The shared docName contract now
 * rejects them at the request-schema boundary.
 */
import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { Hocuspocus } from '@hocuspocus/server';
import { AgentSessionManager } from './agent-sessions.ts';
import { createApiExtension } from './api-extension.ts';

interface CapturedResponse {
  status: number;
  body: string;
}

function makeJsonPostReq(url: string, body: unknown): IncomingMessage {
  const readable = Readable.from(Buffer.from(JSON.stringify(body))) as unknown as IncomingMessage;
  readable.method = 'POST';
  readable.url = url;
  readable.headers = { host: 'localhost', 'content-type': 'application/json' };
  return readable;
}

function makeRes(): { res: ServerResponse; captured: CapturedResponse } {
  const captured: CapturedResponse = { status: 0, body: '' };
  const res = {
    writeHead(status: number) {
      captured.status = status;
    },
    end(body?: string) {
      captured.body = body ?? '';
    },
  } as unknown as ServerResponse;
  return { res, captured };
}

async function postWriteMd(ext: unknown, docName: string): Promise<CapturedResponse> {
  const req = makeJsonPostReq('/api/agent-write-md', {
    docName,
    markdown: '# content',
    position: 'replace',
  });
  const { res, captured } = makeRes();
  await (
    ext as {
      onRequest: (ctx: { request: IncomingMessage; response: ServerResponse }) => Promise<void>;
    }
  ).onRequest({ request: req, response: res });
  return captured;
}

// The bug table. Every entry must answer 400
// (request invalid) — never a 500, and never a 200 that materializes junk.
const MALFORMED = ['   ', '.', '..', '../escape', 'a/', '/abs', '.foo', 'x\ty'];

describe('malformed docName rejection (/api/agent-write-md)', () => {
  test('rejects every malformed docName with 400 and writes nothing', async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'ok-docname-validation-'));
    const contentDir = join(projectDir, 'content');
    mkdirSync(contentDir, { recursive: true });

    const hocuspocus = new Hocuspocus({ quiet: true });
    const sessionManager = new AgentSessionManager(hocuspocus);

    try {
      const ext = createApiExtension({
        hocuspocus,
        sessionManager,
        contentDir,
        getFileIndex: () => new Map(),
      });

      for (const docName of MALFORMED) {
        const captured = await postWriteMd(ext, docName);
        expect(captured.status).toBe(400);
      }

      // No junk files (`..md`, `a/.md`, `.foo.md`, tab-named, etc.) were created.
      expect(readdirSync(contentDir)).toHaveLength(0);
    } finally {
      await sessionManager.closeAll();
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  test('still accepts a well-formed nested docName', async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'ok-docname-validation-'));
    const contentDir = join(projectDir, 'content');
    mkdirSync(contentDir, { recursive: true });

    const hocuspocus = new Hocuspocus({ quiet: true });
    const sessionManager = new AgentSessionManager(hocuspocus);

    try {
      const ext = createApiExtension({
        hocuspocus,
        sessionManager,
        contentDir,
        getFileIndex: () => new Map(),
      });

      const captured = await postWriteMd(ext, 'notes/meeting');
      expect(captured.status).toBe(200);
    } finally {
      await sessionManager.closeAll();
      rmSync(projectDir, { recursive: true, force: true });
    }
  });
});
