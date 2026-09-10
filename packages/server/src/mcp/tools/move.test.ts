import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { type Config, ConfigSchema } from '../../config/schema.ts';
import { register as registerMove } from './move.ts';
import type { ServerInstance } from './shared.ts';

const BASE_CONFIG: Config = ConfigSchema.parse({});

interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: true;
}
type Handler = (args: Record<string, unknown>) => Promise<ToolResult>;

function captureMove(serverUrl: string): Handler {
  let handler: Handler | undefined;
  const server = {
    registerTool(_name: string, _cfg: unknown, h: Handler) {
      handler = h;
    },
  } as unknown as ServerInstance;
  registerMove(server, {
    serverUrl,
    config: BASE_CONFIG,
    resolveCwd: async () => process.cwd(),
  });
  if (!handler) throw new Error('tool did not register');
  return handler;
}

let originalFetch: typeof fetch;
let calls: Array<{ path: string; body: Record<string, unknown> }>;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  calls = [];
  globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ path: new URL(String(url)).pathname, body: JSON.parse(String(init?.body)) });
    return new Response(JSON.stringify({ ok: true, committed: true, scope: 'global' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('move MCP tool — skill dispatch', () => {
  test('a differing `toScope` routes distinct names to the canonical scope-move endpoint', async () => {
    const r = await captureMove('http://localhost:4321')({
      skill: { from: 'trip-log', to: 'fishing-log', toScope: 'global' },
    });
    expect(r.isError).toBeUndefined();
    expect(calls).toEqual([
      {
        path: '/api/skill/move-scope',
        body: {
          name: 'trip-log',
          toName: 'fishing-log',
          fromScope: 'project',
          toScope: 'global',
        },
      },
    ]);
  });

  test('an omitted or equal `toScope` is a same-level rename', async () => {
    const handler = captureMove('http://localhost:4321');
    await handler({ skill: { from: 'trip-log', to: 'fishing-log' } });
    await handler({
      skill: { from: 'trip-log', to: 'fishing-log', scope: 'global', toScope: 'global' },
    });
    expect(calls.map((c) => c.path)).toEqual(['/api/skill', '/api/skill']);
    expect(calls[0]?.body).toEqual({ fromName: 'trip-log', toName: 'fishing-log' });
    expect(calls[1]?.body).toEqual({
      scope: 'global',
      fromName: 'trip-log',
      toName: 'fishing-log',
    });
  });

  test('`skill` combined with flat `from`/`to` is refused before any request', async () => {
    const r = await captureMove('http://localhost:4321')({
      from: 'a',
      to: 'b',
      skill: { from: 'trip-log', to: 'trip-log' },
    });
    expect(r.isError).toBe(true);
    expect(r.content[0]?.text).toContain('not both');
    expect(calls).toHaveLength(0);
  });
});
