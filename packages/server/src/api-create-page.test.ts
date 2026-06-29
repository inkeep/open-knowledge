import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { Principal } from '@inkeep/open-knowledge-core';
import { createApiExtension } from './api-extension.ts';
import { BacklinkIndex } from './backlink-index.ts';
import { contributorCount, hasContributor, swapContributors } from './contributor-tracker.ts';
import type { FileIndexEntry } from './file-watcher.ts';

function makeReq(method: string, body: unknown): IncomingMessage {
  const raw = JSON.stringify(body);
  const readable = Readable.from(Buffer.from(raw)) as unknown as IncomingMessage;
  readable.method = method;
  readable.url = '/api/create-page';
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

async function callCreatePage(
  contentDir: string,
  method: string,
  body: unknown,
  options?: {
    fileIndex?: Map<string, FileIndexEntry>;
    backlinkIndex?: BacklinkIndex;
    getPrincipal?: () => Principal | null;
  },
): Promise<CapturedResponse> {
  const ext = createApiExtension({
    hocuspocus: {} as unknown as Parameters<typeof createApiExtension>[0]['hocuspocus'],
    sessionManager: {} as unknown as Parameters<typeof createApiExtension>[0]['sessionManager'],
    contentDir,
    getFileIndex: () => options?.fileIndex ?? new Map<string, FileIndexEntry>(),
    backlinkIndex: options?.backlinkIndex,
    getPrincipal: options?.getPrincipal,
  });
  const req = makeReq(method, body);
  const { res, captured } = makeRes();
  await (
    ext as {
      onRequest: (ctx: { request: IncomingMessage; response: ServerResponse }) => Promise<void>;
    }
  ).onRequest({ request: req, response: res });
  return captured;
}

let tmpDir: string;

function setupTmpDir(): string {
  tmpDir = mkdtempSync(join(tmpdir(), 'ok-create-page-'));
  return tmpDir;
}

beforeEach(() => {
  swapContributors();
});

afterEach(() => {
  if (tmpDir) {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  }
});

describe('POST /api/create-page', () => {
  test('creates a file and returns flat { docName } success body', async () => {
    const dir = setupTmpDir();
    const result = await callCreatePage(dir, 'POST', { path: 'my-page.md' });

    expect(result.status).toBe(200);
    const body = JSON.parse(result.body) as Record<string, unknown>;
    expect(body.docName).toBe('my-page');
    expect(body.ok).toBeUndefined();
    expect(existsSync(join(dir, 'my-page.md'))).toBe(true);
  });

  test('creates a .mdx file and returns the extension-less docName', async () => {
    const dir = setupTmpDir();
    const result = await callCreatePage(dir, 'POST', { path: 'component.mdx' });

    expect(result.status).toBe(200);
    const body = JSON.parse(result.body) as Record<string, unknown>;
    expect(body.docName).toBe('component');
    expect(body.ok).toBeUndefined();
    expect(existsSync(join(dir, 'component.mdx'))).toBe(true);
    expect(existsSync(join(dir, 'component.md'))).toBe(false);
  });

  test('rejects unsupported extensions with a message naming .md and .mdx', async () => {
    const dir = setupTmpDir();
    const result = await callCreatePage(dir, 'POST', { path: 'notes.txt' });

    expect(result.status).toBe(400);
    const body = JSON.parse(result.body) as Record<string, unknown>;
    expect(body.type).toBe('urn:ok:error:invalid-request');
    expect(String(body.title)).toContain('.mdx');
  });

  test('creates parent directories for nested paths and returns full docName', async () => {
    const dir = setupTmpDir();
    const result = await callCreatePage(dir, 'POST', { path: 'nested/folder/my-page.md' });

    expect(result.status).toBe(200);
    const body = JSON.parse(result.body) as Record<string, unknown>;
    expect(body.docName).toBe('nested/folder/my-page');
    expect(body.ok).toBeUndefined();
    expect(existsSync(join(dir, 'nested/folder/my-page.md'))).toBe(true);
  });

  test('updates the in-memory file index immediately when available', async () => {
    const dir = setupTmpDir();
    const fileIndex = new Map<string, FileIndexEntry>();

    const result = await callCreatePage(dir, 'POST', { path: 'my-page.md' }, { fileIndex });

    expect(result.status).toBe(200);
    expect(fileIndex.has('my-page')).toBe(true);
  });

  test('updates the backlink index immediately when available', async () => {
    const dir = setupTmpDir();
    const backlinkIndex = new BacklinkIndex({ projectDir: dir, contentDir: dir });

    const result = await callCreatePage(dir, 'POST', { path: 'Y.md' }, { backlinkIndex });

    expect(result.status).toBe(200);
    expect(backlinkIndex.getForwardLinks('Y')).toEqual([]);
  });

  test('returns 400 when path field is missing', async () => {
    const dir = setupTmpDir();
    const result = await callCreatePage(dir, 'POST', {});

    expect(result.status).toBe(400);
    const body = JSON.parse(result.body) as Record<string, unknown>;
    expect(body.type).toBe('urn:ok:error:invalid-request');
    expect(typeof body.title).toBe('string');
  });

  test('returns 400 when path contains ..', async () => {
    const dir = setupTmpDir();
    const result = await callCreatePage(dir, 'POST', { path: '../escape.md' });

    expect(result.status).toBe(400);
    const body = JSON.parse(result.body) as Record<string, unknown>;
    expect(body.type).toBe('urn:ok:error:path-escape');
  });

  test('returns 409 when the file already exists', async () => {
    const dir = setupTmpDir();
    await callCreatePage(dir, 'POST', { path: 'existing.md' });

    const result = await callCreatePage(dir, 'POST', { path: 'existing.md' });

    expect(result.status).toBe(409);
    const body = JSON.parse(result.body) as Record<string, unknown>;
    expect(body.type).toBe('urn:ok:error:doc-already-exists');
  });

  test('returns 405 for GET requests', async () => {
    const dir = setupTmpDir();
    const result = await callCreatePage(dir, 'GET', {});

    expect(result.status).toBe(405);
  });
});

describe('POST /api/create-page — attribution (D22 LOCKED)', () => {
  const fixturePrincipal: Principal = {
    id: 'principal-test',
    display_name: 'Test User',
    display_email: 'test@example.test',
    onboarded_at: '2026-04-30T00:00:00.000Z',
  };

  test('UI-driven create (no agentId, no principal) records no contributor — never attributes to Claude', async () => {
    const dir = setupTmpDir();
    const result = await callCreatePage(dir, 'POST', { path: 'manual-page.md' });

    expect(result.status).toBe(200);
    expect(contributorCount()).toBe(0);
    expect(hasContributor('agent-claude-1')).toBe(false);
  });

  test('UI-driven create with loaded principal attributes to the principal, not Claude', async () => {
    const dir = setupTmpDir();
    const result = await callCreatePage(
      dir,
      'POST',
      { path: 'manual-page.md' },
      { getPrincipal: () => fixturePrincipal },
    );

    expect(result.status).toBe(200);
    expect(hasContributor('agent-claude-1')).toBe(false);
    expect(hasContributor(fixturePrincipal.id)).toBe(true);
  });

  test('agent-driven create (agentId in body) attributes to the agent', async () => {
    const dir = setupTmpDir();
    const result = await callCreatePage(dir, 'POST', {
      path: 'agent-page.md',
      agentId: 'claude-7',
      agentName: 'Claude',
    });

    expect(result.status).toBe(200);
    expect(hasContributor('agent-claude-7')).toBe(true);
  });
});
