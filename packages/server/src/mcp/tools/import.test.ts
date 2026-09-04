import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { type Config, ConfigSchema } from '../../config/schema.ts';
import { register as registerImport } from './import.ts';
import type { ServerInstance } from './shared.ts';

const BASE_CONFIG: Config = ConfigSchema.parse({});

interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: true;
}
type Handler = (args: Record<string, unknown>) => Promise<ToolResult>;

function captureImport(serverUrl: string | undefined): Handler {
  let handler: Handler | undefined;
  const server = {
    registerTool(_name: string, _cfg: unknown, h: Handler) {
      handler = h;
    },
  } as unknown as ServerInstance;
  registerImport(server, {
    serverUrl,
    config: BASE_CONFIG,
    resolveCwd: async () => process.cwd(),
  });
  if (!handler) throw new Error('tool did not register');
  return handler;
}

const text = (r: ToolResult) => r.content.map((c) => c.text).join('\n');

let originalFetch: typeof fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('import MCP tool', () => {
  test('forwards marketplace row source + skill to /api/skill/import unchanged', async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      return new Response(
        JSON.stringify({
          ok: true,
          name: 'review-bot',
          path: 'review-bot/SKILL.md',
          alreadyImported: false,
          warnings: [],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as unknown as typeof fetch;

    const handler = captureImport('http://localhost:4321');
    const r = await handler({
      source: 'acme/skills',
      skill: 'review-bot',
      scope: 'project',
      summary: 'Import review bot',
      add: ['claude'],
    });

    expect(r.isError).toBeUndefined();
    expect(calls).toEqual([
      {
        url: 'http://localhost:4321/api/skill/import',
        body: {
          source: 'acme/skills',
          skill: 'review-bot',
          scope: 'project',
          summary: 'Import review bot',
          install: false,
        },
      },
      {
        url: 'http://localhost:4321/api/skill/install',
        body: {
          scope: 'project',
          name: 'review-bot',
          add: ['claude'],
          summary: 'Import review bot',
        },
      },
    ]);
    expect(text(r)).toContain('Imported "review-bot"');
    expect(text(r)).toContain('Use `install`');
    expect(r.structuredContent?.name).toBe('review-bot');
    expect(r.structuredContent?.path).toBe('review-bot/SKILL.md');
    expect(r.structuredContent?.alreadyImported).toBe(false);
  });

  test('forwards explicit skills.sh URLs unchanged for server-side resolution', async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      return new Response(
        JSON.stringify({
          ok: true,
          name: 'review-bot',
          path: 'review-bot/SKILL.md',
          alreadyImported: true,
          warnings: [],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as unknown as typeof fetch;

    const handler = captureImport('http://localhost:4321');
    const r = await handler({
      source: 'https://www.skills.sh/acme/skills/review-bot',
      add: ['agents'],
    });

    expect(r.isError).toBeUndefined();
    expect(calls).toEqual([
      {
        url: 'http://localhost:4321/api/skill/import',
        body: {
          source: 'https://www.skills.sh/acme/skills/review-bot',
          install: false,
          marketplace: true,
        },
      },
      {
        url: 'http://localhost:4321/api/skill/install',
        body: { name: 'review-bot', add: ['agents'] },
      },
    ]);
    expect(text(r)).toContain('already imported');
    expect(r.structuredContent?.alreadyImported).toBe(true);
  });

  test('a partially-refused placement surfaces its warnings, not just the acquire half', async () => {
    globalThis.fetch = vi.fn(async (url: string | URL | Request) =>
      String(url).endsWith('/api/skill/import')
        ? new Response(
            JSON.stringify({ ok: true, name: 'review-bot', warnings: ['skipped an odd file'] }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          )
        : new Response(
            JSON.stringify({
              ok: true,
              warnings: ['The copy at .cursor/skills/review-bot has been hand-edited — refused.'],
              warningCodes: ['place-fork-refused'],
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
    ) as unknown as typeof fetch;

    const handler = captureImport('http://localhost:4321');
    const r = await handler({ source: 'acme/skills', add: ['agents', 'cursor'] });

    expect(r.isError).toBeUndefined();
    expect(text(r)).toContain('hand-edited');
    expect(r.structuredContent?.warnings).toEqual([
      'skipped an odd file',
      'The copy at .cursor/skills/review-bot has been hand-edited — refused.',
    ]);
    expect(r.structuredContent?.warningCodes).toEqual(['place-fork-refused']);
  });

  test('a failed placement is reported, not swallowed as a clean import', async () => {
    globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
      const ok = String(url).endsWith('/api/skill/import');
      return new Response(
        JSON.stringify(
          ok
            ? { ok: true, name: 'review-bot', path: 'review-bot/SKILL.md', warnings: [] }
            : { title: 'That location has no skills folder.' },
        ),
        { status: ok ? 200 : 400, headers: { 'content-type': 'application/json' } },
      );
    }) as unknown as typeof fetch;

    const handler = captureImport('http://localhost:4321');
    const r = await handler({ source: 'acme/skills', add: ['claude'] });

    expect(r.isError).toBe(true);
    expect(text(r)).toContain('Imported "review-bot"');
    expect(text(r)).toContain('placing it failed');
  });
});
