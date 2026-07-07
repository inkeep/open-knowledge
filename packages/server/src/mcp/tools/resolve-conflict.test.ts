import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { type Config, ConfigSchema } from '../../config/schema.ts';
import { register } from './resolve-conflict.ts';
import { HOCUSPOCUS_NOT_RUNNING_ERROR, type ServerInstance } from './shared.ts';

interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

interface RegisteredTool {
  name: string;
  config: {
    description?: string;
    annotations?: {
      readOnlyHint?: boolean;
      idempotentHint?: boolean;
      destructiveHint?: boolean;
    };
  };
  handler: (args: Record<string, unknown>) => Promise<ToolResult>;
}

function createCapturingServer() {
  const registrations: RegisteredTool[] = [];
  const server = {
    registerTool(
      name: string,
      config: RegisteredTool['config'],
      handler: RegisteredTool['handler'],
    ) {
      registrations.push({ name, config, handler });
    },
  } as unknown as ServerInstance;
  return { server, registrations };
}

function getTool(registrations: RegisteredTool[], name: string): RegisteredTool {
  const tool = registrations.find((r) => r.name === name);
  expect(tool).toBeDefined();
  return tool as RegisteredTool;
}

const originalFetch = globalThis.fetch;
let tmpDir: string;
const BASE_CONFIG: Config = ConfigSchema.parse({});

beforeEach(async () => {
  tmpDir = await mkdtemp(resolve(tmpdir(), 'ok-resolve-conflict-'));
});

afterEach(async () => {
  globalThis.fetch = originalFetch;
  await rm(tmpDir, { recursive: true, force: true });
});

function makeDeps(serverUrl: string | undefined) {
  return {
    serverUrl,
    config: BASE_CONFIG,
    resolveCwd: async () => tmpDir,
  };
}

describe('resolve_conflict MCP tool', () => {
  test('declares destructiveHint: true + idempotentHint: false annotations (D11)', () => {
    const { server, registrations } = createCapturingServer();
    register(server, makeDeps('http://localhost:4321'));
    const tool = getTool(registrations, 'resolve_conflict');

    expect(tool.config.annotations).toMatchObject({
      destructiveHint: true,
      idempotentHint: false,
    });
  });

  test('description warns about the D10 best-effort non-atomic contract', () => {
    const { server, registrations } = createCapturingServer();
    register(server, makeDeps('http://localhost:4321'));
    const tool = getTool(registrations, 'resolve_conflict');

    expect(tool.config.description).toContain('conflicts({ kind: "list" })');
    expect(tool.config.description).toContain('best-effort');
    expect(tool.config.description).toContain('non-atomic');
    expect(tool.config.description).toContain('DESTRUCTIVE');
  });

  test('strategy=theirs posts a body without content', async () => {
    const { server, registrations } = createCapturingServer();
    const fetchCalls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
    globalThis.fetch = (async (input, init) => {
      fetchCalls.push({ input, init });
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;

    register(server, makeDeps('http://localhost:4321'));
    const tool = getTool(registrations, 'resolve_conflict');
    const result = await tool.handler({ file: 'notes/a.md', strategy: 'theirs' });

    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]?.input).toBe('http://localhost:4321/api/sync/resolve-conflict');
    expect(JSON.parse(String(fetchCalls[0]?.init?.body))).toEqual({
      file: 'notes/a.md',
      strategy: 'theirs',
    });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({ ok: true, file: 'notes/a.md' });
    expect(result.content[0]?.text).toContain('theirs');
  });

  test('strategy=mine posts a body without content', async () => {
    const { server, registrations } = createCapturingServer();
    const fetchCalls: Array<{ init?: RequestInit }> = [];
    globalThis.fetch = (async (_input, init) => {
      fetchCalls.push({ init });
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;

    register(server, makeDeps('http://localhost:4321'));
    const tool = getTool(registrations, 'resolve_conflict');
    const result = await tool.handler({ file: 'a.md', strategy: 'mine' });

    expect(JSON.parse(String(fetchCalls[0]?.init?.body))).toEqual({
      file: 'a.md',
      strategy: 'mine',
    });
    expect(result.isError).toBeUndefined();
  });

  test('strategy=content forwards the content arg verbatim', async () => {
    const { server, registrations } = createCapturingServer();
    const fetchCalls: Array<{ init?: RequestInit }> = [];
    globalThis.fetch = (async (_input, init) => {
      fetchCalls.push({ init });
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;

    register(server, makeDeps('http://localhost:4321'));
    const tool = getTool(registrations, 'resolve_conflict');
    const result = await tool.handler({
      file: 'a.md',
      strategy: 'content',
      content: 'merged-by-hand',
    });

    expect(JSON.parse(String(fetchCalls[0]?.init?.body))).toEqual({
      file: 'a.md',
      strategy: 'content',
      content: 'merged-by-hand',
    });
    expect(result.isError).toBeUndefined();
  });

  test('commit failure (500) surfaces as structured error to the agent', async () => {
    const { server, registrations } = createCapturingServer();
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          type: 'urn:ok:error:internal-server-error',
          title: 'Failed to resolve conflict.',
          status: 500,
        }),
        { status: 500, headers: { 'Content-Type': 'application/problem+json' } },
      )) as typeof fetch;

    register(server, makeDeps('http://localhost:4321'));
    const tool = getTool(registrations, 'resolve_conflict');
    const result = await tool.handler({ file: 'a.md', strategy: 'theirs' });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('Failed to resolve conflict');
    expect(result.structuredContent).toMatchObject({ ok: false, file: 'a.md' });
  });

  test('uses the shared Hocuspocus-not-running error when no server URL is available', async () => {
    const { server, registrations } = createCapturingServer();
    register(server, makeDeps(undefined));
    const tool = getTool(registrations, 'resolve_conflict');
    const result = await tool.handler({ file: 'a.md', strategy: 'theirs' });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toBe(HOCUSPOCUS_NOT_RUNNING_ERROR);
  });

  // ─── RED: 'delete' strategy contract ─────────────────────────────────────
  // Pins the MCP tool's input schema accepting `strategy: 'delete'`. Today
  // the enum at resolve-conflict.ts is `['mine', 'theirs', 'content']`
  // and the handler's args type union mirrors it — neither admits
  // 'delete'. The fix must thread the new variant through the wire enum,
  // input schema, handler type, and (server-side) ResolveStrategy.
  test('strategy=delete posts a body without content (DU "stay deleted" / UD "accept deletion")', async () => {
    const { server, registrations } = createCapturingServer();
    const fetchCalls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
    globalThis.fetch = (async (input, init) => {
      fetchCalls.push({ input, init });
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;

    register(server, makeDeps('http://localhost:4321'));
    const tool = getTool(registrations, 'resolve_conflict');
    // biome-ignore lint/suspicious/noExplicitAny: pinning the new strategy variant pre-fix
    const result = await tool.handler({ file: 'foo.md', strategy: 'delete' as any });

    expect(fetchCalls).toHaveLength(1);
    expect(JSON.parse(String(fetchCalls[0]?.init?.body))).toEqual({
      file: 'foo.md',
      strategy: 'delete',
    });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({ ok: true, file: 'foo.md' });
  });

  test("tool's input schema enum admits 'delete' alongside the existing three strategies", () => {
    const { server, registrations } = createCapturingServer();
    register(server, makeDeps('http://localhost:4321'));
    const tool = getTool(registrations, 'resolve_conflict');
    // Access the registered tool config's inputSchema. The strategy field
    // MUST be a Zod enum that includes 'delete' once the fix lands. Today,
    // .options is ['mine', 'theirs', 'content'].
    const inputSchema = (
      tool.config as unknown as {
        inputSchema?: { strategy?: { options?: readonly string[] } };
      }
    ).inputSchema;
    expect(inputSchema?.strategy?.options).toBeDefined();
    expect(inputSchema?.strategy?.options).toContain('delete');
  });
});
