/**
 * Empty `docName` must be rejected, never silently routed to a fallback
 * target. Previously an empty/missing docName fell through to a hardcoded
 * `test-doc`, so `write_document({ docName: "" })` returned success while
 * overwriting `test-doc.md` (silent wrong-target write, data-loss class).
 *
 * These tests assert the contract end-to-end at the HTTP boundary: every
 * mutating handler that read the `test-doc` fallback now answers 400 and
 * creates no `test-doc` session.
 */
import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
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

async function dispatch(ext: unknown, req: IncomingMessage): Promise<CapturedResponse> {
  const { res, captured } = makeRes();
  await (
    ext as {
      onRequest: (ctx: { request: IncomingMessage; response: ServerResponse }) => Promise<void>;
    }
  ).onRequest({ request: req, response: res });
  return captured;
}

// Each entry is a mutating handler that previously read the `test-doc`
// fallback. The body is the minimal shape that reaches the docName
// resolution; the empty `docName` must be rejected before any of it runs.
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
        // The wrong-target write would have opened a `test-doc` document.
        expect(hocuspocus.documents.has('test-doc')).toBe(false);
      } finally {
        await sessionManager.closeAll();
        rmSync(projectDir, { recursive: true, force: true });
      }
    });
  }

  // An omitted `docName` field (not just an empty string) was the other half
  // of the legacy `test-doc` fallback. The JSON wire shapes differ (`""` vs an
  // absent key), so pin every route for the omitted case too.
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
