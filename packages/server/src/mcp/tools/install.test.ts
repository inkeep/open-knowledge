import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { type Config, ConfigSchema } from '../../config/schema.ts';
import { register as registerInstall } from './install.ts';
import type { ServerInstance } from './shared.ts';

const BASE_CONFIG: Config = ConfigSchema.parse({});

interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: true;
}
type Handler = (args: Record<string, unknown>) => Promise<ToolResult>;

function captureInstall(serverUrl: string): Handler {
  let handler: Handler | undefined;
  const server = {
    registerTool(_name: string, _cfg: unknown, h: Handler) {
      handler = h;
    },
  } as unknown as ServerInstance;
  registerInstall(server, {
    serverUrl,
    config: BASE_CONFIG,
    resolveCwd: async () => process.cwd(),
  });
  if (!handler) throw new Error('tool did not register');
  return handler;
}

function registeredInstallInputSchema(): Record<
  string,
  { safeParse: (v: unknown) => { success: boolean } }
> {
  let cfg: { inputSchema?: unknown } | undefined;
  const server = {
    registerTool(_name: string, c: { inputSchema?: unknown }, _h: Handler) {
      cfg = c;
    },
  } as unknown as ServerInstance;
  registerInstall(server, {
    serverUrl: 'http://localhost:1234',
    config: BASE_CONFIG,
    resolveCwd: async () => process.cwd(),
  });
  const schema = cfg?.inputSchema as
    | Record<string, { safeParse: (v: unknown) => { success: boolean } }>
    | undefined;
  if (!schema) throw new Error('tool registered no inputSchema');
  return schema;
}

const text = (r: ToolResult) => r.content.map((c) => c.text).join('\n');

let originalFetch: typeof fetch;
let calls: Array<{ url: string; body: Record<string, unknown> }>;

function stubOk(payload: Record<string, unknown> = {}) {
  globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return new Response(JSON.stringify({ ok: true, hosts: ['claude'], ...payload }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  originalFetch = globalThis.fetch;
  calls = [];
});
afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('install MCP tool', () => {
  test('`mode` shapes ONLY the added locations, via per-location convert', async () => {
    stubOk();
    const r = await captureInstall('http://localhost:4321')({
      name: 'trip-log',
      add: ['cursor'],
      mode: 'copy',
    });

    expect(r.isError).toBeUndefined();
    expect(calls.map((c) => c.body)).toEqual([
      { name: 'trip-log', add: ['cursor'] },
      { name: 'trip-log', convert: { target: 'cursor', mode: 'copy' } },
    ]);
    expect(calls[0]?.body).not.toHaveProperty('mode');
  });

  test('every added location is shaped, not just the first', async () => {
    stubOk();
    await captureInstall('http://localhost:4321')({
      name: 'trip-log',
      add: ['cursor', 'codex'],
      mode: 'link',
    });
    expect(calls.map((c) => c.body.convert)).toEqual([
      undefined,
      { target: 'cursor', mode: 'link' },
      { target: 'codex', mode: 'link' },
    ]);
  });

  test('without `mode`, membership is the only request', async () => {
    stubOk();
    await captureInstall('http://localhost:4321')({ name: 'trip-log', add: ['cursor'] });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.body).toEqual({ name: 'trip-log', add: ['cursor'] });
  });

  test('`convert` without `mode` is refused before any request', async () => {
    stubOk();
    const r = await captureInstall('http://localhost:4321')({
      name: 'trip-log',
      convert: ['claude'],
    });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('`convert` needs `mode`');
    expect(calls).toHaveLength(0);
  });

  test('a failed shaping reports what already landed', async () => {
    globalThis.fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      calls.push({ url: String(_url), body });
      return body.convert
        ? new Response(
            JSON.stringify({
              type: 'urn:ok:error:doc-already-exists',
              title: 'That copy was hand-edited.',
              detail: 'Remove .cursor/skills/trip-log manually if you mean it.',
            }),
            {
              status: 409,
              headers: { 'content-type': 'application/json' },
            },
          )
        : new Response(JSON.stringify({ ok: true, hosts: ['claude', 'cursor'] }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
    }) as unknown as typeof fetch;

    const r = await captureInstall('http://localhost:4321')({
      name: 'trip-log',
      add: ['cursor'],
      mode: 'copy',
    });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('Added cursor');
    expect(text(r)).toContain('hand-edited');
    expect(text(r)).toContain('Remove .cursor/skills/trip-log manually');
  });
});

describe('skillFolders — folder topology, moved off the read-only `config` tool', () => {
  test('routes an add-root verb to the folder endpoint, without a skill name', async () => {
    stubOk({ folder: { moved: [], dropped: [], linked: ['.team/skills'] } });
    const install = captureInstall('http://localhost:1234');

    const res = await install({ skillFolders: { action: 'add-root', root: '.team/skills' } });

    expect(res.isError).toBeUndefined();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toContain('/api/skill-targets');
    expect(calls[0]?.body).toEqual({
      folderAction: { action: 'add-root', root: '.team/skills' },
    });
    expect(res.structuredContent?.folder).toEqual({
      moved: [],
      dropped: [],
      linked: ['.team/skills'],
    });
  });

  test('forwards root AND target for a link verb', async () => {
    stubOk({ folder: { moved: ['a', 'b'], dropped: ['c'], linked: ['.cursor/skills'] } });
    const install = captureInstall('http://localhost:1234');

    const res = await install({
      skillFolders: { action: 'link', root: '.cursor/skills', target: '.agents/skills' },
    });

    expect(res.isError).toBeUndefined();
    expect(calls[0]?.body).toEqual({
      folderAction: { action: 'link', root: '.cursor/skills', target: '.agents/skills' },
    });
    expect(text(res)).toContain('moved 2 skill(s)');
    expect(text(res)).toContain('dropped 1 duplicate(s)');
  });

  test('the registered skillFolders schema refuses a link carrying preview', () => {
    const schema = registeredInstallInputSchema().skillFolders;
    const link = { action: 'link', scope: 'project', root: '.cursor/skills', target: '.a/skills' };

    expect(schema.safeParse(link).success).toBe(true);
    expect(schema.safeParse({ ...link, preview: true }).success).toBe(false);
  });

  test('reports an unlink verb as reversible, not as a removal', async () => {
    stubOk({ folder: { moved: [], dropped: [], linked: [] } });
    const install = captureInstall('http://localhost:1234');

    const res = await install({ skillFolders: { action: 'unlink', root: '.cursor/skills' } });

    expect(res.isError).toBeUndefined();
    expect(calls[0]?.body).toEqual({
      folderAction: { action: 'unlink', root: '.cursor/skills' },
    });
    expect(text(res)).toContain('Unlinked');
    expect(text(res)).toContain('nothing stopped working');
  });

  test('refuses to combine with `name` — it acts on folders, not one skill', async () => {
    stubOk();
    const install = captureInstall('http://localhost:1234');

    const res = await install({
      name: 'grill-me',
      skillFolders: { action: 'unlink', root: '.claude/skills' },
    });

    expect(res.isError).toBe(true);
    expect(text(res)).toContain('do not combine with `name`');
    expect(calls).toHaveLength(0);
  });

  test('still requires a name when no folder verb is given', async () => {
    stubOk();
    const install = captureInstall('http://localhost:1234');

    const res = await install({ add: ['claude'] });

    expect(res.isError).toBe(true);
    expect(text(res)).toContain('`name` is required');
    expect(calls).toHaveLength(0);
  });
});
