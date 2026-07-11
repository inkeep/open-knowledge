import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { createApiExtension } from './api-extension.ts';
import { BacklinkIndex } from './backlink-index.ts';
import { _resetDocExtensionsForTests } from './doc-extensions.ts';

/**
 * Reserved project-state guard across the generic mutation handlers
 * (create-page, create-folder, duplicate-path, rename-path, delete-path,
 * trash-cleanup): any request naming a `.ok` or `.git` path segment at ANY
 * depth must 400 with `urn:ok:error:reserved-doc-name` and leave disk
 * untouched. Nested `<folder>/.ok/` is a first-class OK shape (folder
 * metadata + templates), and on case-insensitive filesystems `.OK/x`
 * addresses `.ok/x`, so top-level-only or case-sensitive checks are not a
 * boundary. Skills and templates mutate only through their own validating
 * handlers, never through these generic file ops.
 */

function makeReq(url: string, method: string, body: unknown): IncomingMessage {
  const raw = body === undefined ? '' : JSON.stringify(body);
  const readable = Readable.from(Buffer.from(raw)) as unknown as IncomingMessage;
  readable.method = method;
  readable.url = url;
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

async function callApi(contentDir: string, url: string, body: unknown): Promise<CapturedResponse> {
  const backlinkIndex = new BacklinkIndex({ projectDir: contentDir, contentDir });
  await backlinkIndex.rebuildFromDisk();
  const ext = createApiExtension({
    hocuspocus: {
      documents: new Map(),
      closeConnections() {},
      unloadDocument: async () => {},
    } as unknown as Parameters<typeof createApiExtension>[0]['hocuspocus'],
    sessionManager: {
      closeSession: async () => {},
      closeAllForDoc: async () => {},
    } as unknown as Parameters<typeof createApiExtension>[0]['sessionManager'],
    contentDir,
    serverInstanceId: 'test-server-instance',
    getFileIndex: () => new Map(),
    getFolderIndex: () => new Map(),
    backlinkIndex,
  });
  const req = makeReq(url, 'POST', body);
  const { res, captured } = makeRes();
  await (
    ext as unknown as {
      onRequest: (ctx: { request: IncomingMessage; response: ServerResponse }) => Promise<void>;
    }
  ).onRequest({ request: req, response: res });
  return captured;
}

function expectReservedRejection(result: CapturedResponse): void {
  expect(result.status).toBe(400);
  expect(JSON.parse(result.body)).toMatchObject({
    type: 'urn:ok:error:reserved-doc-name',
    status: 400,
  });
}

let tmpDir: string;

function setupTmpDir(): string {
  tmpDir = mkdtempSync(join(tmpdir(), 'ok-reserved-guard-'));
  return tmpDir;
}

afterEach(() => {
  _resetDocExtensionsForTests();
  if (tmpDir) {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

describe('reserved-path guard — create-page', () => {
  test('rejects a root .ok target and writes nothing', async () => {
    const dir = setupTmpDir();

    const result = await callApi(dir, '/api/create-page', { path: '.ok/probe.md' });

    expectReservedRejection(result);
    expect(existsSync(join(dir, '.ok/probe.md'))).toBe(false);
    expect(existsSync(join(dir, '.ok'))).toBe(false);
  });

  test('rejects a nested .ok target at any depth and writes nothing', async () => {
    const dir = setupTmpDir();
    mkdirSync(join(dir, 'notes'), { recursive: true });

    const result = await callApi(dir, '/api/create-page', {
      path: 'notes/.ok/probe.md',
    });

    expectReservedRejection(result);
    expect(existsSync(join(dir, 'notes/.ok'))).toBe(false);
  });

  test('rejects a case-variant .OK target and writes nothing', async () => {
    const dir = setupTmpDir();

    const result = await callApi(dir, '/api/create-page', { path: '.OK/probe.md' });

    expectReservedRejection(result);
    expect(existsSync(join(dir, '.OK/probe.md'))).toBe(false);
  });
});

describe('reserved-path guard — create-folder', () => {
  test('rejects a root .ok destination and creates nothing', async () => {
    const dir = setupTmpDir();

    const result = await callApi(dir, '/api/create-folder', { path: '.ok/cache' });

    expectReservedRejection(result);
    expect(existsSync(join(dir, '.ok/cache'))).toBe(false);
  });

  test('rejects a nested .ok destination and creates nothing', async () => {
    const dir = setupTmpDir();
    mkdirSync(join(dir, 'notes'), { recursive: true });

    const result = await callApi(dir, '/api/create-folder', { path: 'notes/.ok/cache' });

    expectReservedRejection(result);
    expect(existsSync(join(dir, 'notes/.ok'))).toBe(false);
  });

  test('rejects a case-variant .OK destination and creates nothing', async () => {
    const dir = setupTmpDir();

    const result = await callApi(dir, '/api/create-folder', { path: '.OK/cache' });

    expectReservedRejection(result);
    expect(existsSync(join(dir, '.OK/cache'))).toBe(false);
  });
});

describe('reserved-path guard — duplicate-path', () => {
  test('rejects a root .ok folder source', async () => {
    const dir = setupTmpDir();
    mkdirSync(join(dir, '.ok/templates'), { recursive: true });

    const result = await callApi(dir, '/api/duplicate-path', {
      kind: 'folder',
      path: '.ok/templates',
    });

    expectReservedRejection(result);
    expect(existsSync(join(dir, '.ok/templates copy'))).toBe(false);
  });

  test('rejects a nested .ok file source and copies nothing', async () => {
    const dir = setupTmpDir();
    mkdirSync(join(dir, 'notes/.ok/templates'), { recursive: true });
    writeFileSync(join(dir, 'notes/.ok/templates/starter.md'), '# Starter\n', 'utf-8');

    const result = await callApi(dir, '/api/duplicate-path', {
      kind: 'file',
      path: 'notes/.ok/templates/starter',
    });

    expectReservedRejection(result);
    expect(existsSync(join(dir, 'notes/.ok/templates/starter copy.md'))).toBe(false);
  });

  test('rejects a case-variant .OK folder source', async () => {
    const dir = setupTmpDir();

    const result = await callApi(dir, '/api/duplicate-path', { kind: 'folder', path: '.OK' });

    expectReservedRejection(result);
  });
});

describe('reserved-path guard — rename-path', () => {
  test('rejects a root .ok source path', async () => {
    const dir = setupTmpDir();
    mkdirSync(join(dir, '.ok/templates'), { recursive: true });

    const result = await callApi(dir, '/api/rename-path', {
      kind: 'folder',
      fromPath: '.ok/templates',
      toPath: 'liberated-templates',
    });

    expectReservedRejection(result);
    expect(existsSync(join(dir, '.ok/templates'))).toBe(true);
    expect(existsSync(join(dir, 'liberated-templates'))).toBe(false);
  });

  test('rejects a nested .ok source path and moves nothing', async () => {
    const dir = setupTmpDir();
    mkdirSync(join(dir, 'notes/.ok/templates'), { recursive: true });
    writeFileSync(join(dir, 'notes/.ok/templates/starter.md'), '# Starter\n', 'utf-8');

    const result = await callApi(dir, '/api/rename-path', {
      kind: 'file',
      fromPath: 'notes/.ok/templates/starter',
      toPath: 'liberated',
    });

    expectReservedRejection(result);
    expect(existsSync(join(dir, 'notes/.ok/templates/starter.md'))).toBe(true);
    expect(existsSync(join(dir, 'liberated.md'))).toBe(false);
  });

  test('rejects a nested .ok destination path and moves nothing', async () => {
    const dir = setupTmpDir();
    writeFileSync(join(dir, 'real.md'), '# Real\n', 'utf-8');
    mkdirSync(join(dir, 'notes'), { recursive: true });

    const result = await callApi(dir, '/api/rename-path', {
      kind: 'file',
      fromPath: 'real',
      toPath: 'notes/.ok/sneak',
    });

    expectReservedRejection(result);
    expect(existsSync(join(dir, 'real.md'))).toBe(true);
    expect(existsSync(join(dir, 'notes/.ok'))).toBe(false);
  });

  test('rejects a case-variant .OK destination path and moves nothing', async () => {
    const dir = setupTmpDir();
    writeFileSync(join(dir, 'real.md'), '# Real\n', 'utf-8');

    const result = await callApi(dir, '/api/rename-path', {
      kind: 'file',
      fromPath: 'real',
      toPath: '.OK/sneak',
    });

    expectReservedRejection(result);
    expect(existsSync(join(dir, 'real.md'))).toBe(true);
  });
});

describe('reserved-path guard — delete-path', () => {
  test('rejects a root .ok folder delete and removes nothing', async () => {
    const dir = setupTmpDir();
    mkdirSync(join(dir, '.ok/templates'), { recursive: true });
    writeFileSync(join(dir, '.ok/templates/starter.md'), '# Starter\n', 'utf-8');

    const result = await callApi(dir, '/api/delete-path', { kind: 'folder', path: '.ok' });

    expectReservedRejection(result);
    expect(existsSync(join(dir, '.ok/templates/starter.md'))).toBe(true);
  });

  test('rejects a nested .ok folder delete and removes nothing', async () => {
    const dir = setupTmpDir();
    mkdirSync(join(dir, 'notes/.ok/templates'), { recursive: true });
    writeFileSync(join(dir, 'notes/.ok/templates/starter.md'), '# Starter\n', 'utf-8');

    const result = await callApi(dir, '/api/delete-path', { kind: 'folder', path: 'notes/.ok' });

    expectReservedRejection(result);
    expect(existsSync(join(dir, 'notes/.ok/templates/starter.md'))).toBe(true);
  });

  test('rejects a root .ok file delete and removes nothing', async () => {
    const dir = setupTmpDir();
    mkdirSync(join(dir, '.ok/templates'), { recursive: true });
    writeFileSync(join(dir, '.ok/templates/starter.md'), '# Starter\n', 'utf-8');

    const result = await callApi(dir, '/api/delete-path', {
      kind: 'file',
      path: '.ok/templates/starter',
    });

    expectReservedRejection(result);
    expect(existsSync(join(dir, '.ok/templates/starter.md'))).toBe(true);
  });

  test('rejects a nested .ok file delete and removes nothing', async () => {
    const dir = setupTmpDir();
    mkdirSync(join(dir, 'notes/.ok/templates'), { recursive: true });
    writeFileSync(join(dir, 'notes/.ok/templates/starter.md'), '# Starter\n', 'utf-8');

    const result = await callApi(dir, '/api/delete-path', {
      kind: 'file',
      path: 'notes/.ok/templates/starter',
    });

    expectReservedRejection(result);
    expect(existsSync(join(dir, 'notes/.ok/templates/starter.md'))).toBe(true);
  });

  test('rejects a case-variant .OK file delete', async () => {
    const dir = setupTmpDir();

    const result = await callApi(dir, '/api/delete-path', {
      kind: 'file',
      path: '.OK/anything',
    });

    expectReservedRejection(result);
  });

  test('rejects a nested .ok asset delete and removes nothing', async () => {
    const dir = setupTmpDir();
    mkdirSync(join(dir, 'notes/.ok'), { recursive: true });
    writeFileSync(join(dir, 'notes/.ok/logo.png'), 'fake image bytes', 'utf-8');

    const result = await callApi(dir, '/api/delete-path', {
      kind: 'asset',
      path: 'notes/.ok/logo.png',
    });

    expectReservedRejection(result);
    expect(existsSync(join(dir, 'notes/.ok/logo.png'))).toBe(true);
  });
});

describe('reserved-path guard — trash-cleanup', () => {
  test('rejects a nested .ok folder cleanup', async () => {
    const dir = setupTmpDir();

    const result = await callApi(dir, '/api/trash/cleanup', {
      kind: 'folder',
      path: 'notes/.ok',
    });

    expectReservedRejection(result);
  });

  test('rejects a root .ok file cleanup', async () => {
    const dir = setupTmpDir();

    const result = await callApi(dir, '/api/trash/cleanup', {
      kind: 'file',
      path: '.ok/templates/starter',
    });

    expectReservedRejection(result);
  });
});

describe('reserved-path guard — .git segments', () => {
  test('create-page rejects a nested .git target and writes nothing', async () => {
    const dir = setupTmpDir();
    mkdirSync(join(dir, 'notes'), { recursive: true });

    const result = await callApi(dir, '/api/create-page', { path: 'notes/.git/scratch.md' });

    expectReservedRejection(result);
    expect(existsSync(join(dir, 'notes/.git'))).toBe(false);
  });

  test('delete-path rejects a nested .git folder delete and removes nothing', async () => {
    const dir = setupTmpDir();
    mkdirSync(join(dir, 'notes/.git'), { recursive: true });
    writeFileSync(join(dir, 'notes/.git/config'), '[core]\n', 'utf-8');

    const result = await callApi(dir, '/api/delete-path', { kind: 'folder', path: 'notes/.git' });

    expectReservedRejection(result);
    expect(existsSync(join(dir, 'notes/.git/config'))).toBe(true);
  });

  test('create-folder rejects a nested .git target and creates nothing', async () => {
    const dir = setupTmpDir();
    mkdirSync(join(dir, 'notes'), { recursive: true });

    const result = await callApi(dir, '/api/create-folder', { path: 'notes/.git/hooks' });

    expectReservedRejection(result);
    expect(existsSync(join(dir, 'notes/.git'))).toBe(false);
  });

  test('duplicate-path rejects a nested .git source and copies nothing', async () => {
    const dir = setupTmpDir();
    mkdirSync(join(dir, 'notes/.git'), { recursive: true });
    writeFileSync(join(dir, 'notes/.git/config'), '[core]\n', 'utf-8');

    const result = await callApi(dir, '/api/duplicate-path', {
      kind: 'folder',
      path: 'notes/.git',
    });

    expectReservedRejection(result);
    expect(existsSync(join(dir, 'notes/.git copy'))).toBe(false);
  });

  test('rename-path rejects a .git destination and moves nothing', async () => {
    const dir = setupTmpDir();
    writeFileSync(join(dir, 'real.md'), '# Real\n', 'utf-8');
    mkdirSync(join(dir, 'notes'), { recursive: true });

    const result = await callApi(dir, '/api/rename-path', {
      kind: 'file',
      fromPath: 'real',
      toPath: 'notes/.git/sneak',
    });

    expectReservedRejection(result);
    expect(existsSync(join(dir, 'real.md'))).toBe(true);
    expect(existsSync(join(dir, 'notes/.git'))).toBe(false);
  });

  test('rename-path rejects a nested .git source and moves nothing', async () => {
    const dir = setupTmpDir();
    mkdirSync(join(dir, 'notes/.git'), { recursive: true });
    writeFileSync(join(dir, 'notes/.git/config'), '[core]\n', 'utf-8');

    const result = await callApi(dir, '/api/rename-path', {
      kind: 'folder',
      fromPath: 'notes/.git',
      toPath: 'liberated-git',
    });

    expectReservedRejection(result);
    expect(existsSync(join(dir, 'notes/.git/config'))).toBe(true);
    expect(existsSync(join(dir, 'liberated-git'))).toBe(false);
  });
});

describe('reserved-path guard — ordinary nested dotfolders stay mutable', () => {
  test('create and delete inside notes/.obsidian succeed', async () => {
    const dir = setupTmpDir();
    mkdirSync(join(dir, 'notes'), { recursive: true });

    const created = await callApi(dir, '/api/create-page', {
      path: 'notes/.obsidian/scratch.md',
    });
    expect(created.status).toBe(200);
    expect(existsSync(join(dir, 'notes/.obsidian/scratch.md'))).toBe(true);

    const deleted = await callApi(dir, '/api/delete-path', {
      kind: 'file',
      path: 'notes/.obsidian/scratch',
    });
    expect(deleted.status).toBe(200);
    expect(existsSync(join(dir, 'notes/.obsidian/scratch.md'))).toBe(false);
  });
});
