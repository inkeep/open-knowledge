import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Config, ConfigSchema } from '../../config/schema.ts';
import { register } from './conflicts.ts';
import type { ServerInstance } from './shared.ts';
import { HOCUSPOCUS_NOT_RUNNING_ERROR } from './shared.ts';

const BASE_CONFIG: Config = ConfigSchema.parse({});

interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}
type Handler = (args: {
  kind: 'list' | 'content';
  file?: string;
  cwd?: string;
}) => Promise<ToolResult>;

function capture(serverUrl: string | undefined, cwd: string): Handler {
  let handler: Handler | undefined;
  const server = {
    registerTool(_n: string, _c: unknown, h: Handler) {
      handler = h;
    },
  } as unknown as ServerInstance;
  register(server, { serverUrl, config: BASE_CONFIG, resolveCwd: async () => cwd });
  if (!handler) throw new Error('not registered');
  return handler;
}

let testServer: ReturnType<typeof Bun.serve>;
let baseUrl: string;
const cwd = mkdtempSync(join(tmpdir(), 'ok-conflicts-test-'));

beforeAll(() => {
  testServer = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === '/api/sync/conflicts') {
        return Response.json({
          ok: true,
          conflicts: [{ file: 'notes/sso.md', detectedAt: 'now' }],
        });
      }
      if (url.pathname === '/api/sync/conflict-content') {
        // The route emits the conflict shape as `kind` (the tool remaps → `shape`).
        return Response.json({
          ok: true,
          file: 'notes/sso.md',
          base: 'B',
          ours: 'O',
          theirs: 'T',
          kind: 'both-modified',
          lifecycleStatus: 'conflict',
        });
      }
      return new Response('Not found', { status: 404 });
    },
  });
  baseUrl = `http://127.0.0.1:${testServer.port}`;
});
afterAll(() => testServer.stop());

describe('conflicts — kind discriminator', () => {
  test('kind:list enumerates tracked conflicts (nested under `list`)', async () => {
    const result = await capture(baseUrl, cwd)({ kind: 'list' });
    expect(result.isError).toBeFalsy();
    expect(Array.isArray(result.structuredContent?.list)).toBe(true);
    expect(result.content[0]?.text).toContain('notes/sso.md');
  });

  test('kind:content nests stages under `content` and remaps route `kind` → `shape` (DD4)', async () => {
    const result = await capture(baseUrl, cwd)({ kind: 'content', file: 'notes/sso.md' });
    expect(result.isError).toBeFalsy();
    const content = result.structuredContent?.content as { shape?: string } | undefined;
    expect(content?.shape).toBe('both-modified');
    expect(content).not.toHaveProperty('kind');
    expect(result.content[0]?.text).toContain('shape: both-modified');
  });

  test('kind:content without `file` returns a teaching error', async () => {
    const result = await capture(baseUrl, cwd)({ kind: 'content' });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('requires `file`');
  });

  test('Hocuspocus-unavailable error when no serverUrl', async () => {
    const result = await capture(undefined, cwd)({ kind: 'list' });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain(HOCUSPOCUS_NOT_RUNNING_ERROR);
  });
});
