import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { type Config, ConfigSchema } from '../../config/schema.ts';
import { BUNDLE_SKILL_NAME } from '../../skill-bundles.ts';
import { HOCUSPOCUS_NOT_RUNNING_ERROR, type ServerInstance } from './shared.ts';
import { register as registerSkills, type SkillsToolDeps } from './skills.ts';

const BASE_CONFIG: Config = ConfigSchema.parse({});

interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: true;
}
type Handler = (args: Record<string, unknown>) => Promise<ToolResult>;

let originalFetch: typeof fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function captureSkills(serverUrl: string | undefined): Handler {
  let handler: Handler | undefined;
  const server = {
    registerTool(_name: string, _cfg: unknown, h: Handler) {
      handler = h;
    },
  } as unknown as ServerInstance;
  registerSkills(server, {
    serverUrl,
    config: BASE_CONFIG,
    resolveCwd: async () => process.cwd(),
  } as unknown as SkillsToolDeps);
  if (!handler) throw new Error('tool did not register');
  return handler;
}

const text = (r: ToolResult) => r.content.map((c) => c.text).join('\n');

describe('skills read tool — bundle-file gating short-circuits before the network', () => {
  const UNREACHABLE = 'http://127.0.0.1:1';

  test('`file` without `name` returns the teaching error', async () => {
    const handler = captureSkills(UNREACHABLE);
    const r = await handler({ file: 'references/x.md' });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('pass `name` too');
  });

  test('`file` with an escaping path is rejected by the allowlist', async () => {
    const handler = captureSkills(UNREACHABLE);
    const r = await handler({ name: 'trip-log', file: 'references/../../etc/passwd' });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('..');
  });

  test('an absolute `file` is rejected before any request', async () => {
    const handler = captureSkills(UNREACHABLE);
    const r = await handler({ name: 'trip-log', file: '/etc/passwd' });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('skill-relative');
  });

  test('`file` under another bundle root passes validation and attempts the read', async () => {
    const handler = captureSkills(UNREACHABLE);
    const r = await handler({ name: 'trip-log', file: 'agents/openai.yaml' });
    expect(text(r)).toContain('Server unreachable');
  });
});

describe('skills read tool — server-required', () => {
  test('no server URL returns the not-running error', async () => {
    const handler = captureSkills(undefined);
    const r = await handler({ name: 'trip-log' });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain(HOCUSPOCUS_NOT_RUNNING_ERROR);
  });
});

describe('skills read tool — marketplace search overload', () => {
  test('`query` cannot be combined with managed-skill selectors', async () => {
    const handler = captureSkills(undefined);
    const r = await handler({ query: 'review bot', name: 'trip-log' });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('do not combine');
  });

  test('`query` calls skills search and returns import-ready marketplace rows', async () => {
    const calls: string[] = [];
    globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
      calls.push(String(url));
      return new Response(
        JSON.stringify({
          ok: true,
          results: [
            {
              name: 'review-bot',
              source: 'acme/skills',
              description: 'Review pull requests',
              installs: 42,
              publisher: 'acme',
              ignored: 'not projected',
            },
            { name: 123, source: 'bad-row' },
          ],
          backend: 'skills.sh',
          degraded: false,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as unknown as typeof fetch;

    const handler = captureSkills('http://localhost:4321');
    const r = await handler({ query: 'review bot' });

    expect(r.isError).toBeUndefined();
    expect(calls).toEqual(['http://localhost:4321/api/skills/search?q=review%20bot']);
    expect(r.structuredContent?.results).toEqual([
      {
        name: 'review-bot',
        source: 'acme/skills',
        description: 'Review pull requests',
        installs: 42,
        publisher: 'acme',
      },
    ]);
    expect(r.structuredContent?.backend).toBe('skills.sh');
    expect(r.structuredContent?.degraded).toBe(false);
  });
});

describe('skills read tool — built-in OK skills short-circuit before the network', () => {
  test('READ open-knowledge teaches instead of looking it up', async () => {
    const handler = captureSkills(undefined);
    const r = await handler({ name: 'open-knowledge', scope: 'project' });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('built-in agent skills');
    expect(text(r)).toContain('already provided to you in your loaded skill list');
  });

  test('every shipped bundle name short-circuits (not just open-knowledge)', async () => {
    const handler = captureSkills(undefined);
    for (const name of Object.values(BUNDLE_SKILL_NAME)) {
      const r = await handler({ name });
      expect(r.isError, `isError for "${name}"`).toBe(true);
      expect(text(r), `teaching error for "${name}"`).toContain('NOT managed by this tool');
    }
  });

  test('READ-file on a built-in skill is short-circuited too', async () => {
    const handler = captureSkills(undefined);
    const r = await handler({ name: 'open-knowledge', file: 'references/x.md' });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('built-in agent skills');
  });

  test('a user-authored pack skill is NOT treated as built-in', async () => {
    const handler = captureSkills(undefined);
    const r = await handler({ name: 'open-knowledge-pack-fishing' });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain(HOCUSPOCUS_NOT_RUNNING_ERROR);
  });
});

describe('skills LIST — scope filters, and mode is always answered', () => {
  let originalFetch: typeof fetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function stubList() {
    globalThis.fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            skills: [
              { name: 'proj-a', scope: 'project', installed: true, hosts: ['claude'] },
              {
                name: 'glob-a',
                scope: 'global',
                installed: true,
                hosts: ['claude'],
                linkMode: true,
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    ) as unknown as typeof fetch;
  }

  test('`scope` filters the list instead of being ignored', async () => {
    stubList();
    const r = await captureSkills('http://127.0.0.1:4321')({ scope: 'global' });
    const skills = r.structuredContent?.skills as Array<{ name: string; scope: string }>;
    expect(skills.map((s) => s.name)).toEqual(['glob-a']);
  });

  test('omitting `scope` still lists both levels', async () => {
    stubList();
    const r = await captureSkills('http://127.0.0.1:4321')({});
    const skills = r.structuredContent?.skills as Array<{ name: string }>;
    expect(skills.map((s) => s.name)).toEqual(['proj-a', 'glob-a']);
  });

  test('`mode` is present on every row — a copy-form skill says so', async () => {
    stubList();
    const r = await captureSkills('http://127.0.0.1:4321')({});
    const skills = r.structuredContent?.skills as Array<{ name: string; mode: string }>;
    expect(skills.map((s) => [s.name, s.mode])).toEqual([
      ['proj-a', 'copy'],
      ['glob-a', 'link'],
    ]);
  });

  test('a too-short query is refused, not answered as an empty skills.sh result', async () => {
    const r = await captureSkills('http://127.0.0.1:4321')({ query: 'k' });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('at least 2 characters');
    expect(r.structuredContent?.backend).toBeUndefined();
  });
});
