import {
  describe as _bunDescribe,
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { type Config, ConfigSchema } from '../../config/schema.ts';
import { DESCRIPTION, type LinksDeps, register } from './links.ts';
import { bindTestUiLock } from './preview-url-test-helpers.ts';
import type { ServerInstance } from './shared.ts';
import { HOCUSPOCUS_NOT_RUNNING_ERROR } from './shared.ts';

// Skip-on-CI gate (oven-sh/bun#11892): simple-git fixture pattern in MCP
// test setup spawns git children that Bun fails to reap on ubuntu-latest
// GHA runners; post-test cgroup never drains, hanging test (test) at the
// 15-min timeout. Tests run normally locally; follow-up PR will migrate
// fixtures to execFileSync.
const describe = process.env.CI ? _bunDescribe.skip : _bunDescribe;

const BASE_CONFIG: Config = ConfigSchema.parse({});

interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

type LinkKind = 'backlinks' | 'forward' | 'dead' | 'orphans' | 'hubs' | 'suggest';

interface LinksHandlerArgs {
  kind: LinkKind | LinkKind[];
  document?: string;
  sourceDocuments?: string[];
  mode?: 'incoming' | 'outgoing' | 'both';
  limit?: number;
}

interface RegisteredTool {
  name: string;
  description: string;
  schema: Record<string, unknown>;
  handler: (args: LinksHandlerArgs) => Promise<ToolResult>;
}

function createFakeServer() {
  let registered: RegisteredTool | undefined;
  const server = {
    registerTool(
      name: string,
      cfg: { description?: string; inputSchema?: Record<string, unknown> },
      handler: (args: LinksHandlerArgs) => Promise<ToolResult>,
    ) {
      registered = {
        name,
        description: cfg.description ?? '',
        schema: cfg.inputSchema ?? {},
        handler,
      };
    },
  } as unknown as ServerInstance;
  return {
    server,
    getTool(): RegisteredTool {
      if (!registered) throw new Error('Tool was not registered');
      return registered;
    },
  };
}

function makeDeps(serverUrl: string | undefined, cwdDir: string): LinksDeps {
  return {
    serverUrl,
    config: BASE_CONFIG,
    resolveCwd: async () => cwdDir,
  };
}

let testServer: ReturnType<typeof Bun.serve>;
let baseUrl: string;
let tmpDir: string;
const seenRequests: string[] = [];

beforeAll(() => {
  testServer = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(req) {
      const url = new URL(req.url);
      seenRequests.push(`${url.pathname}?${url.searchParams.toString()}`);
      switch (url.pathname) {
        case '/api/backlinks':
          return Response.json({
            ok: true,
            docName: url.searchParams.get('docName'),
            backlinks: [
              { source: 'alpha', anchor: null, title: 'Alpha', snippet: 'links to target' },
              { source: 'beta', anchor: 'section-1', title: 'Beta', snippet: 'see target' },
            ],
          });
        case '/api/forward-links':
          return Response.json({
            ok: true,
            docName: url.searchParams.get('docName'),
            forwardLinks: [
              { kind: 'doc', docName: 'alpha', anchor: null, title: 'Alpha', snippet: '-' },
              { kind: 'external', url: 'https://example.com', title: 'ext', snippet: '-' },
            ],
          });
        case '/api/dead-links':
          return Response.json({
            ok: true,
            deadLinks: [
              {
                target: 'missing-target',
                sources: [{ source: 'alpha', title: 'Alpha', snippet: 's' }],
              },
            ],
          });
        case '/api/orphans':
          return Response.json({
            ok: true,
            receivedMode: url.searchParams.get('mode'),
            hadMode: url.searchParams.has('mode'),
            orphans: [{ docName: 'lonely-page', title: 'Lonely' }],
          });
        case '/api/hubs':
          return Response.json({
            ok: true,
            hubs: [
              { docName: 'architecture', title: 'Architecture', count: 12 },
              { docName: 'data-model', title: 'Data Model', count: 8 },
            ],
          });
        case '/api/suggest-links': {
          const docName = url.searchParams.get('docName');
          if (docName === 'project-alpha') {
            return Response.json({
              ok: true,
              target: { docName: 'project-alpha', title: 'Project Alpha', aliases: ['PA'] },
              mentions: [
                {
                  source: 'notes',
                  excerpt: 'Project Alpha should link back to the launch notes.',
                  offset: 0,
                },
              ],
              truncated: false,
            });
          }
          return Response.json({ ok: false, error: 'Page not found' }, { status: 404 });
        }
        default:
          return Response.json({ ok: false, error: 'Not found' }, { status: 404 });
      }
    },
  });
  baseUrl = `http://127.0.0.1:${testServer.port}`;
});

afterAll(() => {
  testServer.stop();
});

beforeEach(async () => {
  tmpDir = await mkdtemp(resolve(tmpdir(), 'ok-links-test-'));
  seenRequests.length = 0;
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe('links — registration + DESCRIPTION', () => {
  test('registers exactly one tool named "links"', () => {
    const { server, getTool } = createFakeServer();
    register(server, makeDeps(baseUrl, tmpDir));
    expect(getTool().name).toBe('links');
  });

  test('DESCRIPTION enumerates all six kinds and their key parameters', () => {
    expect(DESCRIPTION).toContain('`backlinks`');
    expect(DESCRIPTION).toContain('`forward`');
    expect(DESCRIPTION).toContain('`dead`');
    expect(DESCRIPTION).toContain('`orphans`');
    expect(DESCRIPTION).toContain('`hubs`');
    expect(DESCRIPTION).toContain('`suggest`');
    expect(DESCRIPTION).toContain('sourceDocuments');
    expect(DESCRIPTION).toContain('mode');
    expect(DESCRIPTION).toContain('limit');
  });

  test('returns Hocuspocus-unavailable error when no serverUrl is configured', async () => {
    const { server, getTool } = createFakeServer();
    register(server, makeDeps(undefined, tmpDir));
    const result = await getTool().handler({ kind: 'hubs' });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toBe(HOCUSPOCUS_NOT_RUNNING_ERROR);
  });
});

describe('links — kind=backlinks', () => {
  test('hits /api/backlinks with normalized docName and enriches rows with route-only previewUrl', async () => {
    // Bind the UI lock so the resolver treats routes as reachable; the
    // resolved previewUrl is route-only and carries no host:port.
    bindTestUiLock(tmpDir);
    const { server, getTool } = createFakeServer();
    register(server, makeDeps(baseUrl, tmpDir));
    const result = await getTool().handler({ kind: 'backlinks', document: 'target.md' });
    expect(seenRequests).toContain('/api/backlinks?docName=target');
    const s = result.structuredContent as {
      backlinks: Array<{ source: string; previewUrl: string; previewUrlSource: string }>;
      ui?: unknown;
    };
    expect(s.backlinks).toHaveLength(2);
    expect(s.backlinks[0]?.previewUrl).toBe('/#/alpha');
    expect(s.backlinks[0]?.previewUrlSource).toBe('lock');
    expect(s.backlinks[1]?.previewUrl).toBe('/#/beta');
    // The `ui` block was removed from list-tool responses.
    expect(s.ui).toBeUndefined();
  });

  test('missing docName returns a tool-level error', async () => {
    const { server, getTool } = createFakeServer();
    register(server, makeDeps(baseUrl, tmpDir));
    const result = await getTool().handler({ kind: 'backlinks' });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('kind=backlinks requires `document`');
  });

  test('previewUrl null when no UI lock is present', async () => {
    const { server, getTool } = createFakeServer();
    register(server, makeDeps(baseUrl, tmpDir));
    const result = await getTool().handler({ kind: 'backlinks', document: 'target' });
    const s = result.structuredContent as {
      backlinks: Array<{ previewUrl: string | null }>;
      ui?: unknown;
    };
    expect(s.backlinks[0]?.previewUrl).toBeNull();
    expect(s.ui).toBeUndefined();
  });
});

describe('links — kind=forward', () => {
  test('doc entries get previewUrl; external entries get null previewUrl', async () => {
    bindTestUiLock(tmpDir);
    const { server, getTool } = createFakeServer();
    register(server, makeDeps(baseUrl, tmpDir));
    const result = await getTool().handler({ kind: 'forward', document: 'source' });
    const s = result.structuredContent as {
      forwardLinks: Array<{
        kind: string;
        docName?: string;
        previewUrl: string | null;
        previewUrlSource?: string;
      }>;
    };
    expect(s.forwardLinks).toHaveLength(2);
    expect(s.forwardLinks[0]?.kind).toBe('doc');
    expect(s.forwardLinks[0]?.previewUrl).toBe('/#/alpha');
    expect(s.forwardLinks[1]?.kind).toBe('external');
    expect(s.forwardLinks[1]?.previewUrl).toBeNull();
    expect(s.forwardLinks[1]?.previewUrlSource).toBeUndefined();
  });

  test('missing docName returns a tool-level error', async () => {
    const { server, getTool } = createFakeServer();
    register(server, makeDeps(baseUrl, tmpDir));
    const result = await getTool().handler({ kind: 'forward' });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('kind=forward requires `document`');
  });
});

describe('links — kind=dead', () => {
  test('forwards repeated sourceDocName query params (normalized)', async () => {
    const { server, getTool } = createFakeServer();
    register(server, makeDeps(baseUrl, tmpDir));
    const result = await getTool().handler({
      kind: 'dead',
      sourceDocuments: ['alpha.md', 'beta'],
    });
    expect(seenRequests).toContain('/api/dead-links?sourceDocName=alpha&sourceDocName=beta');
    expect(result.content[0]?.text).toContain('missing-target');
    expect(result.structuredContent).toBeDefined();
  });

  test('hits /api/dead-links with no query when sourceDocuments is absent', async () => {
    const { server, getTool } = createFakeServer();
    register(server, makeDeps(baseUrl, tmpDir));
    await getTool().handler({ kind: 'dead' });
    expect(seenRequests).toContain('/api/dead-links?');
  });

  test('target + source rows get previewUrl + previewUrlSource when resolver resolves', async () => {
    bindTestUiLock(tmpDir);
    const { server, getTool } = createFakeServer();
    register(server, makeDeps(baseUrl, tmpDir));
    const result = await getTool().handler({ kind: 'dead' });
    const s = result.structuredContent as {
      deadLinks: Array<{
        target: string;
        previewUrl: string;
        previewUrlSource: string;
        sources: Array<{ source: string; previewUrl: string; previewUrlSource: string }>;
      }>;
    };
    expect(s.deadLinks[0]?.previewUrl).toBe('/#/missing-target');
    expect(s.deadLinks[0]?.previewUrlSource).toBe('lock');
    expect(s.deadLinks[0]?.sources[0]?.previewUrl).toBe('/#/alpha');
  });
});

describe('links — kind=orphans', () => {
  test('passes mode through to the API and omits it by default', async () => {
    const { server, getTool } = createFakeServer();
    register(server, makeDeps(baseUrl, tmpDir));

    // Verify mode-passing via the request URL the fake server recorded —
    // `runOrphans` namespaces its payload to `{ orphans }` and does not echo
    // request params back into structuredContent.
    await getTool().handler({ kind: 'orphans' });
    expect(seenRequests.filter((r) => r.startsWith('/api/orphans')).at(-1)).toBe('/api/orphans?');

    await getTool().handler({ kind: 'orphans', mode: 'incoming' });
    expect(seenRequests.filter((r) => r.startsWith('/api/orphans')).at(-1)).toBe(
      '/api/orphans?mode=incoming',
    );
  });

  test('enriches orphan rows with previewUrl', async () => {
    bindTestUiLock(tmpDir);
    const { server, getTool } = createFakeServer();
    register(server, makeDeps(baseUrl, tmpDir));
    const result = await getTool().handler({ kind: 'orphans' });
    const s = result.structuredContent as {
      orphans: Array<{ docName: string; previewUrl: string; previewUrlSource: string }>;
    };
    expect(s.orphans[0]?.previewUrl).toBe('/#/lonely-page');
    expect(s.orphans[0]?.previewUrlSource).toBe('lock');
  });
});

describe('links — kind=hubs', () => {
  test('passes limit through to the API and omits it by default', async () => {
    const { server, getTool } = createFakeServer();
    register(server, makeDeps(baseUrl, tmpDir));

    await getTool().handler({ kind: 'hubs' });
    expect(seenRequests).toContain('/api/hubs?');

    seenRequests.length = 0;
    await getTool().handler({ kind: 'hubs', limit: 5 });
    expect(seenRequests).toContain('/api/hubs?limit=5');
  });

  test('enriches hub rows with previewUrl', async () => {
    bindTestUiLock(tmpDir);
    const { server, getTool } = createFakeServer();
    register(server, makeDeps(baseUrl, tmpDir));
    const result = await getTool().handler({ kind: 'hubs' });
    const s = result.structuredContent as {
      hubs: Array<{ docName: string; previewUrl: string; previewUrlSource: string }>;
    };
    expect(s.hubs).toHaveLength(2);
    expect(s.hubs[0]?.previewUrl).toBe('/#/architecture');
  });
});

describe('links — kind=suggest', () => {
  test('normalizes trailing markdown extensions and returns the suggest payload', async () => {
    const { server, getTool } = createFakeServer();
    register(server, makeDeps(baseUrl, tmpDir));
    const result = await getTool().handler({ kind: 'suggest', document: 'project-alpha.md' });
    expect(result.content[0]?.text).toContain('"docName": "project-alpha"');
    const expectedBody = {
      target: { docName: 'project-alpha', title: 'Project Alpha', aliases: ['PA'] },
      mentions: [
        {
          source: 'notes',
          excerpt: 'Project Alpha should link back to the launch notes.',
          offset: 0,
        },
      ],
      truncated: false,
    };
    expect(result.structuredContent).toMatchObject({
      suggest: { ...expectedBody, previewUrl: null },
    });
  });

  test('emits previewUrl + previewUrlSource when resolver resolves', async () => {
    bindTestUiLock(tmpDir);
    const { server, getTool } = createFakeServer();
    register(server, makeDeps(baseUrl, tmpDir));
    const result = await getTool().handler({ kind: 'suggest', document: 'project-alpha' });
    expect(result.structuredContent).toMatchObject({
      suggest: {
        previewUrl: '/#/project-alpha',
        previewUrlSource: 'lock',
      },
    });
  });

  test('propagates HTTP endpoint errors to the caller', async () => {
    const { server, getTool } = createFakeServer();
    register(server, makeDeps(baseUrl, tmpDir));
    const result = await getTool().handler({ kind: 'suggest', document: 'missing-page' });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toBe('Error: Page not found');
  });

  test('missing docName returns a tool-level error', async () => {
    const { server, getTool } = createFakeServer();
    register(server, makeDeps(baseUrl, tmpDir));
    const result = await getTool().handler({ kind: 'suggest' });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('kind=suggest requires `document`');
  });
});

describe('links — multi-kind (array)', () => {
  test('an array of kinds fans out and merges into one payload', async () => {
    const { server, getTool } = createFakeServer();
    register(server, makeDeps(baseUrl, tmpDir));
    const result = await getTool().handler({ kind: ['dead', 'orphans', 'hubs'] });
    expect(result.isError).toBeUndefined();
    const s = result.structuredContent as {
      deadLinks: unknown[];
      orphans: unknown[];
      hubs: unknown[];
    };
    expect(s.deadLinks).toHaveLength(1);
    expect(s.orphans).toHaveLength(1);
    expect(s.hubs).toHaveLength(2);
  });

  test('a per-kind failure surfaces in an `errors` map; other kinds still return', async () => {
    const { server, getTool } = createFakeServer();
    register(server, makeDeps(baseUrl, tmpDir));
    // `backlinks` needs `docName` — omitting it fails just that kind.
    const result = await getTool().handler({ kind: ['dead', 'backlinks'] });
    expect(result.isError).toBeUndefined();
    const s = result.structuredContent as {
      deadLinks: unknown[];
      errors: Record<string, string>;
    };
    expect(s.deadLinks).toHaveLength(1);
    expect(s.errors?.backlinks).toContain('requires `document`');
  });

  test('a single-element array behaves like the scalar form', async () => {
    const { server, getTool } = createFakeServer();
    register(server, makeDeps(baseUrl, tmpDir));
    const result = await getTool().handler({ kind: ['hubs'] });
    expect(result.isError).toBeUndefined();
    const s = result.structuredContent as { hubs: unknown[] };
    expect(s.hubs).toHaveLength(2);
  });
});
