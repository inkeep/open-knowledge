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
import { type CheckpointDeps, DESCRIPTION, register } from './checkpoint.ts';
import type { ServerInstance } from './shared.ts';
import { HOCUSPOCUS_NOT_RUNNING_ERROR } from './shared.ts';

// See version.test.ts predecessor: skip on CI (simple-git child-reap hang).
const describe = process.env.CI ? _bunDescribe.skip : _bunDescribe;
const BASE_CONFIG: Config = ConfigSchema.parse({});

interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}
interface RegisteredTool {
  name: string;
  description: string;
  handler: (args: { summary?: string; cwd?: string }) => Promise<ToolResult>;
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

function makeDeps(serverUrl: string | undefined, cwdDir: string): CheckpointDeps {
  return { serverUrl, config: BASE_CONFIG, resolveCwd: async () => cwdDir };
}

let testServer: ReturnType<typeof Bun.serve>;
let baseUrl: string;
let tmpDir: string;
const seenBodies: Array<Record<string, unknown>> = [];

beforeAll(() => {
  testServer = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      const url = new URL(req.url);
      const body = req.method === 'POST' ? ((await req.json()) as Record<string, unknown>) : {};
      if (req.method === 'POST') seenBodies.push(body);
      if (url.pathname === '/api/save-version' && req.method === 'POST') {
        return Response.json({
          ok: true,
          checkpointRef: 'refs/checkpoints/main/1234567890abcdef1234567890abcdef12345678',
        });
      }
      return new Response('Not found', { status: 404 });
    },
  });
  baseUrl = `http://127.0.0.1:${testServer.port}`;
});
afterAll(() => testServer.stop());
beforeEach(async () => {
  tmpDir = await mkdtemp(resolve(tmpdir(), 'ok-checkpoint-test-'));
  seenBodies.length = 0;
});
afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe('checkpoint — registration + behavior', () => {
  test('registers exactly one tool named "checkpoint"', () => {
    const { server, getTool } = createFakeServer();
    register(server, makeDeps(baseUrl, tmpDir));
    expect(getTool().name).toBe('checkpoint');
    expect(DESCRIPTION).toContain('project-wide');
  });

  test('hits POST /api/save-version and returns version + null previewUrl', async () => {
    const { server, getTool } = createFakeServer();
    register(server, makeDeps(baseUrl, tmpDir));
    const result = await getTool().handler({});
    // The route's `checkpointRef` is surfaced to agents as `version`.
    expect(result.structuredContent?.version).toBe('1234567890abcdef1234567890abcdef12345678');
    expect(result.structuredContent?.previewUrl).toBeNull();
  });

  test('summary is forwarded in the save-version body when present', async () => {
    const { server, getTool } = createFakeServer();
    register(server, makeDeps(baseUrl, tmpDir));
    await getTool().handler({ summary: 'Pre-refactor checkpoint' });
    expect(seenBodies[0]?.summary).toBe('Pre-refactor checkpoint');
  });

  test('returns Hocuspocus-unavailable error when no serverUrl is configured', async () => {
    const { server, getTool } = createFakeServer();
    register(server, makeDeps(undefined, tmpDir));
    const result = await getTool().handler({});
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain(HOCUSPOCUS_NOT_RUNNING_ERROR);
  });
});
