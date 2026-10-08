import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { ConfigSchema } from '../../config/schema.ts';
import { installJsonSchemaDialect } from '../json-schema-dialect.ts';
import { register } from './edit.ts';

let root: string;
let listener: Server;
let mcp: McpServer;
let client: Client;
let writes = 0;
const detail = 'body: Disallowed content control U+001F at zero-based UTF-16 offset 9.';

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'ok-metadata-control-advice-'));
  const templates = join(root, 'templates', '.ok', 'templates');
  mkdirSync(templates, { recursive: true });
  writeFileSync(
    join(templates, 'existing.md'),
    '---\ntitle: Existing\n---\nHistorical\u001f body.\n',
  );
  listener = createServer((req, res) => {
    req.resume();
    if (req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          skill: {
            frontmatter: { description: 'Existing' },
            body: 'Historical\u001f body.\n',
            files: [],
          },
        }),
      );
      return;
    }
    writes++;
    res.writeHead(400, { 'Content-Type': 'application/problem+json' });
    res.end(
      JSON.stringify({
        type: 'urn:ok:error:invalid-request',
        title: 'Request body is invalid.',
        status: 400,
        contentControlAdmission: true,
        detail,
      }),
    );
  });
  await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', resolve));
  const address = listener.address();
  if (address === null || typeof address === 'string') throw new Error('Missing listener port');
  mcp = new McpServer({ name: 'metadata-control-advice', version: '1' });
  register(mcp, {
    config: ConfigSchema.parse({ content: { dir: '.' } }),
    resolveCwd: async () => root,
    serverUrl: `http://127.0.0.1:${address.port}`,
  });
  installJsonSchemaDialect(mcp);
  client = new Client({ name: 'metadata-control-advice', version: '1' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([mcp.connect(st), client.connect(ct)]);
});

afterAll(async () => {
  await client?.close();
  await mcp?.close();
  if (listener)
    await new Promise<void>((resolve, reject) =>
      listener.close((error) => (error ? reject(error) : resolve())),
    );
  rmSync(root, { recursive: true, force: true });
});

test.each([
  {
    label: 'template frontmatter',
    args: { template: { path: 'templates/existing', frontmatter: { description: 'Updated' } } },
    kind: 'template',
  },
  {
    label: 'skill description',
    args: { skill: { name: 'existing', description: 'Updated' } },
    kind: 'skill',
  },
])('$label refusal repairs stored body without naming absent replace', async ({ args, kind }) => {
  const count = writes;
  const result = await client.callTool({ name: 'edit', arguments: args });
  expect(writes).toBe(count + 1);
  expect(result.isError).toBe(true);
  expect(result.content).toEqual([
    {
      type: 'text',
      text: `Error: Request body is invalid. (${detail}) Any body offset refers to the full stored ${kind} body resubmitted by this edit. Remove stored controls through a clean full replacement using write({ ${kind}: ... }).`,
    },
  ]);
});

test('template edit description states full-body precondition before a call', async () => {
  const tools = await client.listTools();
  const schema = tools.tools.find((tool) => tool.name === 'edit')?.inputSchema;
  expect(schema?.properties?.template).toMatchObject({
    description: expect.stringContaining('Edits resubmit the full stored template body'),
  });
});

test('skill edit description distinguishes body and bundle-file preconditions', async () => {
  const tools = await client.listTools();
  const schema = tools.tools.find((tool) => tool.name === 'edit')?.inputSchema;
  expect(schema?.properties?.skill).toMatchObject({
    description: expect.stringContaining('Without file, edits resubmit the full stored skill body'),
  });
  expect(schema?.properties?.skill).toMatchObject({
    description: expect.stringContaining('With file, edits resubmit the full file content'),
  });
});
