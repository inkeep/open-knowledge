import {
  describe as _bunDescribe,
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from 'bun:test';
import { bindTestUiLock } from './preview-url-test-helpers.ts';

// Skip-on-CI gate (oven-sh/bun#11892): simple-git fixture pattern in MCP
// test setup spawns git children that Bun fails to reap on ubuntu-latest
// GHA runners; post-test cgroup never drains, hanging test (test) at the
// 15-min timeout. Tests run normally locally; follow-up PR will migrate
// fixtures to execFileSync.
const describe = process.env.CI ? _bunDescribe.skip : _bunDescribe;

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { type Config, ConfigSchema } from '../../config/schema.ts';
import { type GetHistoryDeps, register } from './history.ts';
import type { ServerInstance } from './shared.ts';

const BASE_CONFIG: Config = ConfigSchema.parse({});

interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: true;
}

interface RegisteredTool {
  handler: (args: { document: string }) => Promise<ToolResult>;
}

function createFakeServer() {
  let captured: RegisteredTool | undefined;
  const server = {
    registerTool(_name: string, _config: unknown, handler: RegisteredTool['handler']) {
      captured = { handler };
    },
  } as unknown as ServerInstance;
  return {
    server,
    getTool(): RegisteredTool {
      if (!captured) throw new Error('Tool was not registered');
      return captured;
    },
  };
}

let testServer: ReturnType<typeof Bun.serve>;
let baseUrl: string;

beforeAll(() => {
  testServer = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === '/api/history') {
        // Route shape: per-entry `sha` + `type` (the tool projects these to
        // `version` + `kind`).
        return Response.json({
          ok: true,
          entries: [
            {
              sha: 'abc',
              timestamp: '2026-04-01T00:00:00Z',
              author: 'Tim',
              authorEmail: 'tim@example.com',
              type: 'checkpoint',
              message: 'init',
              contributors: [],
              checkpoint: null,
            },
          ],
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

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(resolve(tmpdir(), 'ok-get-history-'));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

function makeDeps(): GetHistoryDeps {
  return {
    serverUrl: baseUrl,
    config: BASE_CONFIG,
    resolveCwd: async () => tmpDir,
  };
}

describe('history — previewUrl emission', () => {
  test('emits route-only previewUrl + source alongside entries when resolver resolves', async () => {
    // Bind the UI lock so the route resolves; `previewUrl` is route-only
    // and carries no host:port.
    bindTestUiLock(tmpDir);
    const { server, getTool } = createFakeServer();
    register(server, makeDeps());

    const result = await getTool().handler({ document: 'notes' });

    expect(result.structuredContent).toMatchObject({
      entries: [{ version: 'abc', kind: 'checkpoint', author: 'Tim' }],
      previewUrl: '/#/notes',
      previewUrlSource: 'lock',
    });
  });

  test('emits previewUrl null when resolver returns null', async () => {
    const { server, getTool } = createFakeServer();
    register(server, makeDeps());

    const result = await getTool().handler({ document: 'notes' });

    expect(result.structuredContent).toMatchObject({
      entries: [{ version: 'abc', kind: 'checkpoint' }],
      previewUrl: null,
    });
  });
});
