/**
 * Tests for the `onAgentWrite` callback wired through `createApiExtension`.
 *
 * Asserts the callback fires from both agent-write paths (write_document →
 * /api/agent-write-md, edit_document → /api/agent-patch). The CLI layer uses
 * this signal to auto-open the browser on the first agent edit per session.
 */
import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { Hocuspocus } from '@hocuspocus/server';
import {
  AGENT_WRITE_ORIGIN,
  AgentSessionManager,
  applyAgentMarkdownWrite,
} from './agent-sessions.ts';
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

describe('onAgentWrite callback', () => {
  test('fires from /api/agent-write-md (write_document path)', async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'ok-on-agent-write-'));
    const contentDir = join(projectDir, 'content');
    mkdirSync(contentDir, { recursive: true });

    const hocuspocus = new Hocuspocus({ quiet: true });
    const sessionManager = new AgentSessionManager(hocuspocus);
    let calls = 0;

    try {
      const ext = createApiExtension({
        hocuspocus,
        sessionManager,
        contentDir,
        getFileIndex: () => new Map(),
        onAgentWrite: () => {
          calls++;
        },
      });

      const req = makeJsonPostReq('/api/agent-write-md', {
        docName: 'test-doc',
        markdown: '# Hello\n',
        position: 'replace',
      });
      const { res, captured } = makeRes();
      await (
        ext as {
          onRequest: (ctx: { request: IncomingMessage; response: ServerResponse }) => Promise<void>;
        }
      ).onRequest({ request: req, response: res });

      expect(captured.status).toBe(200);
      expect(calls).toBe(1);
    } finally {
      await sessionManager.closeAll();
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  test('fires from /api/agent-patch (edit_document path)', async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'ok-on-agent-write-'));
    const contentDir = join(projectDir, 'content');
    mkdirSync(contentDir, { recursive: true });

    const hocuspocus = new Hocuspocus({ quiet: true });
    const sessionManager = new AgentSessionManager(hocuspocus);
    let calls = 0;

    try {
      const session = await sessionManager.getSession('test-doc');
      session.dc.document.transact(() => {
        applyAgentMarkdownWrite(session.dc.document, '# Notes\n\nalpha\n', 'replace');
      }, AGENT_WRITE_ORIGIN);

      const ext = createApiExtension({
        hocuspocus,
        sessionManager,
        contentDir,
        getFileIndex: () => new Map(),
        onAgentWrite: () => {
          calls++;
        },
      });

      const req = makeJsonPostReq('/api/agent-patch', {
        docName: 'test-doc',
        find: 'alpha',
        replace: 'beta',
      });
      const { res, captured } = makeRes();
      await (
        ext as {
          onRequest: (ctx: { request: IncomingMessage; response: ServerResponse }) => Promise<void>;
        }
      ).onRequest({ request: req, response: res });

      expect(captured.status).toBe(200);
      expect(calls).toBe(1);
    } finally {
      await sessionManager.closeAll();
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  test('does not fire when the handler fails (stale-target 409)', async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'ok-on-agent-write-'));
    const contentDir = join(projectDir, 'content');
    mkdirSync(contentDir, { recursive: true });

    const hocuspocus = new Hocuspocus({ quiet: true });
    const sessionManager = new AgentSessionManager(hocuspocus);
    let calls = 0;

    try {
      const session = await sessionManager.getSession('test-doc');
      session.dc.document.transact(() => {
        applyAgentMarkdownWrite(session.dc.document, '# Notes\n\nalpha alpha\n', 'replace');
      }, AGENT_WRITE_ORIGIN);

      const ext = createApiExtension({
        hocuspocus,
        sessionManager,
        contentDir,
        getFileIndex: () => new Map(),
        onAgentWrite: () => {
          calls++;
        },
      });

      const req = makeJsonPostReq('/api/agent-patch', {
        docName: 'test-doc',
        find: 'alpha',
        replace: 'beta',
        offset: 999, // deliberately wrong — triggers stale-target branch
      });
      const { res, captured } = makeRes();
      await (
        ext as {
          onRequest: (ctx: { request: IncomingMessage; response: ServerResponse }) => Promise<void>;
        }
      ).onRequest({ request: req, response: res });

      expect(captured.status).toBe(409);
      expect(calls).toBe(0);
    } finally {
      await sessionManager.closeAll();
      rmSync(projectDir, { recursive: true, force: true });
    }
  });
});
