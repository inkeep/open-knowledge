import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { Hocuspocus } from '@hocuspocus/server';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { AgentSessionManager } from './agent-sessions.ts';
import { createApiExtension } from './api-extension.test-helper.ts';

interface CapturedResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

async function post(
  extension: ReturnType<typeof createApiExtension>,
  url: string,
  body: unknown,
): Promise<CapturedResponse> {
  const request = Readable.from(Buffer.from(JSON.stringify(body))) as unknown as IncomingMessage;
  request.method = 'POST';
  request.url = url;
  request.headers = { host: 'localhost', 'content-type': 'application/json' };
  const captured: CapturedResponse = { status: 0, headers: {}, body: '' };
  const response = {
    writeHead(status: number, headers?: Record<string, string>) {
      captured.status = status;
      for (const [key, value] of Object.entries(headers ?? {})) {
        captured.headers[key.toLowerCase()] = value;
      }
    },
    setHeader(key: string, value: string) {
      captured.headers[key.toLowerCase()] = value;
    },
    end(text?: string) {
      captured.body = text ?? '';
    },
  } as unknown as ServerResponse;
  await (
    extension as {
      onRequest: (ctx: { request: IncomingMessage; response: ServerResponse }) => Promise<void>;
    }
  ).onRequest({ request, response });
  return captured;
}

describe('agent writes refused at the session limit say nothing was committed (PRD-7398)', () => {
  let contentDir: string;
  let hocuspocus: Hocuspocus;
  let sessionManager: AgentSessionManager;
  let extension: ReturnType<typeof createApiExtension>;

  beforeEach(async () => {
    contentDir = mkdtempSync(join(tmpdir(), 'ok-session-capacity-'));
    hocuspocus = new Hocuspocus({ quiet: true });
    sessionManager = new AgentSessionManager(hocuspocus, {
      maxSessions: 1,
      minEvictableIdleMs: Number.POSITIVE_INFINITY,
    });
    await sessionManager.getSession('occupied', 'agent-occupant');
    extension = createApiExtension({
      hocuspocus,
      sessionManager,
      contentDir,
      serverInstanceId: 'session-capacity-test',
      getFileIndex: () => new Map(),
    });
  });

  afterEach(async () => {
    await sessionManager.closeAll();
    rmSync(contentDir, { recursive: true, force: true });
  });

  test('agent-write answers 503 with Retry-After and committed: false', async () => {
    const response = await post(extension, '/api/agent-write', {
      docName: 'note',
      content: '# Note\n',
    });

    expect(response.status).toBe(503);
    expect(response.headers['retry-after']).toBe('10');
    expect(JSON.parse(response.body)).toMatchObject({
      status: 503,
      type: 'urn:ok:error:too-many-agent-sessions',
      committed: false,
      retryAfterSeconds: 10,
    });
    expect(hocuspocus.documents.has('note')).toBe(false);
    expect(existsSync(join(contentDir, 'note.md'))).toBe(false);
  });

  test('agent-write-batch marks each refused entry committed: false', async () => {
    const response = await post(extension, '/api/agent-write-batch', {
      docs: [{ docName: 'first', markdown: '# First\n' }],
    });

    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toMatchObject({
      written: 0,
      failed: 1,
      results: [
        {
          status: 'error',
          docName: 'first',
          error: {
            type: 'urn:ok:error:too-many-agent-sessions',
            committed: false,
            retryAfterSeconds: 10,
          },
        },
      ],
    });
    expect(hocuspocus.documents.has('first')).toBe(false);
    expect(existsSync(join(contentDir, 'first.md'))).toBe(false);
  });
});
