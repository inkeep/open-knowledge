/**
 * MCP write-path tools: `summary` Zod param + pass-through to the HTTP body +
 * structured-response surfacing, plus the move/restore_version identity passthrough
 * that lets the server-side attribution guard fire for MCP-driven calls.
 *
 * Covers the write-like tools: write, edit, move (description sentinel only —
 * the real filesystem-probe roundtrip lives in mcp-move-real-roundtrip), and
 * restore_version.
 */
import {
  describe as _bunDescribe,
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from 'bun:test';

// Skip-on-CI gate (oven-sh/bun#11892): simple-git fixture pattern in MCP
// test setup spawns git children that Bun fails to reap on ubuntu-latest
// GHA runners; post-test cgroup never drains, hanging test at the 15-min
// timeout. Tests run normally locally.
const describe = process.env.CI ? _bunDescribe.skip : _bunDescribe;

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import type { z } from 'zod';
import { type Config, ConfigSchema } from '../../config/schema.ts';
import type { AgentIdentity } from '../agent-identity.ts';
import { register as registerEdit } from './edit.ts';
import { register as registerMove } from './move.ts';
import { register as registerRestoreVersion } from './restore-version.ts';
import type { ServerInstance } from './shared.ts';
import { register as registerWrite } from './write.ts';

const BASE_CONFIG: Config = ConfigSchema.parse({});

interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: true;
}

type Handler = (args: Record<string, unknown>) => Promise<ToolResult>;

function createCaptureServer() {
  const tools: Array<{
    name: string;
    description: string;
    schema: Record<string, z.ZodType>;
    handler: Handler;
  }> = [];
  const server = {
    registerTool(
      name: string,
      config: { description?: string; inputSchema?: Record<string, z.ZodType> },
      handler: Handler,
    ) {
      tools.push({
        name,
        description: config.description ?? '',
        schema: config.inputSchema ?? {},
        handler,
      });
    },
  } as unknown as ServerInstance;
  return {
    server,
    getTool(name: string): {
      name: string;
      description: string;
      schema: Record<string, z.ZodType>;
      handler: Handler;
    } {
      const t = tools.find((x) => x.name === name);
      if (!t) throw new Error(`Tool ${name} not registered`);
      return t;
    },
  };
}

let recordedRequest: { url: string; body: Record<string, unknown> } | undefined;
let mockResponse: Record<string, unknown> = { ok: true };

let testServer: ReturnType<typeof Bun.serve>;
let baseUrl: string;
let tmpDir: string;

beforeAll(() => {
  testServer = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      const url = new URL(req.url);
      if (req.method === 'GET') {
        return Response.json({
          ok: true,
          author: 'Claude',
          timestamp: '2026-04-21T00:00:00.000Z',
        });
      }
      const body = (await req.json()) as Record<string, unknown>;
      recordedRequest = { url: url.pathname, body };
      return Response.json({
        ok: true,
        timestamp: '2026-04-21T00:00:00.000Z',
        subscriberCount: 1,
        renamed: [{ fromDocName: 'old', toDocName: 'new' }],
        renamedAssets: [],
        rewrittenDocs: [],
        ...mockResponse,
      });
    },
  });
  baseUrl = `http://127.0.0.1:${testServer.port}`;
});

afterAll(() => {
  testServer.stop();
});

beforeEach(async () => {
  tmpDir = await mkdtemp(resolve(tmpdir(), 'ok-summary-passthrough-'));
  recordedRequest = undefined;
  mockResponse = {};
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

const TEST_IDENTITY: AgentIdentity = {
  connectionId: 'claude-1',
  displayName: 'Claude',
  colorSeed: 'test-seed',
  clientInfo: { name: 'claude-code', version: '1.0.0' },
};

function baseDeps() {
  return {
    serverUrl: baseUrl,
    config: BASE_CONFIG,
    resolveCwd: async () => tmpDir,
  };
}

describe('summary + identityRef passthrough across MCP write-path tools', () => {
  describe('write', () => {
    test('summary is forwarded in the HTTP body when present', async () => {
      const cap = createCaptureServer();
      registerWrite(cap.server, { ...baseDeps(), identityRef: { current: TEST_IDENTITY } });
      await cap.getTool('write').handler({
        document: { path: 'foo', content: '# hi', position: 'append' },
        summary: 'Fixed typo',
      });
      expect(recordedRequest?.body.summary).toBe('Fixed typo');
      expect(recordedRequest?.body.agentId).toBe('claude-1');
    });

    test('summary omitted from body when arg is undefined', async () => {
      const cap = createCaptureServer();
      registerWrite(cap.server, baseDeps());
      await cap.getTool('write').handler({
        document: { path: 'foo', content: '# hi', position: 'append' },
      });
      expect(recordedRequest?.body).not.toHaveProperty('summary');
    });

    test('server response summary (with nested hint) surfaces in structuredContent; hint in text', async () => {
      mockResponse = {
        summary: {
          value: 'fixed',
          truncatedFrom: 200,
          hint: 'Summary truncated from 200 chars to 80 (max 80).',
        },
      };
      const cap = createCaptureServer();
      registerWrite(cap.server, baseDeps());
      const result = await cap.getTool('write').handler({
        document: { path: 'foo', content: '# hi', position: 'append' },
        summary: 'x'.repeat(200),
      });
      // write nests the single-doc result under the `document` target key.
      expect(
        (result.structuredContent?.document as { summary?: unknown } | undefined)?.summary,
      ).toEqual({
        value: 'fixed',
        truncatedFrom: 200,
        hint: 'Summary truncated from 200 chars to 80 (max 80).',
      });
      expect(result.content[0]?.text).toContain('Summary truncated from 200 chars to 80');
    });

    test('Zod schema: summary 200 chars accepted, 201 chars rejected, non-string rejected', () => {
      const cap = createCaptureServer();
      registerWrite(cap.server, baseDeps());
      const summarySchema = cap.getTool('write').schema.summary;
      if (!summarySchema) throw new Error('summary schema missing from write');

      expect(summarySchema.safeParse('x'.repeat(200)).success).toBe(true);
      expect(summarySchema.safeParse('short').success).toBe(true);
      expect(summarySchema.safeParse(undefined).success).toBe(true);

      const over = summarySchema.safeParse('x'.repeat(201));
      expect(over.success).toBe(false);
      if (!over.success) {
        expect(over.error.issues[0]?.code).toBe('too_big');
      }

      expect(summarySchema.safeParse(42).success).toBe(false);
      expect(summarySchema.safeParse({ text: 'hi' }).success).toBe(false);
      expect(summarySchema.safeParse(['hi']).success).toBe(false);
    });

    test('200-char summary passes through to HTTP body unchanged (server-side truncation, not MCP)', async () => {
      const cap = createCaptureServer();
      registerWrite(cap.server, baseDeps());
      const input = 'x'.repeat(200);
      const result = await cap.getTool('write').handler({
        document: { path: 'foo', content: 'hi', position: 'append' },
        summary: input,
      });
      expect(recordedRequest?.body.summary).toBe(input);
      expect(result.isError).toBeUndefined();
    });
  });

  describe('edit', () => {
    test('summary + identityRef flow through to /api/agent-patch', async () => {
      const cap = createCaptureServer();
      registerEdit(cap.server, { ...baseDeps(), identityRef: { current: TEST_IDENTITY } });
      await cap.getTool('edit').handler({
        document: { path: 'foo', find: 'old', replace: 'new' },
        summary: 'Renamed constant',
      });
      expect(recordedRequest?.url).toBe('/api/agent-patch');
      expect(recordedRequest?.body.summary).toBe('Renamed constant');
      expect(recordedRequest?.body.agentId).toBe('claude-1');
    });
  });

  // The merged `move` tool's identity + summary passthrough is exercised
  // end-to-end (including filesystem-probe dispatch) by
  // mcp-move-real-roundtrip. Only the description-level sentinel is pinned
  // here as a cross-cutting guard.
  describe('move — description sentinel', () => {
    test('description mentions the default substitution sentence', () => {
      const cap = createCaptureServer();
      registerMove(cap.server, baseDeps());
      const desc = cap.getTool('move').description;
      expect(desc).toContain('If omitted');
      expect(desc).toContain('Renamed X → Y');
    });
  });

  describe('restore_version — identity passthrough', () => {
    test('identityRef when present puts agentId in the /api/rollback body', async () => {
      const cap = createCaptureServer();
      registerRestoreVersion(cap.server, {
        ...baseDeps(),
        identityRef: { current: TEST_IDENTITY },
      });
      await cap.getTool('restore_version').handler({
        document: 'foo',
        version: 'a'.repeat(40),
      });
      expect(recordedRequest?.url).toBe('/api/rollback');
      expect(recordedRequest?.body.agentId).toBe('claude-1');
    });

    test('no identityRef → body omits agentId (UI-style anonymous call)', async () => {
      const cap = createCaptureServer();
      registerRestoreVersion(cap.server, baseDeps());
      await cap.getTool('restore_version').handler({
        document: 'foo',
        version: 'a'.repeat(40),
      });
      expect(recordedRequest?.body).not.toHaveProperty('agentId');
    });

    test('summary is forwarded when provided', async () => {
      const cap = createCaptureServer();
      registerRestoreVersion(cap.server, {
        ...baseDeps(),
        identityRef: { current: TEST_IDENTITY },
      });
      await cap.getTool('restore_version').handler({
        document: 'foo',
        version: 'a'.repeat(40),
        summary: 'Reverted risky refactor',
      });
      expect(recordedRequest?.body.summary).toBe('Reverted risky refactor');
    });
  });

  describe('No-PII reminder in the write-path tool descriptions', () => {
    test('write description mentions no secrets/PII', () => {
      const cap = createCaptureServer();
      registerWrite(cap.server, baseDeps());
      expect(cap.getTool('write').description).toContain('secrets or PII');
    });
    test('edit description mentions no secrets/PII', () => {
      const cap = createCaptureServer();
      registerEdit(cap.server, baseDeps());
      expect(cap.getTool('edit').description).toContain('secrets or PII');
    });
    test('move description mentions no secrets/PII', () => {
      const cap = createCaptureServer();
      registerMove(cap.server, baseDeps());
      expect(cap.getTool('move').description).toContain('secrets or PII');
    });
    test('restore_version description mentions no secrets/PII', () => {
      const cap = createCaptureServer();
      registerRestoreVersion(cap.server, baseDeps());
      expect(cap.getTool('restore_version').description).toContain('secrets or PII');
    });
  });
});
