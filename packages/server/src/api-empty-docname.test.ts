import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
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

async function dispatch(ext: unknown, req: IncomingMessage): Promise<CapturedResponse> {
  const { res, captured } = makeRes();
  await (
    ext as {
      onRequest: (ctx: { request: IncomingMessage; response: ServerResponse }) => Promise<void>;
    }
  ).onRequest({ request: req, response: res });
  return captured;
}

const EMPTY_DOCNAME_CASES: Array<{ route: string; body: Record<string, unknown> }> = [
  { route: '/api/agent-write', body: { docName: '', markdown: 'x' } },
  {
    route: '/api/agent-write-md',
    body: { docName: '', markdown: 'empty name doc', position: 'replace' },
  },
  { route: '/api/frontmatter-patch', body: { docName: '', patch: { title: 'x' } } },
  { route: '/api/agent-patch', body: { docName: '', find: 'a', replace: 'b' } },
  { route: '/api/agent-undo', body: { docName: '', connectionId: 'agent-test' } },
];

describe('empty docName rejection', () => {
  for (const { route, body } of EMPTY_DOCNAME_CASES) {
    test(`${route} rejects empty docName with 400 and creates no test-doc`, async () => {
      const projectDir = mkdtempSync(join(tmpdir(), 'ok-empty-docname-'));
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

        const captured = await dispatch(ext, makeJsonPostReq(route, body));

        expect(captured.status).toBe(400);
        expect(captured.body.toLowerCase()).toContain('docname');
        expect(hocuspocus.documents.has('test-doc')).toBe(false);
      } finally {
        await sessionManager.closeAll();
        rmSync(projectDir, { recursive: true, force: true });
      }
    });
  }

  for (const { route, body } of EMPTY_DOCNAME_CASES) {
    const { docName: _omitted, ...bodyWithoutDocName } = body;
    test(`${route} rejects an omitted docName field, not routed to test-doc`, async () => {
      const projectDir = mkdtempSync(join(tmpdir(), 'ok-empty-docname-'));
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

        const captured = await dispatch(ext, makeJsonPostReq(route, bodyWithoutDocName));

        expect(captured.status).toBe(400);
        expect(hocuspocus.documents.has('test-doc')).toBe(false);
      } finally {
        await sessionManager.closeAll();
        rmSync(projectDir, { recursive: true, force: true });
      }
    });
  }
});
