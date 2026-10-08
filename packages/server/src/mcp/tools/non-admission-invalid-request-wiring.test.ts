import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { ConfigSchema } from '../../config/schema.ts';
import { installJsonSchemaDialect } from '../json-schema-dialect.ts';
import { register as registerEdit } from './edit.ts';
import { register as registerWrite } from './write.ts';

const cases = [
  {
    label: 'template write name',
    tool: 'write',
    args: {
      template: {
        path: 'templates/existing',
        content: 'Safe.',
        frontmatter: { title: 'Existing' },
      },
    },
    detail: 'BAD_NAME',
  },
  {
    label: 'template body edit compose',
    tool: 'edit',
    args: { template: { path: 'templates/existing', find: 'target', replace: 'replacement' } },
    detail: 'INVALID_SUBSTITUTION',
  },
  {
    label: 'template frontmatter edit',
    tool: 'edit',
    args: { template: { path: 'templates/existing', frontmatter: { description: 'Updated' } } },
    detail: 'BAD_TITLE',
  },
  {
    label: 'skill write description',
    tool: 'write',
    args: { skill: { name: 'existing', description: 'Existing', body: 'Safe.' } },
    detail: 'DESCRIPTION_TOO_LONG',
  },
  {
    label: 'skill description edit',
    tool: 'edit',
    args: { skill: { name: 'existing', description: 'Updated' } },
    detail: 'DESCRIPTION_HAS_XML',
  },
  {
    label: 'skill body edit summary',
    tool: 'edit',
    args: { skill: { name: 'existing', find: 'target', replace: 'replacement' } },
    detail: 'INVALID_SUMMARY',
  },
  {
    label: 'Markdown bundle write',
    tool: 'write',
    args: {
      skill: { name: 'existing', files: [{ path: 'references/example.md', content: 'Safe.' }] },
    },
    detail: 'BAD_PATH',
    batch: true,
  },
  {
    label: 'Markdown bundle edit',
    tool: 'edit',
    args: {
      skill: {
        name: 'existing',
        file: 'references/example.md',
        find: 'target',
        replace: 'replacement',
      },
    },
    detail: 'INVALID_SUMMARY',
  },
] as const;
let root: string;
let listener: Server;
let mcp: McpServer;
let client: Client;
let problem = {
  type: 'urn:ok:error:invalid-request',
  status: 400,
  title: 'Invalid artifact request.',
  detail: 'BAD_NAME',
};
let writes = 0;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'ok-non-admission-wiring-'));
  const templates = join(root, 'templates', '.ok', 'templates');
  mkdirSync(templates, { recursive: true });
  writeFileSync(join(templates, 'existing.md'), '---\ntitle: Existing\n---\nExisting target.\n');
  listener = createServer((req, res) => {
    req.resume();
    if (req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify(
          req.url?.startsWith('/api/skill-file')
            ? { path: 'references/example.md', kind: 'reference', text: 'Existing target.\n' }
            : {
                skill: {
                  frontmatter: { description: 'Existing' },
                  body: 'Existing target.\n',
                  files: [],
                },
              },
        ),
      );
      return;
    }
    writes++;
    res.writeHead(problem.status, { 'Content-Type': 'application/problem+json' });
    res.end(JSON.stringify(problem));
  });
  await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', resolve));
  const address = listener.address();
  if (address === null || typeof address === 'string')
    throw new Error('Missing HTTP listener port');
  mcp = new McpServer({ name: 'non-admission-wiring', version: '1' });
  const deps = {
    config: ConfigSchema.parse({ content: { dir: '.' } }),
    resolveCwd: async () => root,
    serverUrl: `http://127.0.0.1:${address.port}`,
  };
  registerWrite(mcp, deps);
  registerEdit(mcp, deps);
  installJsonSchemaDialect(mcp);
  client = new Client({ name: 'non-admission-wiring', version: '1' });
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

describe.each([false, true])(
  'controlled non-admission 400 formatter wiring (C0-like echoed text=%s)',
  (spoof) => {
    test.each(cases)('$label returns exactly its problem title and detail', async (item) => {
      problem = {
        type: 'urn:ok:error:invalid-request',
        status: 400,
        title: spoof ? 'Request body is invalid.' : 'Invalid artifact request.',
        detail: spoof
          ? 'body: Disallowed content control U+0000 at zero-based UTF-16 offset 3. C0 controls allow only TAB, LF and CR. Remove the character or replace it with a printable escape such as \\u0000.'
          : item.detail,
      };
      const count = writes;
      const result = await client.callTool({ name: item.tool, arguments: item.args });
      expect(writes).toBe(count + 1);
      expect(result.isError).toBe(true);
      const expected = `Error: ${problem.title} (${problem.detail})`;
      expect(result.content).toEqual([
        {
          type: 'text',
          text:
            'batch' in item
              ? `0/1 bundle file(s) written.\n  Failed references/example.md: ${expected}`
              : expected,
        },
      ]);
    });
  },
);
