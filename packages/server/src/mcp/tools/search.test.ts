
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Config, ConfigSchema } from '../../config/schema.ts';
import { bindTestUiLock } from './preview-url-test-helpers.ts';
import { DESCRIPTION, register } from './search.ts';
import type { ServerInstance } from './shared.ts';

const DEFAULT_CONFIG: Config = ConfigSchema.parse({});

interface RegisteredTool {
  name: string;
  options: {
    description: string;
    inputSchema: Record<string, unknown>;
    annotations?: Record<string, unknown>;
  };
  handler: (args: Record<string, unknown>) => Promise<{
    content?: Array<{ type: string; text?: string }>;
    structuredContent?: Record<string, unknown>;
    isError?: boolean;
  }>;
}

function makeFakeServer(): {
  server: ServerInstance;
  registered: RegisteredTool[];
} {
  const registered: RegisteredTool[] = [];
  const server = {
    registerTool: (
      name: string,
      options: RegisteredTool['options'],
      handler: RegisteredTool['handler'],
    ) => {
      registered.push({ name, options, handler });
    },
  } as unknown as ServerInstance;
  return { server, registered };
}

function expectOneRegisteredTool(registered: RegisteredTool[]): RegisteredTool {
  expect(registered).toHaveLength(1);
  const tool = registered[0];
  if (!tool) throw new Error('expected one registered tool');
  return tool;
}

let originalFetch: typeof fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function mockFetchOk(payload: Record<string, unknown>): void {
  globalThis.fetch = mock(async (_url: string, _init?: RequestInit) => {
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
}

function mockFetchProblem(
  status: number,
  payload: { type: string; title: string; detail?: string; instance?: string },
): void {
  globalThis.fetch = mock(async (_url: string, _init?: RequestInit) => {
    return new Response(JSON.stringify({ ...payload, status }), {
      status,
      headers: { 'content-type': 'application/problem+json' },
    });
  }) as unknown as typeof fetch;
}

describe('search MCP tool — registration', () => {
  test('registers under the name "search" with read-only annotations', () => {
    const { server, registered } = makeFakeServer();
    register(server, {
      resolveCwd: async () => '/tmp/proj',
      config: DEFAULT_CONFIG,
      serverUrl: 'http://localhost:1234',
    });
    const tool = expectOneRegisteredTool(registered);
    expect(tool.name).toBe('search');
    expect(tool.options.annotations).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
    });
  });

  test('description sibling-pointer for grep lands in the first 200 characters (FR6)', () => {
    expect(DESCRIPTION.slice(0, 200)).toContain('grep');
  });

  test('description advertises all-files name coverage + the two-tier grep model (PRD-7117 D17)', () => {
    expect(DESCRIPTION).toContain('ALL non-ignored files');
    expect(DESCRIPTION.toLowerCase()).toContain('name/path');
    expect(DESCRIPTION.toLowerCase()).toContain('in parallel');
  });

  test('inputSchema exposes query, intent, scopes, limit, semantic, cwd', () => {
    const { server, registered } = makeFakeServer();
    register(server, {
      resolveCwd: async () => '/tmp/proj',
      config: DEFAULT_CONFIG,
      serverUrl: 'http://localhost:1234',
    });
    const tool = expectOneRegisteredTool(registered);
    expect(Object.keys(tool.options.inputSchema).sort()).toEqual([
      'cwd',
      'intent',
      'limit',
      'query',
      'scopes',
      'semantic',
    ]);
  });
});

describe('search MCP tool — happy path', () => {
  test('forwards query / intent / scopes / limit to POST /api/search and normalizes the response', async () => {
    const captured: { url?: string; init?: RequestInit } = {};
    globalThis.fetch = mock(async (url: string, init?: RequestInit) => {
      captured.url = String(url);
      captured.init = init;
      return new Response(
        JSON.stringify({
          ok: true,
          query: 'agent presence',
          intent: 'full_text',
          results: [
            {
              kind: 'page',
              path: 'specs/agent-presence/SPEC',
              title: 'Agent Presence',
              score: 723.5,
              signals: { lexical: 700, fullText: 1.2, recency: 23.5 },
              snippet: 'agent presence lives on __system__ awareness…',
            },
            {
              kind: 'folder',
              path: 'specs/agent-presence',
              title: 'agent-presence',
              score: 550,
              signals: { lexical: 550, fullText: 0, recency: 0 },
            },
          ],
          elapsedMs: 4.2,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as unknown as typeof fetch;

    const { server, registered } = makeFakeServer();
    register(server, {
      resolveCwd: async () => '/tmp/proj',
      config: DEFAULT_CONFIG,
      serverUrl: 'http://localhost:1234',
    });
    const tool = expectOneRegisteredTool(registered);
    const result = await tool.handler({
      query: 'agent presence',
      intent: 'full_text',
      scopes: ['page', 'content'],
      limit: 5,
      cwd: '/tmp/proj',
    });

    expect(result.isError ?? false).toBe(false);
    expect(captured.url).toBe('http://localhost:1234/api/search');
    expect(captured.init?.method).toBe('POST');
    const body = JSON.parse(String(captured.init?.body)) as Record<string, unknown>;
    expect(body).toEqual({
      query: 'agent presence',
      intent: 'full_text',
      limit: 5,
      scopes: ['page', 'content'],
      semantic: true,
      source: 'mcp',
    });

    const structured = result.structuredContent as {
      query: string;
      intent: string;
      resultCount: number;
      results: Array<{
        kind: string;
        path: string;
        docName: string;
        title: string | null;
        score: number;
        signals: { lexical: number; fullText: number; recency: number };
        snippet?: string;
      }>;
    };
    expect(structured.query).toBe('agent presence');
    expect(structured.intent).toBe('full_text');
    expect(structured.resultCount).toBe(2);
    expect(structured.results[0]?.kind).toBe('page');
    expect(structured.results[0]?.path).toBe('specs/agent-presence/SPEC');
    expect(structured.results[0]?.docName).toBe('specs/agent-presence/SPEC');
    expect(structured.results[0]?.title).toBe('Agent Presence');
    expect(structured.results[0]?.snippet).toContain('agent presence');
    expect(structured.results[0]?.signals).toEqual({
      lexical: 700,
      fullText: 1.2,
      recency: 23.5,
    });
  });

  test("default intent is 'full_text' when caller omits it (D4)", async () => {
    const captured: { body?: string } = {};
    globalThis.fetch = mock(async (_url: string, init?: RequestInit) => {
      captured.body = String(init?.body);
      return new Response(JSON.stringify({ ok: true, results: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    const { server, registered } = makeFakeServer();
    register(server, {
      resolveCwd: async () => '/tmp/proj',
      config: DEFAULT_CONFIG,
      serverUrl: 'http://localhost:1234',
    });
    const tool = expectOneRegisteredTool(registered);
    await tool.handler({ query: 'q', cwd: '/tmp/proj' });
    const body = JSON.parse(String(captured.body)) as Record<string, unknown>;
    expect(body.intent).toBe('full_text');
    expect(body.limit).toBe(20);
  });

  test('semantic:false is forwarded as the per-call lexical override', async () => {
    const captured: { body?: string } = {};
    globalThis.fetch = mock(async (_url: string, init?: RequestInit) => {
      captured.body = String(init?.body);
      return new Response(JSON.stringify({ ok: true, results: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    const { server, registered } = makeFakeServer();
    register(server, {
      resolveCwd: async () => '/tmp/proj',
      config: DEFAULT_CONFIG,
      serverUrl: 'http://localhost:1234',
    });
    const tool = expectOneRegisteredTool(registered);
    await tool.handler({ query: 'q', semantic: false, cwd: '/tmp/proj' });
    const body = JSON.parse(String(captured.body)) as Record<string, unknown>;
    expect(body.semantic).toBe(false);
  });

  test('passes through signals.vector + the non-content semantic coverage block', async () => {
    mockFetchOk({
      ok: true,
      query: 'auth retries',
      intent: 'full_text',
      results: [
        {
          kind: 'page',
          path: 'guides/credential-rotation',
          title: 'Credential Rotation',
          score: 12.3,
          signals: { lexical: 0, fullText: 0, recency: 0, vector: 0.82 },
        },
      ],
      semantic: { capable: true, applied: true, coverage: { embedded: 12, total: 40 } },
      elapsedMs: 5,
    });
    const { server, registered } = makeFakeServer();
    register(server, {
      resolveCwd: async () => '/tmp/proj',
      config: DEFAULT_CONFIG,
      serverUrl: 'http://localhost:1234',
    });
    const tool = expectOneRegisteredTool(registered);
    const result = await tool.handler({ query: 'auth retries', cwd: '/tmp/proj' });
    const structured = result.structuredContent as {
      results: Array<{ signals: { vector?: number } }>;
      semantic?: {
        capable: boolean;
        applied: boolean;
        coverage: { embedded: number; total: number };
      };
    };
    expect(structured.results[0]?.signals.vector).toBeCloseTo(0.82, 5);
    expect(structured.semantic).toEqual({
      capable: true,
      applied: true,
      coverage: { embedded: 12, total: 40 },
    });
    const text = result.content?.find((c) => c.type === 'text')?.text ?? '';
    expect(text).toContain('Semantic:');
    expect(text).toContain('12/40');
  });

  test("kind:'file' rows survive into structured results (PRD-7117 all-files MCP)", async () => {
    mockFetchOk({
      ok: true,
      query: 'data',
      intent: 'full_text',
      results: [
        {
          kind: 'file',
          path: 'data.csv',
          title: 'data.csv',
          score: 200,
          signals: { lexical: 200, fullText: 0, recency: 0 },
        },
      ],
      elapsedMs: 1,
    });
    const { server, registered } = makeFakeServer();
    register(server, {
      resolveCwd: async () => '/tmp/proj',
      config: DEFAULT_CONFIG,
      serverUrl: 'http://localhost:1234',
    });
    const tool = expectOneRegisteredTool(registered);
    const result = await tool.handler({ query: 'data', cwd: '/tmp/proj' });
    const structured = result.structuredContent as {
      resultCount: number;
      results: Array<{ kind: string; path: string }>;
    };
    expect(structured.resultCount).toBe(1);
    expect(structured.results[0]?.kind).toBe('file');
    expect(structured.results[0]?.path).toBe('data.csv');
  });

  test("scopes:['file'] is forwarded to /api/search (Zod accepts 'file')", async () => {
    const captured: { body?: string } = {};
    globalThis.fetch = mock(async (_url: string, init?: RequestInit) => {
      captured.body = String(init?.body);
      return new Response(JSON.stringify({ ok: true, results: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;
    const { server, registered } = makeFakeServer();
    register(server, {
      resolveCwd: async () => '/tmp/proj',
      config: DEFAULT_CONFIG,
      serverUrl: 'http://localhost:1234',
    });
    const tool = expectOneRegisteredTool(registered);
    const result = await tool.handler({ query: 'q', scopes: ['file'], cwd: '/tmp/proj' });
    expect(result.isError ?? false).toBe(false);
    const body = JSON.parse(String(captured.body)) as Record<string, unknown>;
    expect(body.scopes).toEqual(['file']);
  });

  test('zero results returns "No matches" text + structured.resultCount = 0', async () => {
    mockFetchOk({ ok: true, query: 'nope', intent: 'full_text', results: [], elapsedMs: 0.1 });
    const { server, registered } = makeFakeServer();
    register(server, {
      resolveCwd: async () => '/tmp/proj',
      config: DEFAULT_CONFIG,
      serverUrl: 'http://localhost:1234',
    });
    const tool = expectOneRegisteredTool(registered);
    const result = await tool.handler({ query: 'nope', cwd: '/tmp/proj' });
    const text = result.content?.find((c) => c.type === 'text')?.text ?? '';
    expect(text).toContain('No matches');
    const structured = result.structuredContent as { resultCount: number };
    expect(structured.resultCount).toBe(0);
  });
});

describe('search MCP tool — route-only previewUrl + no ui block (PRD-6735)', () => {
  test('result rows carry route-only previewUrl; structured output has no ui block', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'ok-search-preview-'));
    bindTestUiLock(cwd);
    mockFetchOk({
      ok: true,
      query: 'agent presence',
      intent: 'full_text',
      results: [
        {
          kind: 'page',
          path: 'specs/agent-presence/SPEC',
          title: 'Agent Presence',
          score: 700,
          signals: { lexical: 700, fullText: 0, recency: 0 },
        },
      ],
      elapsedMs: 1,
    });
    const { server, registered } = makeFakeServer();
    register(server, {
      resolveCwd: async () => cwd,
      config: DEFAULT_CONFIG,
      serverUrl: 'http://localhost:1234',
    });
    const tool = expectOneRegisteredTool(registered);
    const result = await tool.handler({ query: 'agent presence', cwd });

    const structured = result.structuredContent as {
      ui?: unknown;
      results: Array<{ previewUrl?: string | null }>;
    };
    expect(structured.results[0]?.previewUrl).toBe('/#/specs/agent-presence/SPEC');
    expect(structured.ui).toBeUndefined();
  });
});

describe('search MCP tool — error paths', () => {
  test('server-not-running returns HOCUSPOCUS_NOT_RUNNING_ERROR + grep fallback hint (FR7, AC4)', async () => {
    const { server, registered } = makeFakeServer();
    register(server, {
      resolveCwd: async () => '/tmp/proj',
      config: DEFAULT_CONFIG,
      serverUrl: undefined,
    });
    const tool = expectOneRegisteredTool(registered);
    const result = await tool.handler({ query: 'q', cwd: '/tmp/proj' });
    expect(result.isError).toBe(true);
    const text = result.content?.find((c) => c.type === 'text')?.text ?? '';
    expect(text).toContain('Hocuspocus server is not running');
    expect(text).toContain('ok start');
    expect(text).toContain('grep');
  });

  test('server returns RFC 9457 problem+json → tool reports error', async () => {
    mockFetchProblem(400, {
      type: 'urn:ok:error:invalid-request',
      title: 'Query is too long',
    });
    const { server, registered } = makeFakeServer();
    register(server, {
      resolveCwd: async () => '/tmp/proj',
      config: DEFAULT_CONFIG,
      serverUrl: 'http://localhost:1234',
    });
    const tool = expectOneRegisteredTool(registered);
    const result = await tool.handler({ query: 'q', cwd: '/tmp/proj' });
    expect(result.isError).toBe(true);
    const text = result.content?.find((c) => c.type === 'text')?.text ?? '';
    expect(text).toContain('Query is too long');
  });
});

describe('search MCP tool — cold-start warming', () => {
  test('ready:false surfaces a retry hint (not "No matches") and propagates ready:false', async () => {
    mockFetchOk({ ok: true, query: 'arch', intent: 'full_text', results: [], ready: false });
    const { server, registered } = makeFakeServer();
    register(server, {
      resolveCwd: async () => '/tmp/proj',
      config: DEFAULT_CONFIG,
      serverUrl: 'http://localhost:1234',
    });
    const tool = expectOneRegisteredTool(registered);
    const result = await tool.handler({ query: 'arch', cwd: '/tmp/proj' });

    const text = result.content?.find((c) => c.type === 'text')?.text ?? '';
    expect(text).toContain('still warming');
    expect(text).not.toContain('No matches');
    const structured = result.structuredContent as { ready?: unknown; resultCount: number };
    expect(structured.ready).toBe(false);
    expect(structured.resultCount).toBe(0);
  });

  test('ready:true serves results with no warming text and omits the ready flag', async () => {
    mockFetchOk({ ok: true, query: 'arch', intent: 'full_text', results: [], ready: true });
    const { server, registered } = makeFakeServer();
    register(server, {
      resolveCwd: async () => '/tmp/proj',
      config: DEFAULT_CONFIG,
      serverUrl: 'http://localhost:1234',
    });
    const tool = expectOneRegisteredTool(registered);
    const result = await tool.handler({ query: 'arch', cwd: '/tmp/proj' });

    const text = result.content?.find((c) => c.type === 'text')?.text ?? '';
    expect(text).not.toContain('still warming');
    expect((result.structuredContent as { ready?: unknown }).ready).toBeUndefined();
  });
});
