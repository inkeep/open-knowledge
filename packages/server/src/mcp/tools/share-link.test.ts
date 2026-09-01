import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import type { z } from 'zod';
import { type Config, ConfigSchema } from '../../config/schema.ts';
import { acquireServerLock, updateServerLockPort } from '../../server-lock.ts';
import { type FetchTestServer, startFetchTestServer } from './fetch-test-server.test-helper.ts';
import { register, type ShareLinkDeps } from './share-link.ts';
import type { ServerInstance } from './shared.ts';
import { HOCUSPOCUS_NOT_RUNNING_ERROR } from './shared.ts';

const BASE_CONFIG: Config = ConfigSchema.parse({});

interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

interface RegisteredTool {
  name: string;
  description: string;
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, z.ZodType>;
  handler: (args: { path: string; kind?: 'doc' | 'folder'; cwd?: string }) => Promise<ToolResult>;
}

function createFakeServer() {
  let registered: RegisteredTool | undefined;
  const server = {
    registerTool(
      name: string,
      cfg: {
        description?: string;
        inputSchema?: Record<string, unknown>;
        outputSchema?: Record<string, z.ZodType>;
      },
      handler: RegisteredTool['handler'],
    ) {
      registered = {
        name,
        description: cfg.description ?? '',
        inputSchema: cfg.inputSchema,
        outputSchema: cfg.outputSchema,
        handler,
      };
    },
  } as unknown as ServerInstance;
  return {
    server,
    getTool(): RegisteredTool {
      if (!registered) throw new Error('share_link was not registered');
      return registered;
    },
  };
}

function successBody() {
  return {
    ok: true,
    shareUrl: 'https://openknowledge.ai/d/encoded',
    sharedUrl: 'https://github.com/o/r/blob/main/notes.md',
    branch: 'main',
  };
}

let testServer: FetchTestServer;
let baseUrl: string;
let tmpDir: string;
const seenRequests: Array<{ pathname: string; body: Record<string, unknown> }> = [];
let mockResponse: { status: number; body: Record<string, unknown> } = {
  status: 200,
  body: {},
};
let mockRawResponse: Response | null = null;

beforeAll(async () => {
  testServer = await startFetchTestServer({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      const url = new URL(req.url);
      const body = req.method === 'POST' ? ((await req.json()) as Record<string, unknown>) : {};
      seenRequests.push({ pathname: url.pathname, body });
      if (url.pathname === '/api/share/construct-url') {
        if (mockRawResponse) return mockRawResponse.clone();
        return new Response(JSON.stringify(mockResponse.body), {
          status: mockResponse.status,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response('Not found', { status: 404 });
    },
  });
  baseUrl = `http://127.0.0.1:${testServer.port}`;
});

afterAll(() => {
  testServer.stop();
});

beforeEach(async () => {
  tmpDir = await mkdtemp(resolve(tmpdir(), 'ok-share-link-test-'));
  await mkdir(resolve(tmpDir, '.ok'), { recursive: true });
  seenRequests.length = 0;
  mockResponse = { status: 200, body: {} };
  mockRawResponse = null;
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

function makeDeps(serverUrl: string | undefined, config: Config = BASE_CONFIG): ShareLinkDeps {
  return {
    serverUrl,
    config,
    resolveCwd: async () => tmpDir,
  };
}

async function seedUiServer(): Promise<void> {
  const lockDir = resolve(tmpDir, '.ok', 'local');
  await mkdir(lockDir, { recursive: true });
  acquireServerLock(lockDir, {
    port: 0,
    worktreeRoot: tmpDir,
    capabilities: ['http', 'ws', 'ui'],
  });
  updateServerLockPort(lockDir, 5173, 'http://localhost:5173');
}

describe('share_link — registration + preconditions', () => {
  test('registers a single tool named `share_link`', () => {
    const { server, getTool } = createFakeServer();
    register(server, makeDeps(baseUrl));
    expect(getTool().name).toBe('share_link');
  });

  test('description states publishing is not agent-initiated', () => {
    const { server, getTool } = createFakeServer();
    register(server, makeDeps(baseUrl));
    expect(getTool().description).toContain('Publishing is a user act');
  });

  test('description documents path/kind/cwd and that kind is required for empty path', () => {
    const { server, getTool } = createFakeServer();
    register(server, makeDeps(baseUrl));
    const desc = getTool().description;
    expect(desc).toContain('`path`');
    expect(desc).toContain('`kind`');
    expect(desc).toContain('`cwd`');
    expect(desc).toContain('auto-probe');
    expect(desc).toContain('REQUIRED when `path` is empty');
  });

  test('input schema is exactly {path, kind?, cwd?}', () => {
    const { server, getTool } = createFakeServer();
    register(server, makeDeps(baseUrl));
    const schema = getTool().inputSchema;
    expect(schema).toBeDefined();
    expect(Object.keys(schema as Record<string, unknown>).sort()).toEqual(['cwd', 'kind', 'path']);
  });

  test('errors when Hocuspocus URL is unset', async () => {
    const { server, getTool } = createFakeServer();
    register(server, makeDeps(undefined));
    await writeFile(resolve(tmpDir, 'notes.md'), '# notes');
    const result = await getTool().handler({ path: 'notes' });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toBe(HOCUSPOCUS_NOT_RUNNING_ERROR);
  });
});

describe('share_link — target resolution (FR9 matrix)', () => {
  test('(a) {path:notes} with notes.mdx on disk → success, resolvedKind doc', async () => {
    await writeFile(resolve(tmpDir, 'notes.mdx'), '# notes');
    mockResponse = { status: 200, body: successBody() };
    const { server, getTool } = createFakeServer();
    register(server, makeDeps(baseUrl));
    const result = await getTool().handler({ path: 'notes' });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({ ok: true, resolvedKind: 'doc' });
    expect(seenRequests[0]?.body).toEqual({ kind: 'doc', docPath: 'notes.mdx' });
  });

  test('(b) {path:guides} with guides/ directory → success, resolvedKind folder', async () => {
    await mkdir(resolve(tmpDir, 'guides'), { recursive: true });
    mockResponse = { status: 200, body: successBody() };
    const { server, getTool } = createFakeServer();
    register(server, makeDeps(baseUrl));
    const result = await getTool().handler({ path: 'guides' });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({ ok: true, resolvedKind: 'folder' });
    expect(seenRequests[0]?.body).toEqual({ kind: 'folder', folderPath: 'guides' });
  });

  test('(c) {path:guides, kind:doc} where guides is a directory → kind-mismatch', async () => {
    await mkdir(resolve(tmpDir, 'guides'), { recursive: true });
    const { server, getTool } = createFakeServer();
    register(server, makeDeps(baseUrl));
    const result = await getTool().handler({ path: 'guides', kind: 'doc' });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ ok: false, error: 'kind-mismatch' });
    expect(seenRequests).toHaveLength(0);
  });

  test('(d) {path:"", kind:folder} → root share success, folderPath ""', async () => {
    mockResponse = {
      status: 200,
      body: {
        ok: true,
        shareUrl: 'https://openknowledge.ai/d/root',
        sharedUrl: 'https://github.com/o/r/tree/main',
        branch: 'main',
      },
    };
    const { server, getTool } = createFakeServer();
    register(server, makeDeps(baseUrl));
    const result = await getTool().handler({ path: '', kind: 'folder' });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({ ok: true, resolvedKind: 'folder' });
    expect(seenRequests[0]?.body).toEqual({ kind: 'folder', folderPath: '' });
  });

  test('(e1) {path:""} with no kind → invalid-path', async () => {
    const { server, getTool } = createFakeServer();
    register(server, makeDeps(baseUrl));
    const result = await getTool().handler({ path: '' });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ ok: false, error: 'invalid-path' });
    expect(seenRequests).toHaveLength(0);
  });

  test('(e2) {path:"", kind:doc} → invalid-path', async () => {
    const { server, getTool } = createFakeServer();
    register(server, makeDeps(baseUrl));
    const result = await getTool().handler({ path: '', kind: 'doc' });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ ok: false, error: 'invalid-path' });
    expect(seenRequests).toHaveLength(0);
  });

  test('(f) {path:nope} nonexistent → target-not-found', async () => {
    const { server, getTool } = createFakeServer();
    register(server, makeDeps(baseUrl));
    const result = await getTool().handler({ path: 'nope' });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ ok: false, error: 'target-not-found' });
    expect(result.content[0]?.text).toContain('does not exist');
    expect(seenRequests).toHaveLength(0);
  });

  test('symmetric: {path:notes, kind:folder} where notes.mdx is a file → kind-mismatch', async () => {
    await writeFile(resolve(tmpDir, 'notes.mdx'), '# notes');
    const { server, getTool } = createFakeServer();
    register(server, makeDeps(baseUrl));
    const result = await getTool().handler({ path: 'notes', kind: 'folder' });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ ok: false, error: 'kind-mismatch' });
    expect(seenRequests).toHaveLength(0);
  });

  test('strips trailing `.md` from a doc path before probing', async () => {
    await writeFile(resolve(tmpDir, 'notes.md'), '# notes');
    mockResponse = { status: 200, body: successBody() };
    const { server, getTool } = createFakeServer();
    register(server, makeDeps(baseUrl));
    const result = await getTool().handler({ path: 'notes.md' });
    expect(result.isError).toBeUndefined();
    expect(seenRequests[0]?.body).toEqual({ kind: 'doc', docPath: 'notes.md' });
  });

  test('auto-probe: `.mdx` wins over `.md` when both exist', async () => {
    await writeFile(resolve(tmpDir, 'collide.md'), '# md');
    await writeFile(resolve(tmpDir, 'collide.mdx'), '# mdx');
    mockResponse = { status: 200, body: successBody() };
    const { server, getTool } = createFakeServer();
    register(server, makeDeps(baseUrl));
    const result = await getTool().handler({ path: 'collide' });
    expect(result.isError).toBeUndefined();
    expect(seenRequests[0]?.body).toEqual({ kind: 'doc', docPath: 'collide.mdx' });
  });

  test('kind:doc resolves a `.md` doc when `.mdx` absent', async () => {
    await writeFile(resolve(tmpDir, 'guide.md'), '# guide');
    mockResponse = { status: 200, body: successBody() };
    const { server, getTool } = createFakeServer();
    register(server, makeDeps(baseUrl));
    const result = await getTool().handler({ path: 'guide', kind: 'doc' });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({ ok: true, resolvedKind: 'doc' });
    expect(seenRequests[0]?.body).toEqual({ kind: 'doc', docPath: 'guide.md' });
  });

  test('non-root content dir posts content-relative doc and folder paths', async () => {
    const config = ConfigSchema.parse({ content: { dir: 'vault' } });
    await mkdir(resolve(tmpDir, 'vault', 'guides'), { recursive: true });
    await writeFile(resolve(tmpDir, 'vault', 'notes.md'), '# notes');
    mockResponse = { status: 200, body: successBody() };
    const { server, getTool } = createFakeServer();
    register(server, makeDeps(baseUrl, config));

    const docResult = await getTool().handler({ path: 'notes', kind: 'doc' });
    const folderResult = await getTool().handler({ path: 'guides', kind: 'folder' });

    expect(docResult.isError).toBeUndefined();
    expect(folderResult.isError).toBeUndefined();
    expect(seenRequests.map(({ body }) => body)).toEqual([
      { kind: 'doc', docPath: 'notes.md' },
      { kind: 'folder', folderPath: 'guides' },
    ]);
  });

  test('auto-probe (no kind) under a non-root content dir posts content-relative paths', async () => {
    const config = ConfigSchema.parse({ content: { dir: 'vault' } });
    await mkdir(resolve(tmpDir, 'vault', 'guides'), { recursive: true });
    await writeFile(resolve(tmpDir, 'vault', 'notes.md'), '# notes');
    mockResponse = { status: 200, body: successBody() };
    const { server, getTool } = createFakeServer();
    register(server, makeDeps(baseUrl, config));

    const docResult = await getTool().handler({ path: 'notes' });
    const folderResult = await getTool().handler({ path: 'guides' });

    expect(docResult.isError).toBeUndefined();
    expect(docResult.structuredContent).toMatchObject({ ok: true, resolvedKind: 'doc' });
    expect(folderResult.isError).toBeUndefined();
    expect(folderResult.structuredContent).toMatchObject({ ok: true, resolvedKind: 'folder' });
    expect(seenRequests.map(({ body }) => body)).toEqual([
      { kind: 'doc', docPath: 'notes.md' },
      { kind: 'folder', folderPath: 'guides' },
    ]);
  });

  test('rejects paths escaping the content root as target-not-found', async () => {
    const { server, getTool } = createFakeServer();
    register(server, makeDeps(baseUrl));
    const result = await getTool().handler({ path: '../escaped' });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ ok: false, error: 'target-not-found' });
    expect(seenRequests).toHaveLength(0);
  });
});

describe('share_link — happy path', () => {
  test('returns shareUrl + branch + sharedUrl + resolvedKind on doc success', async () => {
    await writeFile(resolve(tmpDir, 'meeting.md'), '# meeting');
    mockResponse = {
      status: 200,
      body: {
        ok: true,
        shareUrl: 'https://openknowledge.ai/d/encoded',
        sharedUrl: 'https://github.com/inkeep/wiki/blob/main/meeting.md',
        branch: 'main',
      },
    };
    const { server, getTool } = createFakeServer();
    register(server, makeDeps(baseUrl));
    const result = await getTool().handler({ path: 'meeting' });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({
      ok: true,
      shareUrl: 'https://openknowledge.ai/d/encoded',
      sharedUrl: 'https://github.com/inkeep/wiki/blob/main/meeting.md',
      branch: 'main',
      resolvedKind: 'doc',
    });
    expect(result.content[0]?.text).toContain('https://openknowledge.ai/d/encoded');
    expect(result.content[0]?.text).toContain('main');
    expect(result.content[0]?.text).toContain('doc');
    expect(result.content[0]?.text).toContain('meeting');
  });

  test('folder success text names the resolved folder + branch', async () => {
    await mkdir(resolve(tmpDir, 'guides'), { recursive: true });
    mockResponse = {
      status: 200,
      body: {
        ok: true,
        shareUrl: 'https://openknowledge.ai/d/folder',
        sharedUrl: 'https://github.com/o/r/tree/main/guides',
        branch: 'main',
      },
    };
    const { server, getTool } = createFakeServer();
    register(server, makeDeps(baseUrl));
    const result = await getTool().handler({ path: 'guides', kind: 'folder' });
    expect(result.isError).toBeUndefined();
    expect(result.content[0]?.text).toContain('folder');
    expect(result.content[0]?.text).toContain('guides');
  });

  test('doc success previewUrl is the doc route `/#/<doc>` when a UI is running', async () => {
    await writeFile(resolve(tmpDir, 'meeting.md'), '# meeting');
    await seedUiServer();
    mockResponse = { status: 200, body: successBody() };
    const { server, getTool } = createFakeServer();
    register(server, makeDeps(baseUrl));
    const result = await getTool().handler({ path: 'meeting' });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({
      ok: true,
      resolvedKind: 'doc',
      previewUrl: '/#/meeting',
    });
  });

  test('folder success previewUrl is the trailing-slash folder route when a UI is running', async () => {
    await mkdir(resolve(tmpDir, 'guides'), { recursive: true });
    await seedUiServer();
    mockResponse = {
      status: 200,
      body: {
        ok: true,
        shareUrl: 'https://openknowledge.ai/d/folder',
        sharedUrl: 'https://github.com/o/r/tree/main/guides',
        branch: 'main',
      },
    };
    const { server, getTool } = createFakeServer();
    register(server, makeDeps(baseUrl));
    const result = await getTool().handler({ path: 'guides', kind: 'folder' });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({
      ok: true,
      resolvedKind: 'folder',
      previewUrl: '/#/guides/',
    });
  });

  test('content-root folder success previewUrl is the root route `/#/`', async () => {
    await seedUiServer();
    mockResponse = {
      status: 200,
      body: {
        ok: true,
        shareUrl: 'https://openknowledge.ai/d/root',
        sharedUrl: 'https://github.com/o/r/tree/main',
        branch: 'main',
      },
    };
    const { server, getTool } = createFakeServer();
    register(server, makeDeps(baseUrl));
    const result = await getTool().handler({ path: '', kind: 'folder' });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({
      ok: true,
      resolvedKind: 'folder',
      previewUrl: '/#/',
    });
  });

  test('nested folder previewUrl encodes per segment with trailing slash', async () => {
    await mkdir(resolve(tmpDir, 'docs', 'api guide'), { recursive: true });
    await seedUiServer();
    mockResponse = {
      status: 200,
      body: {
        ok: true,
        shareUrl: 'https://openknowledge.ai/d/nested',
        sharedUrl: 'https://github.com/o/r/tree/main/docs/api%20guide',
        branch: 'main',
      },
    };
    const { server, getTool } = createFakeServer();
    register(server, makeDeps(baseUrl));
    const result = await getTool().handler({ path: 'docs/api guide', kind: 'folder' });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({
      ok: true,
      resolvedKind: 'folder',
      previewUrl: '/#/docs/api%20guide/',
    });
  });

  test('folder previewUrl is null when no UI is running', async () => {
    await mkdir(resolve(tmpDir, 'guides'), { recursive: true });
    mockResponse = {
      status: 200,
      body: {
        ok: true,
        shareUrl: 'https://openknowledge.ai/d/folder',
        sharedUrl: 'https://github.com/o/r/tree/main/guides',
        branch: 'main',
      },
    };
    const { server, getTool } = createFakeServer();
    register(server, makeDeps(baseUrl));
    const result = await getTool().handler({ path: 'guides', kind: 'folder' });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({
      ok: true,
      resolvedKind: 'folder',
      previewUrl: null,
    });
  });
});

describe('share_link — business-logic errors', () => {
  test('no-remote: directs user at publishing, does NOT run it', async () => {
    await writeFile(resolve(tmpDir, 'page.md'), '# page');
    mockResponse = { status: 200, body: { ok: false, error: 'no-remote' } };
    const { server, getTool } = createFakeServer();
    register(server, makeDeps(baseUrl));
    const result = await getTool().handler({ path: 'page' });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ ok: false, error: 'no-remote' });
    const message = (result.structuredContent as { message: string }).message;
    expect(message).toContain('no GitHub remote');
    expect(message).toContain('push');
    expect(message).toContain('Agents do not publish');
  });

  test('detached-head: tells the user to check out a branch', async () => {
    await writeFile(resolve(tmpDir, 'page.md'), '# page');
    mockResponse = { status: 200, body: { ok: false, error: 'detached-head' } };
    const { server, getTool } = createFakeServer();
    register(server, makeDeps(baseUrl));
    const result = await getTool().handler({ path: 'page' });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ ok: false, error: 'detached-head' });
    expect((result.structuredContent as { message: string }).message).toContain('detached');
  });

  test('branch-not-on-origin: names the branch and asks for a push', async () => {
    await writeFile(resolve(tmpDir, 'page.md'), '# page');
    mockResponse = {
      status: 200,
      body: { ok: false, error: 'branch-not-on-origin', branch: 'feat/share' },
    };
    const { server, getTool } = createFakeServer();
    register(server, makeDeps(baseUrl));
    const result = await getTool().handler({ path: 'page' });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      ok: false,
      error: 'branch-not-on-origin',
      branch: 'feat/share',
    });
    const message = (result.structuredContent as { message: string }).message;
    expect(message).toContain('feat/share');
    expect(message).toContain('git push');
  });

  test('non-github-remote: explains GitHub-only constraint', async () => {
    await writeFile(resolve(tmpDir, 'page.md'), '# page');
    mockResponse = { status: 200, body: { ok: false, error: 'non-github-remote' } };
    const { server, getTool } = createFakeServer();
    register(server, makeDeps(baseUrl));
    const result = await getTool().handler({ path: 'page' });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ ok: false, error: 'non-github-remote' });
    expect((result.structuredContent as { message: string }).message).toContain('GitHub');
  });

  test('invalid-path (server): reworded substrate-neutral (no "document")', async () => {
    await writeFile(resolve(tmpDir, 'page.md'), '# page');
    mockResponse = { status: 200, body: { ok: false, error: 'invalid-path' } };
    const { server, getTool } = createFakeServer();
    register(server, makeDeps(baseUrl));
    const result = await getTool().handler({ path: 'page' });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ ok: false, error: 'invalid-path' });
    const message = (result.structuredContent as { message: string }).message;
    expect(message).toContain('not shareable');
    expect(message).toContain('resolved share path');
    expect(message).not.toContain('document');
    expect(message).not.toContain('Document');
  });

  test('unsupported-share-url: gives bounded recovery guidance', async () => {
    await writeFile(resolve(tmpDir, 'page.md'), '# page');
    mockResponse = { status: 200, body: { ok: false, error: 'unsupported-share-url' } };
    const { server, getTool } = createFakeServer();
    register(server, makeDeps(baseUrl));
    const result = await getTool().handler({ path: 'page' });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      ok: false,
      error: 'unsupported-share-url',
    });
    const message = (result.structuredContent as { message: string }).message;
    expect(message).toContain('canonical DNS GitHub host');
    expect(message).toContain('shorter repository path');
  });

  test('branch-not-on-origin: message carries the stale-fetch recovery hint', async () => {
    await writeFile(resolve(tmpDir, 'page.md'), '# page');
    mockResponse = {
      status: 200,
      body: { ok: false, error: 'branch-not-on-origin', branch: 'feat/share' },
    };
    const { server, getTool } = createFakeServer();
    register(server, makeDeps(baseUrl));
    const result = await getTool().handler({ path: 'page' });
    expect(result.isError).toBe(true);
    const message = (result.structuredContent as { message: string }).message;
    expect(message).toContain('git fetch origin');
  });

  test('transport error: surfaces a tool-level error when the server is down', async () => {
    await writeFile(resolve(tmpDir, 'page.md'), '# page');
    const { server, getTool } = createFakeServer();
    register(server, makeDeps('http://127.0.0.1:1'));
    const result = await getTool().handler({ path: 'page' });
    expect(result.isError).toBe(true);
    expect((result.structuredContent as { ok: boolean }).ok).toBe(false);
  });
});

describe('share_link — message coverage', () => {
  const SERVER_CODES = [
    'no-remote',
    'detached-head',
    'branch-not-on-origin',
    'non-github-remote',
    'invalid-path',
    'unsupported-share-url',
  ] as const;

  for (const code of SERVER_CODES) {
    test(`server code ${code} → non-empty message`, async () => {
      await writeFile(resolve(tmpDir, 'page.md'), '# page');
      mockResponse = { status: 200, body: { ok: false, error: code } };
      const { server, getTool } = createFakeServer();
      register(server, makeDeps(baseUrl));
      const result = await getTool().handler({ path: 'page' });
      const message = (result.structuredContent as { message: string }).message;
      expect(typeof message).toBe('string');
      expect(message.length).toBeGreaterThan(0);
    });
  }

  test('target-not-found → non-empty message', async () => {
    const { server, getTool } = createFakeServer();
    register(server, makeDeps(baseUrl));
    const result = await getTool().handler({ path: 'nope' });
    const message = (result.structuredContent as { message: string }).message;
    expect(message.length).toBeGreaterThan(0);
  });

  test('kind-mismatch → non-empty message', async () => {
    await mkdir(resolve(tmpDir, 'guides'), { recursive: true });
    const { server, getTool } = createFakeServer();
    register(server, makeDeps(baseUrl));
    const result = await getTool().handler({ path: 'guides', kind: 'doc' });
    const message = (result.structuredContent as { message: string }).message;
    expect(message.length).toBeGreaterThan(0);
  });

  test('invalid-path (tool-local empty path) → non-empty message', async () => {
    const { server, getTool } = createFakeServer();
    register(server, makeDeps(baseUrl));
    const result = await getTool().handler({ path: '' });
    const message = (result.structuredContent as { message: string }).message;
    expect(message.length).toBeGreaterThan(0);
  });
});

describe('share_link — transport / protocol error paths', () => {
  test('non-JSON 200 body: tool-level error mentions the parse failure', async () => {
    await writeFile(resolve(tmpDir, 'page.md'), '# page');
    mockRawResponse = new Response('<html>not json</html>', {
      status: 200,
      headers: { 'Content-Type': 'text/html' },
    });
    const { server, getTool } = createFakeServer();
    register(server, makeDeps(baseUrl));
    const result = await getTool().handler({ path: 'page' });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ ok: false, error: 'unknown' });
    expect(result.content[0]?.text).toMatch(/non-JSON/i);
  });

  test('non-2xx with RFC 9457 body: forwards both `title` and `detail`', async () => {
    await writeFile(resolve(tmpDir, 'page.md'), '# page');
    mockRawResponse = new Response(
      JSON.stringify({
        type: 'urn:ok:error:internal-server-error',
        title: 'Internal server error',
        detail: 'origin lookup failed: ENETUNREACH',
        status: 500,
      }),
      { status: 500, headers: { 'Content-Type': 'application/problem+json' } },
    );
    const { server, getTool } = createFakeServer();
    register(server, makeDeps(baseUrl));
    const result = await getTool().handler({ path: 'page' });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('Internal server error');
    expect(result.content[0]?.text).toContain('ENETUNREACH');
  });

  test('non-2xx with title-only RFC 9457: forwards title without `:` separator', async () => {
    await writeFile(resolve(tmpDir, 'page.md'), '# page');
    mockRawResponse = new Response(
      JSON.stringify({
        type: 'urn:ok:error:internal-server-error',
        title: 'Internal server error',
        status: 500,
      }),
      { status: 500, headers: { 'Content-Type': 'application/problem+json' } },
    );
    const { server, getTool } = createFakeServer();
    register(server, makeDeps(baseUrl));
    const result = await getTool().handler({ path: 'page' });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('Internal server error');
    expect(result.content[0]?.text).not.toContain('Internal server error:');
    expect(result.content[0]?.text).not.toContain('HTTP 500');
  });

  test('non-2xx with detail-only RFC 9457: forwards detail (title-less)', async () => {
    await writeFile(resolve(tmpDir, 'page.md'), '# page');
    mockRawResponse = new Response(
      JSON.stringify({
        type: 'urn:ok:error:internal-server-error',
        detail: 'origin lookup failed: ENETUNREACH',
        status: 500,
      }),
      { status: 500, headers: { 'Content-Type': 'application/problem+json' } },
    );
    const { server, getTool } = createFakeServer();
    register(server, makeDeps(baseUrl));
    const result = await getTool().handler({ path: 'page' });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('ENETUNREACH');
    expect(result.content[0]?.text).not.toContain('HTTP 500');
  });

  test('non-2xx without title/detail: falls back to bare HTTP status', async () => {
    await writeFile(resolve(tmpDir, 'page.md'), '# page');
    mockRawResponse = new Response(JSON.stringify({ msg: 'down' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    });
    const { server, getTool } = createFakeServer();
    register(server, makeDeps(baseUrl));
    const result = await getTool().handler({ path: 'page' });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('HTTP 503');
  });

  test('200 with unexpected JSON shape: Zod parse failure → tool-level error', async () => {
    await writeFile(resolve(tmpDir, 'page.md'), '# page');
    mockResponse = { status: 200, body: { unexpected: 'shape', no_ok_field: true } };
    const { server, getTool } = createFakeServer();
    register(server, makeDeps(baseUrl));
    const result = await getTool().handler({ path: 'page' });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ ok: false, error: 'unknown' });
    expect(result.content[0]?.text).toContain('unexpected share-construct-url response shape');
  });
});

describe('share_link — freshness relay (FR6)', () => {
  test('threads a stale freshness into structuredContent and prepends the fact line', async () => {
    await writeFile(resolve(tmpDir, 'notes.md'), '# notes');
    mockResponse = { status: 200, body: { ...successBody(), freshness: 'stale' } };
    const { server, getTool } = createFakeServer();
    register(server, makeDeps(baseUrl));
    const result = await getTool().handler({ path: 'notes' });
    expect(result.structuredContent).toMatchObject({ ok: true, freshness: 'stale' });
    expect(result.content[0]?.text).toContain('has unpushed changes');
    expect(result.content[0]?.text).toContain('Share link for doc');
  });

  test('threads an absent freshness and prepends the dead-link fact line', async () => {
    await writeFile(resolve(tmpDir, 'notes.md'), '# notes');
    mockResponse = { status: 200, body: { ...successBody(), freshness: 'absent' } };
    const { server, getTool } = createFakeServer();
    register(server, makeDeps(baseUrl));
    const result = await getTool().handler({ path: 'notes' });
    expect(result.structuredContent).toMatchObject({ ok: true, freshness: 'absent' });
    expect(result.content[0]?.text).toContain("isn't on GitHub yet");
  });

  test('uses the "folder" word in the fact line for a folder share', async () => {
    await mkdir(resolve(tmpDir, 'guides'), { recursive: true });
    mockResponse = { status: 200, body: { ...successBody(), freshness: 'absent' } };
    const { server, getTool } = createFakeServer();
    register(server, makeDeps(baseUrl));
    const result = await getTool().handler({ path: 'guides' });
    expect(result.content[0]?.text).toContain("This folder isn't on GitHub yet");
  });

  test('adds no warning when the target is current', async () => {
    await writeFile(resolve(tmpDir, 'notes.md'), '# notes');
    mockResponse = { status: 200, body: { ...successBody(), freshness: 'current' } };
    const { server, getTool } = createFakeServer();
    register(server, makeDeps(baseUrl));
    const result = await getTool().handler({ path: 'notes' });
    expect(result.structuredContent).toMatchObject({ ok: true, freshness: 'current' });
    const text = result.content[0]?.text ?? '';
    expect(text).not.toContain('unpushed');
    expect(text).not.toContain("isn't on GitHub");
    expect(text.startsWith('Share link for')).toBe(true);
  });

  test('omits freshness and adds no warning when the server omits it (fail-open)', async () => {
    await writeFile(resolve(tmpDir, 'notes.md'), '# notes');
    mockResponse = { status: 200, body: successBody() };
    const { server, getTool } = createFakeServer();
    register(server, makeDeps(baseUrl));
    const result = await getTool().handler({ path: 'notes' });
    expect(result.structuredContent).toMatchObject({ ok: true });
    expect(result.structuredContent?.freshness).toBeUndefined();
    expect(result.content[0]?.text?.startsWith('Share link for')).toBe(true);
  });

  test('relays the empty-folder sentence instead of a push remedy', async () => {
    await mkdir(resolve(tmpDir, 'hollow'), { recursive: true });
    mockResponse = { status: 200, body: { ...successBody(), freshness: 'empty' } };
    const { server, getTool } = createFakeServer();
    register(server, makeDeps(baseUrl));
    const result = await getTool().handler({ path: 'hollow' });
    expect(result.structuredContent).toMatchObject({ ok: true, freshness: 'empty' });
    const text = result.content[0]?.text ?? '';
    expect(text).toContain("Git can't track this folder");
    expect(text).toContain(
      "it's empty or contains only ignored files. The link won't work until you add a tracked document.",
    );
    expect(text).not.toContain("isn't on GitHub yet");
  });

  test('declares the empty verdict in the output schema so strict clients accept it', () => {
    const { server, getTool } = createFakeServer();
    register(server, makeDeps(baseUrl));
    const freshnessSchema = getTool().outputSchema?.freshness;
    expect(freshnessSchema?.safeParse('empty').success).toBe(true);
  });

  test('tolerates an unknown freshness value: no warning, field omitted, tool still succeeds (D21)', async () => {
    await writeFile(resolve(tmpDir, 'notes.md'), '# notes');
    mockResponse = { status: 200, body: { ...successBody(), freshness: 'catching-up' } };
    const { server, getTool } = createFakeServer();
    register(server, makeDeps(baseUrl));
    const result = await getTool().handler({ path: 'notes' });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({ ok: true });
    expect(result.structuredContent?.freshness).toBeUndefined();
    expect(result.content[0]?.text?.startsWith('Share link for')).toBe(true);
  });
});
