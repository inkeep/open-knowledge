import { mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { Hocuspocus } from '@hocuspocus/server';
import { describe, expect, test } from 'vitest';
import { AgentSessionManager } from './agent-sessions.ts';
import { createApiExtension } from './api-extension.test-helper.ts';

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
