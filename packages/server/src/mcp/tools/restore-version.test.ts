import {
  describe as _bunDescribe,
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { type Config, ConfigSchema } from '../../config/schema.ts';
import { DESCRIPTION, type RestoreVersionDeps, register } from './restore-version.ts';
import type { ServerInstance } from './shared.ts';
import { HOCUSPOCUS_NOT_RUNNING_ERROR } from './shared.ts';

// See version.test.ts predecessor: skip on CI (simple-git child-reap hang).
const describe = process.env.CI ? _bunDescribe.skip : _bunDescribe;
const BASE_CONFIG: Config = ConfigSchema.parse({});
const SHA = '0123456789abcdef0123456789abcdef01234567';

interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}
interface RegisteredTool {
  name: string;
  description: string;
  handler: (args: {
    document?: string;
    version?: string;
    summary?: string;
    cwd?: string;
  }) => Promise<ToolResult>;
}

function createFakeServer() {
  let registered: RegisteredTool | undefined;
  const server = {
    registerTool(name: string, cfg: { description?: string }, handler: RegisteredTool['handler']) {
      registered = { name, description: cfg.description ?? '', handler };
    },
  } as unknown as ServerInstance;
  return {
    server,
    getTool(): RegisteredTool {
      if (!registered) throw new Error('Tool was not registered');
      return registered;
    },
  };
}

function makeDeps(serverUrl: string | undefined, cwdDir: string): RestoreVersionDeps {
  return { serverUrl, config: BASE_CONFIG, resolveCwd: async () => cwdDir };
}

let testServer: ReturnType<typeof Bun.serve>;
let baseUrl: string;
let tmpDir: string;
const seenRequests: string[] = [];
const seenBodies: Array<Record<string, unknown>> = [];
let mockRollbackWarning: Record<string, unknown> | undefined;

beforeAll(() => {
  testServer = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      const url = new URL(req.url);
      const body = req.method === 'POST' ? ((await req.json()) as Record<string, unknown>) : {};
      seenRequests.push(`${req.method} ${url.pathname}`);
      if (req.method === 'POST') seenBodies.push(body);
      if (url.pathname.startsWith('/api/history/') && req.method === 'GET') {
        return Response.json({ ok: true, author: 'Alice', timestamp: '2026-05-20T00:00:00Z' });
      }
      if (url.pathname === '/api/rollback' && req.method === 'POST') {
        return Response.json({
          ok: true,
          // Mirrors the production handler: the deprecated single `warning`
          // and the unified `warnings` array emit in parallel.
          ...(mockRollbackWarning !== undefined
            ? { warning: mockRollbackWarning, warnings: [mockRollbackWarning] }
            : {}),
        });
      }
      return new Response('Not found', { status: 404 });
    },
  });
  baseUrl = `http://127.0.0.1:${testServer.port}`;
});
afterAll(() => testServer.stop());
beforeEach(async () => {
  tmpDir = await mkdtemp(resolve(tmpdir(), 'ok-restore-version-test-'));
  seenRequests.length = 0;
  seenBodies.length = 0;
  mockRollbackWarning = undefined;
});
afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe('restore_version — registration + behavior', () => {
  test('registers exactly one tool named "restore_version"', () => {
    const { server, getTool } = createFakeServer();
    register(server, makeDeps(baseUrl, tmpDir));
    expect(getTool().name).toBe('restore_version');
    expect(DESCRIPTION).toContain('version');
  });

  test('verifies the version (GET /api/history) then POSTs /api/rollback with commitSha', async () => {
    const { server, getTool } = createFakeServer();
    register(server, makeDeps(baseUrl, tmpDir));
    const result = await getTool().handler({ document: 'notes/x', version: SHA });
    expect(result.isError).toBeFalsy();
    expect(seenRequests.some((r) => r.startsWith('GET /api/history/'))).toBe(true);
    expect(seenRequests).toContain('POST /api/rollback');
    expect(seenBodies.at(-1)?.commitSha).toBe(SHA);
    expect(seenBodies.at(-1)?.docName).toBe('notes/x');
    expect(result.content[0]?.text).toContain('Restored "notes/x"');
    // Structured output echoes what was restored, in the shared `version` vocabulary.
    expect(result.structuredContent?.document).toBe('notes/x');
    expect(result.structuredContent?.version).toBe(SHA);
  });

  test('relays a content-divergence warning into structuredContent', async () => {
    mockRollbackWarning = {
      kind: 'content-divergence',
      intendedBytes: 100,
      actualBytes: 98,
      byteDelta: -2,
      divergenceType: 'residue',
    };
    const { server, getTool } = createFakeServer();
    register(server, makeDeps(baseUrl, tmpDir));
    const result = await getTool().handler({ document: 'notes/x', version: SHA });
    const warnings = result.structuredContent?.warnings as Array<{ kind: string }> | undefined;
    expect(warnings).toHaveLength(1);
    expect(warnings?.[0]?.kind).toBe('content-divergence');
    expect(result.content[0]?.text).toContain('Content divergence');
  });

  test('returns Hocuspocus-unavailable error when no serverUrl is configured', async () => {
    const { server, getTool } = createFakeServer();
    register(server, makeDeps(undefined, tmpDir));
    const result = await getTool().handler({ document: 'notes/x', version: SHA });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain(HOCUSPOCUS_NOT_RUNNING_ERROR);
  });
});
