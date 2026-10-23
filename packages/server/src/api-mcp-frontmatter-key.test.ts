import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { parseDocument } from 'yaml';
import type { BootedServer } from './boot.ts';
import { bootCompositionRig } from './composition-rig.test-helper.ts';
import { ConfigSchema } from './config/schema.ts';
import { connectMcpTestClient } from './mcp/client.test-helper.ts';
import { createMcpHttpHandler, type McpHttpHandler } from './mcp-http.ts';

const cases = [
  ['top-level', '__proto__: 0'],
  ['nested-object', 'key: { __proto__: 0, keep: 1 }'],
  ['nested-list', 'key: [{ __proto__: 0 }]'],
  ['nested-lists', 'key: [[{ __proto__: 0, keep: 1 }]]'],
  ['object-value', 'key: { __proto__: { retained: value }, keep: 1 }'],
  ['alias-key', 'anchor: &key __proto__\n*key : 0'],
  ['aliased-complex-key', '? &obj { __proto__: 0 }\n: ordinary\nkey: *obj'],
  ['escaped-key', '"\\u005f_proto__": 0'],
] as const;
const original = '---\nkeep: baseline\n---\n\n# Original bytes\n';
const body = '\n# Body\n\nBackslash \\* and <custom>raw</custom>.\n\n';
let root: string;
let server: BootedServer;
let handler: McpHttpHandler;
let transportServer: Server;
let client: Client;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'ok-mcp-frontmatter-key-'));
  for (const [name] of cases) writeFileSync(join(root, `${name}.md`), original);
  writeFileSync(join(root, 'ordinary.md'), original);
  server = await bootCompositionRig(root);
  await server.ready;
  handler = createMcpHttpHandler({
    contentDir: server.contentDir,
    projectDir: server.contentDir,
    config: ConfigSchema.parse({}),
    getServerUrl: () => `http://127.0.0.1:${server.port}`,
  });
  transportServer = createServer((req, res) => {
    void handler.handle(req, res);
  });
  await new Promise<void>((resolve, reject) => {
    transportServer.once('error', reject);
    transportServer.listen(0, '127.0.0.1', resolve);
  });
  const address = transportServer.address();
  if (address === null || typeof address === 'string') throw new Error('MCP listener absent');
  client = await connectMcpTestClient(`http://127.0.0.1:${address.port}/mcp`);
}, 60_000);

afterAll(async () => {
  await client?.close();
  await handler?.close();
  if (transportServer) {
    transportServer.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      transportServer.close((error) => (error ? reject(error) : resolve()));
    });
  }
  await server?.destroy();
  if (root) rmSync(root, { recursive: true, force: true });
});

test.for(cases)(
  'embedded frontmatter key refusal leaves Y.Text and disk unchanged for %s',
  async ([name, yaml], { signal }) => {
    const session = await server.serverInstance.sessionManager.getSession(name);
    const source = session.dc.document.getText('source');
    expect(source.toString()).toBe(original);
    const beforeDisk = readFileSync(join(root, `${name}.md`));
    expect(beforeDisk.toString('utf8')).toBe(original);
    const result = await client.callTool(
      {
        name: 'write',
        arguments: {
          document: {
            path: name,
            content: `---\n${yaml}\n---\n${body}`,
            frontmatter: { added: 'ordinary' },
            position: 'replace',
          },
        },
      },
      undefined,
      { signal },
    );
    expect.soft(result.isError).toBe(true);
    expect
      .soft(JSON.stringify(result.content))
      .toMatch(/\bEMBEDDED_FRONTMATTER_UNSUPPORTED_KEY — /);
    expect.soft(source.toString()).toBe(original);
    expect.soft(readFileSync(join(root, `${name}.md`))).toEqual(beforeDisk);
  },
);

test('embedded frontmatter composition preserves ordinary values and body bytes', async ({
  signal,
}) => {
  const session = await server.serverInstance.sessionManager.getSession('ordinary');
  const result = await client.callTool(
    {
      name: 'write',
      arguments: {
        document: {
          path: 'ordinary',
          content: `---\nnumber: 7\nflag: false\nempty: null\nlabel: __proto__\n? { __proto__: 0 }\n: ordinary\nkey: [0, true, null, { count: 3, yes: true }]\n---\n${body}`,
          frontmatter: { added: 'ordinary' },
          position: 'replace',
        },
      },
    },
    undefined,
    { signal },
  );
  expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
  const stored = readFileSync(join(root, 'ordinary.md'), 'utf8');
  expect(session.dc.document.getText('source').toString()).toBe(stored);
  const end = stored.indexOf('\n---\n', 4);
  expect(end).toBeGreaterThan(4);
  expect(stored.slice(end + 5)).toBe(body);
  expect(parseDocument(stored.slice(4, end)).toJS()).toEqual({
    number: 7,
    flag: false,
    empty: '',
    label: '__proto__',
    '{ __proto__: 0 }': 'ordinary',
    key: ['0', 'true', { count: 3, yes: true }],
    added: 'ordinary',
  });
});
