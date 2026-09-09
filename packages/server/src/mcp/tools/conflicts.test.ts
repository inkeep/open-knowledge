import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeObjectSchema } from '@modelcontextprotocol/sdk/server/zod-compat.js';
import { toJsonSchemaCompat } from '@modelcontextprotocol/sdk/server/zod-json-schema-compat.js';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { type Config, ConfigSchema } from '../../config/schema.ts';
import { register } from './conflicts.ts';
import { type FetchTestServer, startFetchTestServer } from './fetch-test-server.test-helper.ts';
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
    registerTool(_n: string, config: { outputSchema: unknown }, h: Handler) {
      const normalized = normalizeObjectSchema(config.outputSchema);
      if (!normalized) throw new Error('missing output schema');
      const schema = toJsonSchemaCompat(normalized, { strictUnions: true, pipeStrategy: 'output' });
      expect(JSON.stringify(schema)).toContain('stale-external-write');
      expect(JSON.stringify(schema)).toContain('working-tree');
      const validateAgainstAdvertisedSchema = new AjvJsonSchemaValidator().getValidator(schema);
      handler = async (args) => {
        const result = await h(args);
        if (result.structuredContent) {
          expect(validateAgainstAdvertisedSchema(result.structuredContent).valid).toBe(true);
          if (args.kind === 'content') {
            expect(
              validateAgainstAdvertisedSchema({
                ...result.structuredContent,
                content: {
                  ...(result.structuredContent.content as Record<string, unknown>),
                  conflictKind: 'unknown',
                },
              }).valid,
            ).toBe(false);
          } else {
            expect(
              validateAgainstAdvertisedSchema({
                ...result.structuredContent,
                list: [{ file: 'a.md', detectedAt: 'now', conflictKind: 'unknown' }],
              }).valid,
            ).toBe(false);
          }
        }
        return result;
      };
    },
  } as unknown as ServerInstance;
  register(server, { serverUrl, config: BASE_CONFIG, resolveCwd: async () => cwd });
  if (!handler) throw new Error('not registered');
  return handler;
}

let testServer: FetchTestServer;
let baseUrl: string;
const cwd = mkdtempSync(join(tmpdir(), 'ok-conflicts-test-'));

beforeAll(async () => {
  testServer = await startFetchTestServer({
    port: 0,
    hostname: '127.0.0.1',
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === '/api/sync/conflicts') {
        return Response.json({
          ok: true,
          conflicts: [
            { file: 'notes/sso.md', detectedAt: 'now', conflictKind: 'stale-external-write' },
            { file: 'overlay.md', detectedAt: 'now', conflictKind: 'git', variant: 'working-tree' },
          ],
        });
      }
      if (url.pathname === '/api/sync/conflict-content') {
        return Response.json({
          ok: true,
          file: 'notes/sso.md',
          base: 'B',
          ours: 'O',
          theirs: 'T',
          kind: 'both-modified',
          conflictKind: 'stale-external-write',
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
    expect(result.structuredContent?.list).toMatchObject([
      { conflictKind: 'stale-external-write' },
      { conflictKind: 'git', variant: 'working-tree' },
    ]);
    expect(result.content[0]?.text).toContain('notes/sso.md');
  });

  test('kind:content nests stages under `content` and remaps route `kind` → `shape` (DD4)', async () => {
    const result = await capture(baseUrl, cwd)({ kind: 'content', file: 'notes/sso.md' });
    expect(result.isError).toBeFalsy();
    const content = result.structuredContent?.content as { shape?: string } | undefined;
    expect(content?.shape).toBe('both-modified');
    expect(content).toHaveProperty('conflictKind', 'stale-external-write');
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
