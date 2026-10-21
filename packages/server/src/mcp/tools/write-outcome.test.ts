import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { ConfigSchema } from '../../config/schema.ts';
import { type FetchTestServer, startFetchTestServer } from './fetch-test-server.test-helper.ts';
import { registerAllTools } from './index.ts';

const BOTH_KEPT = { outcome: 'both-kept', saved: true, nextStep: 're-read' } as const;
const REFUSED = { outcome: 'refused', saved: false, nextStep: 're-read' } as const;
let appRouteFields: Record<string, unknown> = BOTH_KEPT;
let skillFileWrites = 0;
const LANDED = 'The write landed and is saved; do not retry it.';

const documentAnswers = new Map<string, { status: number; body: Record<string, unknown> }>([
  [
    'newer-saved',
    {
      status: 200,
      body: {
        timestamp: 't',
        subscriberCount: 0,
        systemSubscriberCount: 1,
        brokenLinks: [],
        outcome: 'displaced',
        saved: true,
        nextStep: 'ask',
      },
    },
  ],
  [
    'newer-unsaved',
    {
      status: 409,
      body: {
        type: 'urn:ok:error:doc-removed',
        title: 'A refusal a newer server describes.',
        status: 409,
        detail: 'Detail from a newer server.',
        outcome: 'held',
        saved: false,
        nextStep: 'retry',
      },
    },
  ],
  [
    'older-server',
    {
      status: 200,
      body: { timestamp: 't', subscriberCount: 0, systemSubscriberCount: 1, brokenLinks: [] },
    },
  ],
  [
    'beta-held',
    {
      status: 503,
      body: {
        type: 'urn:ok:error:save-held',
        title: 'Edit applied in memory; its save to disk is held.',
        status: 503,
        detail: 'beta-held was not saved.',
        reason: 'pending-unreadable',
        retryWhen: 'next-save',
        nextStep: 're-read',
      },
    },
  ],
  [
    'fm-both-kept',
    {
      status: 409,
      body: {
        type: 'urn:ok:error:both-kept',
        title: 'Edit saved; both versions of a block changed here and outside were kept.',
        status: 409,
        timestamp: 't',
        subscriberCount: 0,
        systemSubscriberCount: 1,
        brokenLinks: [],
        ...BOTH_KEPT,
      },
    },
  ],
  [
    'fm-applied',
    {
      status: 200,
      body: {
        timestamp: 't',
        subscriberCount: 0,
        systemSubscriberCount: 1,
        brokenLinks: [],
        outcome: 'applied',
        saved: true,
        nextStep: 'none',
      },
    },
  ],
  ...['fm-malformed', 'fm-patch-unanswered'].map(
    (name) =>
      [
        name,
        {
          status: 200,
          body: {
            timestamp: 't',
            subscriberCount: 0,
            systemSubscriberCount: 1,
            brokenLinks: [],
            outcome: 'applied',
            saved: true,
            nextStep: 'none',
          },
        },
      ] as const,
  ),
  [
    'partial-both-kept',
    {
      status: 409,
      body: {
        type: 'urn:ok:error:both-kept',
        title: 'Edit saved; both versions of a block changed here and outside were kept.',
        status: 409,
        timestamp: 't',
        subscriberCount: 0,
        systemSubscriberCount: 1,
        brokenLinks: [],
        outcome: 'both-kept',
      },
    },
  ],
  [
    'batch-held',
    {
      status: 503,
      body: {
        type: 'urn:ok:error:doc-moved',
        title: 'Edit kept: the document was moved outside the app, and the edit moved with it.',
        status: 409,
        detail: 'batch-held moved to moved/batch-held. Re-read moved/batch-held to confirm.',
        outcome: 'projection-held',
        saved: false,
        nextStep: 're-read',
      },
    },
  ],
  [
    'fm-held',
    {
      status: 503,
      body: {
        type: 'urn:ok:error:save-held',
        title: 'Edit applied in memory; its save to disk is held.',
        status: 503,
        detail: 'fm-held was not saved.',
        reason: 'pending-unreadable',
        outcome: 'projection-held',
        saved: false,
        nextStep: 're-read',
      },
    },
  ],
]);

const frontmatterPatches: string[] = [];

let testServer: FetchTestServer;
let cwd: string;
let client: Client;

beforeAll(async () => {
  testServer = await startFetchTestServer({
    hostname: '127.0.0.1',
    async fetch(request) {
      const { pathname } = new URL(request.url);
      if (request.method === 'GET' && pathname.startsWith('/api/history/')) {
        return Response.json({ author: 'someone', timestamp: 't', content: '# v1\n' });
      }
      if (request.method === 'GET' && pathname === '/api/skill-file') {
        return Response.json({ path: 'references/a.md', kind: 'reference', text: 'a\n' });
      }
      const body = (await request.json()) as { docName?: string };
      switch (pathname) {
        case '/api/agent-write-md': {
          const answer = documentAnswers.get(body.docName ?? '');
          if (!answer) return Response.json({ error: 'unexpected document' }, { status: 500 });
          return Response.json(answer.body, { status: answer.status });
        }
        case '/api/frontmatter-patch':
          frontmatterPatches.push(body.docName ?? '');
          if (body.docName === 'fm-malformed') {
            return Response.json(
              {
                type: 'urn:ok:error:frontmatter-malformed',
                title: 'Frontmatter YAML is malformed.',
                status: 400,
                outcome: 'refused',
                saved: false,
                nextStep: 'retry',
              },
              { status: 400 },
            );
          }
          if (body.docName === 'fm-patch-unanswered') {
            return Response.json({ error: 'internal' }, { status: 500 });
          }
          if (body.docName === 'fm-applied') {
            return Response.json(
              {
                type: 'urn:ok:error:both-kept',
                title: 'Edit saved; both versions of a block changed here and outside were kept.',
                status: 409,
                timestamp: 't',
                subscriberCount: 0,
                systemSubscriberCount: 1,
                appliedKeys: ['title'],
                brokenLinks: [],
                ...BOTH_KEPT,
              },
              { status: 409 },
            );
          }
          return Response.json({
            timestamp: 't',
            subscriberCount: 0,
            systemSubscriberCount: 1,
            appliedKeys: ['title'],
            brokenLinks: [],
            outcome: 'applied',
            saved: true,
            nextStep: 'none',
          });
        case '/api/template':
          return Response.json({
            path: 'guides/.ok/templates/tpl.md',
            created: false,
            warnings: [],
            ...appRouteFields,
          });
        case '/api/skill':
          return Response.json({
            path: '.agents/skills/demo/SKILL.md',
            created: false,
            warnings: [],
            warningCodes: [],
            ...appRouteFields,
          });
        case '/api/skill-file':
          skillFileWrites += 1;
          return Response.json({
            path: 'references/a.md',
            created: false,
            kind: 'reference',
            content: true,
            ...appRouteFields,
          });
        case '/api/rollback':
          return Response.json({ restoredFrom: 'v1', timestamp: 't', ...appRouteFields });
        case '/api/lint/fix':
          return Response.json({
            file: 'notes/a.md',
            fixedCount: 1,
            diagnostics: [],
            errorCount: 0,
            warningCount: 0,
            ran: ['markdownlint'],
            ...appRouteFields,
          });
        default:
          return Response.json({ error: `unexpected route ${pathname}` }, { status: 500 });
      }
    },
  });
  cwd = mkdtempSync(join(tmpdir(), 'ok-write-outcome-normalize-'));
  mkdirSync(join(cwd, '.ok', 'templates'), { recursive: true });
  writeFileSync(
    join(cwd, '.ok', 'templates', 'tpl.md'),
    '---\ntitle: Tpl\n---\n\nTemplate body.\n',
  );
  mkdirSync(join(cwd, 'guides', '.ok', 'templates'), { recursive: true });
  writeFileSync(
    join(cwd, 'guides', '.ok', 'templates', 'tpl.md'),
    '---\ntitle: Tpl\n---\n\nBody line.\n',
  );
  const server = new McpServer({ name: 'write-outcome', version: '1' });
  registerAllTools(server, {
    serverUrl: `http://127.0.0.1:${testServer.port}`,
    config: ConfigSchema.parse({}),
    resolveCwd: async () => cwd,
  });
  client = new Client({ name: 'write-outcome', version: '1' });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  await client.listTools();
});

afterAll(async () => {
  await client.close();
  testServer.stop();
  rmSync(cwd, { recursive: true, force: true });
});

function write(path: string) {
  return client.callTool({
    name: 'write',
    arguments: { document: { path, content: 'Line.\n', position: 'replace' } },
  });
}

function textOf(result: { content: unknown }): string {
  return (result.content as Array<{ text?: string }>)[0]?.text ?? '';
}

describe('a write tool copy meeting outcome values it does not know', () => {
  test('reads an unknown outcome on a saved write as merged-first with a re-read, and says so', async () => {
    const result = await write('newer-saved');
    expect(result.structuredContent).toMatchObject({
      outcome: 'merged-first',
      saved: true,
      nextStep: 're-read',
    });
    const { text: _mirroredText, ...fields } = result.structuredContent as Record<string, unknown>;
    expect(JSON.stringify(fields)).not.toContain('displaced');
    expect(textOf(result)).toContain('outcome "displaced", which this tool version does not know');
  });

  test('reads an unknown outcome on an unsaved write as refused with a re-read, never a retry', async () => {
    const result = await write('newer-unsaved');
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      outcome: 'refused',
      saved: false,
      nextStep: 're-read',
    });
    expect(textOf(result)).toContain('A refusal a newer server describes.');
  });

  test('invents no outcome when an older server sends none', async () => {
    const result = await write('older-server');
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).not.toHaveProperty('outcome');
    expect(result.structuredContent).not.toHaveProperty('saved');
  });

  test('invents no outcome from a beta save-held that carries only nextStep and retryWhen', async () => {
    const result = await write('beta-held');
    expect(result.isError).toBe(true);
    expect(result.structuredContent ?? {}).not.toHaveProperty('outcome');
    expect(textOf(result)).not.toContain('Outcome:');
    expect(textOf(result)).toContain('its save to disk is held');
  });
});

describe('a both-kept result from every write tool opens by saying the write landed', () => {
  test.each([
    {
      tool: 'write',
      args: {
        template: {
          path: 'guides/tpl2',
          content: '# {{date}}\n',
          frontmatter: { title: 'Tpl two' },
        },
      },
    },
    {
      tool: 'edit',
      args: { template: { path: 'guides/tpl', find: 'Body line.', replace: 'Edited line.' } },
    },
    {
      tool: 'write',
      args: { skill: { name: 'demo', description: 'Use when testing.', body: '# Demo\n' } },
    },
    {
      tool: 'edit',
      args: { skill: { name: 'demo', file: 'references/a.md', find: 'a', replace: 'b' } },
    },
    { tool: 'restore_version', args: { document: 'notes/a', version: 'a'.repeat(40) } },
    { tool: 'lint', args: { document: 'notes/a', fix: true } },
  ])('$tool $args', async ({ tool, args }) => {
    const result = await client.callTool({ name: tool, arguments: args });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject(BOTH_KEPT);
    expect(textOf(result).split('\n')[0]).toContain(LANDED);
  });

  test('write skill files each open their line with the landed note', async () => {
    const result = await client.callTool({
      name: 'write',
      arguments: { skill: { name: 'demo', files: [{ path: 'references/a.md', content: 'a\n' }] } },
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain(LANDED);
    expect(
      (result.structuredContent as { skill: { files: Array<Record<string, unknown>> } }).skill
        .files[0],
    ).toMatchObject(BOTH_KEPT);
  });
});

describe('a templated write with frontmatter that lands without plain success', () => {
  test('still applies the frontmatter when both versions were kept', async () => {
    const result = await client.callTool({
      name: 'write',
      arguments: {
        document: { path: 'fm-both-kept', template: 'tpl', frontmatter: { title: 'Mine' } },
      },
    });
    expect(result.structuredContent).toMatchObject(BOTH_KEPT);
    expect(frontmatterPatches).toContain('fm-both-kept');
  });

  test('says the frontmatter was not applied when the save is held', async () => {
    const result = await client.callTool({
      name: 'write',
      arguments: {
        document: { path: 'fm-held', template: 'tpl', frontmatter: { title: 'Mine' } },
      },
    });
    expect(result.structuredContent).toMatchObject({
      outcome: 'projection-held',
      nextStep: 're-read',
    });
    expect(frontmatterPatches).not.toContain('fm-held');
    expect(textOf(result)).toContain('was not applied');
  });
});

describe('a write the server answered without an error status but reported as refused', () => {
  test.each([
    {
      tool: 'write',
      args: {
        template: {
          path: 'guides/tpl3',
          content: '# {{date}}\n',
          frontmatter: { title: 'Tpl three' },
        },
      },
      success: /Created template|Updated template/,
    },
    {
      tool: 'edit',
      args: { template: { path: 'guides/tpl', find: 'Body line.', replace: 'Edited line.' } },
      success: /Edited template/,
    },
    {
      tool: 'write',
      args: { skill: { name: 'demo', description: 'Use when testing.', body: '# Demo\n' } },
      success: /Created skill|Updated skill/,
    },
    {
      tool: 'edit',
      args: { skill: { name: 'demo', file: 'references/a.md', find: 'a', replace: 'b' } },
      success: /Updated skill|Created skill/,
    },
    {
      tool: 'restore_version',
      args: { document: 'notes/a', version: 'a'.repeat(40) },
      success: /Restored/,
    },
    { tool: 'lint', args: { document: 'notes/a', fix: true }, success: /Fixed|Applied auto-fixes/ },
  ])(
    '$tool $args opens with the refusal, not the success line',
    async ({ tool, args, success }) => {
      appRouteFields = REFUSED;
      try {
        const result = await client.callTool({ name: tool, arguments: args });
        expect(result.isError).toBe(true);
        expect(result.structuredContent).toMatchObject(REFUSED);
        expect(result.structuredContent).not.toHaveProperty('skill');
        expect(result.structuredContent).not.toHaveProperty('template');
        const firstLine = textOf(result).split('\n')[0] ?? '';
        expect(firstLine).toMatch(/^Error: .* was not saved\./);
        expect(textOf(result)).not.toMatch(success);
      } finally {
        appRouteFields = BOTH_KEPT;
      }
    },
  );

  test('a refused SKILL.md stops the bundle file writes', async () => {
    appRouteFields = REFUSED;
    const before = skillFileWrites;
    try {
      const result = await client.callTool({
        name: 'write',
        arguments: {
          skill: {
            name: 'demo',
            description: 'Use when testing.',
            files: [{ path: 'references/a.md', content: 'a\n' }],
          },
        },
      });
      expect(result.isError).toBe(true);
      expect(skillFileWrites).toBe(before);
    } finally {
      appRouteFields = BOTH_KEPT;
    }
  });
});

describe('fields a server leaves out stay out', () => {
  test('a both-kept answer with no saved flag or next step reports neither', async () => {
    const result = await write('partial-both-kept');
    expect(result.structuredContent).toMatchObject({ outcome: 'both-kept' });
    expect(result.structuredContent).not.toHaveProperty('saved');
    expect(result.structuredContent).not.toHaveProperty('nextStep');
    expect(textOf(result)).not.toContain('undefined');
    expect(textOf(result)).not.toContain('saved: no');
  });
});

describe('a templated write whose frontmatter patch kept both versions', () => {
  test('reports the patch as landed with both-kept, not as a failure', async () => {
    const result = await client.callTool({
      name: 'write',
      arguments: {
        document: { path: 'fm-applied', template: 'tpl', frontmatter: { title: 'Mine' } },
      },
    });
    expect(result.structuredContent).toMatchObject(BOTH_KEPT);
    expect(textOf(result)).not.toContain('does not show whether the frontmatter was applied');
    expect(textOf(result).split('\n')[0]).toContain(LANDED);
  });
});

describe('a templated write whose body landed but whose frontmatter patch failed', () => {
  test('reports the body as saved and scopes the next step to the frontmatter', async () => {
    const result = await client.callTool({
      name: 'write',
      arguments: {
        document: { path: 'fm-malformed', template: 'tpl', frontmatter: { title: 'Mine' } },
      },
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      outcome: 'applied',
      saved: true,
      nextStep: 're-read',
    });
    const text = textOf(result);
    expect(text).toContain('its body landed');
    expect(text).toContain('the frontmatter was not applied');
    expect(text).toContain('Re-read the document, then apply the frontmatter alone');
    expect(text).toContain('do not repeat the templated write');
    expect(text).not.toContain('next step: retry');
    expect(text).not.toContain('saved: no');
  });

  test('says the frontmatter result is unknown when the patch answer carries no outcome', async () => {
    const result = await client.callTool({
      name: 'write',
      arguments: {
        document: {
          path: 'fm-patch-unanswered',
          template: 'tpl',
          frontmatter: { title: 'Mine' },
        },
      },
    });
    expect(result.structuredContent).toMatchObject({
      outcome: 'applied',
      saved: true,
      nextStep: 're-read',
    });
    expect(textOf(result)).toContain('does not show whether the frontmatter was applied');
    expect(textOf(result)).toContain('do not repeat the templated write');
  });

  test('reports a batch entry the same way', async () => {
    const result = await client.callTool({
      name: 'write',
      arguments: {
        documents: [{ path: 'fm-malformed', template: 'tpl', frontmatter: { title: 'Mine' } }],
      },
    });
    const entries = (result.structuredContent as { documents: Array<Record<string, unknown>> })
      .documents;
    expect(entries[0]).toMatchObject({
      ok: false,
      outcome: 'applied',
      saved: true,
      nextStep: 're-read',
    });
    expect(textOf(result)).toContain('do not repeat the templated write');
  });
});

describe('a batch entry whose save is held', () => {
  test('claims no link result and carries the server detail', async () => {
    const result = await client.callTool({
      name: 'write',
      arguments: {
        documents: [
          { path: 'fm-applied', content: 'Line.\n', position: 'replace' },
          { path: 'batch-held', content: 'Line.\n', position: 'replace' },
        ],
      },
    });
    const entries = (result.structuredContent as { documents: Array<Record<string, unknown>> })
      .documents;
    expect(entries[0]).toHaveProperty('brokenLinks');
    expect(entries[1]).toMatchObject({ outcome: 'projection-held', saved: false });
    expect(entries[1]).not.toHaveProperty('brokenLinks');
    expect(textOf(result)).toContain('Re-read moved/batch-held to confirm.');
  });
});
