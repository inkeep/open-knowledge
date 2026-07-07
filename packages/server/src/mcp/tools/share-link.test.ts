/**
 * Unit tests for the `share_link` MCP tool.
 *
 * Boundary checks:
 *   - Polymorphic target resolution: doc OR folder, auto-probed from disk
 *     (`.mdx` → `.md` → directory) or pinned via `kind`. The six-case
 *     matrix lives in the "target resolution" describe block.
 *   - Trailing `.md`/`.mdx` normalization on doc paths.
 *   - The five `ShareConstructUrlErrorCode` business-logic branches map to
 *     distinct, agent-actionable messages. `no-remote` is the load-bearing
 *     one — it must direct the user at publishing (not run it).
 *   - Tool-local codes (`target-not-found`, `kind-mismatch`, `unknown`) are
 *     produced inline by the wrapper and are distinct from the system-wide
 *     `urn:ok:error:doc-not-found` envelope.
 *   - Happy path returns the marketing share URL + branch + resolvedKind.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { type Config, ConfigSchema } from '../../config/schema.ts';
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
  handler: (args: { path: string; kind?: 'doc' | 'folder'; cwd?: string }) => Promise<ToolResult>;
}

function createFakeServer() {
  let registered: RegisteredTool | undefined;
  const server = {
    registerTool(
      name: string,
      cfg: { description?: string; inputSchema?: Record<string, unknown> },
      handler: RegisteredTool['handler'],
    ) {
      registered = {
        name,
        description: cfg.description ?? '',
        inputSchema: cfg.inputSchema,
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

/** Standard success body for the construct-url mock. */
function successBody() {
  return {
    ok: true,
    shareUrl: 'https://openknowledge.ai/d/encoded',
    sharedUrl: 'https://github.com/o/r/blob/main/notes.md',
    branch: 'main',
  };
}

let testServer: ReturnType<typeof Bun.serve>;
let baseUrl: string;
let tmpDir: string;
const seenRequests: Array<{ pathname: string; body: Record<string, unknown> }> = [];
let mockResponse: { status: number; body: Record<string, unknown> } = {
  status: 200,
  body: {},
};
// Escape hatch for the non-JSON / non-2xx scenarios: when set, the fake server
// returns this Response verbatim (bypasses JSON serialization). Per-test
// `beforeEach` clears it so leakage between cases stays impossible.
let mockRawResponse: Response | null = null;

beforeAll(() => {
  testServer = Bun.serve({
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

function makeDeps(serverUrl: string | undefined): ShareLinkDeps {
  return {
    serverUrl,
    config: BASE_CONFIG,
    resolveCwd: async () => tmpDir,
  };
}

/**
 * Write a live `ui.lock` under `<tmpDir>/.ok/local/` so the preview-url
 * resolver's reachability gate fires (a non-null `previewUrl` means "a UI is
 * running"). Uses THIS process's pid + hostname so `readUiLock`'s
 * `isProcessAlive` + same-host checks both pass. Without this, every success
 * case resolves `previewUrl: null` (no UI), so the lock is what lets us assert
 * the concrete doc/folder route shapes.
 */
async function writeUiLock(): Promise<void> {
  const lockDir = resolve(tmpDir, '.ok', 'local');
  await mkdir(lockDir, { recursive: true });
  await writeFile(
    resolve(lockDir, 'ui.lock'),
    JSON.stringify({
      pid: process.pid,
      hostname: hostname(),
      port: 5173,
      startedAt: new Date().toISOString(),
      worktreeRoot: tmpDir,
      protocolVersion: 1,
      runtimeVersion: '0.0.0-test',
    }),
  );
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
    await writeUiLock();
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
    await writeUiLock();
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
    await writeUiLock();
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
    await writeUiLock();
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
    register(server, makeDeps('http://127.0.0.1:1')); // unreachable
    const result = await getTool().handler({ path: 'page' });
    expect(result.isError).toBe(true);
    expect((result.structuredContent as { ok: boolean }).ok).toBe(false);
  });
});

describe('share_link — message coverage', () => {
  /**
   * Every output-enum code must map to a non-empty, agent-actionable message.
   * Server codes flow through `messageForShareError`; tool-local codes
   * (target-not-found, kind-mismatch) are produced inline. `unknown` is
   * exercised by the transport/protocol error paths below.
   */
  const SERVER_CODES = [
    'no-remote',
    'detached-head',
    'branch-not-on-origin',
    'non-github-remote',
    'invalid-path',
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
    // A misconfigured proxy returning HTML on a JSON shim, or a truncated
    // response — covered defensively in share-link.ts. The test pins the
    // catch site so a future refactor that drops the JSON parse guard fails.
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

  test('tolerates an unknown freshness value: no warning, field omitted, tool still succeeds (D21)', async () => {
    await writeFile(resolve(tmpDir, 'notes.md'), '# notes');
    mockResponse = { status: 200, body: { ...successBody(), freshness: 'catching-up' } };
    const { server, getTool } = createFakeServer();
    register(server, makeDeps(baseUrl));
    const result = await getTool().handler({ path: 'notes' });
    // The core schema's value-tolerant catch coerces the unknown value to
    // undefined at parse, so the relay degrades to silence rather than a crash.
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({ ok: true });
    expect(result.structuredContent?.freshness).toBeUndefined();
    expect(result.content[0]?.text?.startsWith('Share link for')).toBe(true);
  });
});
