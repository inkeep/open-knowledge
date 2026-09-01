import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { HARNESS_BOOT_TIMEOUT_MS } from './harness-boot-timeout';
import { createTestServer, pollUntil, type TestServer } from './test-harness.ts';

const MCP_PROTOCOL_VERSION = '2025-06-18';

interface InitializedSession {
  sessionId: string;
  protocolVersion: string;
}

async function openMcpSession(port: number): Promise<InitializedSession> {
  const init = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: { accept: 'application/json, text/event-stream', 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'Claude', version: '1.0.0' },
      },
    }),
  });
  expect(init.status).toBe(200);
  const sessionId = init.headers.get('mcp-session-id');
  expect(sessionId).toBeTruthy();
  const initBody = (await init.json()) as { result?: { protocolVersion?: string } };
  const protocolVersion = initBody.result?.protocolVersion ?? MCP_PROTOCOL_VERSION;

  const initialized = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: {
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
      'mcp-session-id': sessionId as string,
      'mcp-protocol-version': protocolVersion,
    },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
  });
  expect(initialized.status).toBe(202);
  return { sessionId: sessionId as string, protocolVersion };
}

async function callWrite(
  port: number,
  session: InitializedSession,
  args: Record<string, unknown>,
  cwd: string,
): Promise<{ isError?: boolean }> {
  const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: {
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
      'mcp-session-id': session.sessionId,
      'mcp-protocol-version': session.protocolVersion,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'write', arguments: { ...args, cwd } },
    }),
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { result?: { isError?: boolean }; error?: unknown };
  if (body.error) throw new Error(`tools/call error: ${JSON.stringify(body.error)}`);
  return body.result ?? {};
}

let server: TestServer;

beforeAll(async () => {
  server = await createTestServer({ debounce: 50, maxDebounce: 200 });
}, HARNESS_BOOT_TIMEOUT_MS);

afterAll(async () => {
  await server.cleanup();
});

test('explicit `extension: ".mdx"` on a suffix-less path creates a .mdx file', async () => {
  const session = await openMcpSession(server.port);
  const docName = `mdx-field-${randomUUID().slice(0, 8)}`;

  const result = await callWrite(
    server.port,
    session,
    {
      document: {
        path: docName,
        content: '# Hello MDX\n\nFrom the extension field.\n',
        extension: '.mdx',
      },
    },
    server.contentDir,
  );
  expect(result.isError ?? false).toBe(false);

  await pollUntil(() => existsSync(join(server.contentDir, `${docName}.mdx`)));
  expect(existsSync(join(server.contentDir, `${docName}.md`))).toBe(false);
});

test('the `extension` field wins over an extension typed into `path`', async () => {
  const session = await openMcpSession(server.port);
  const docName = `mdx-precedence-${randomUUID().slice(0, 8)}`;

  const result = await callWrite(
    server.port,
    session,
    { document: { path: `${docName}.md`, content: '# Precedence\n', extension: '.mdx' } },
    server.contentDir,
  );
  expect(result.isError ?? false).toBe(false);

  await pollUntil(() => existsSync(join(server.contentDir, `${docName}.mdx`)));
  expect(existsSync(join(server.contentDir, `${docName}.md`))).toBe(false);
});

test('write({ document: { template } }) keeps a single-block template doc-frontmatter', async () => {
  const session = await openMcpSession(server.port);
  mkdirSync(join(server.contentDir, '.ok', 'templates'), { recursive: true });
  writeFileSync(
    join(server.contentDir, '.ok', 'templates', 'research-tpl.md'),
    '---\ntemplate:\n  title: Research Log\n  description: provisional\ntype: research-note\nstatus: provisional\ncreated: {{date}}\ntags: [research]\n---\n\n## Question\n',
    'utf-8',
  );

  const docName = `from-tpl-${randomUUID().slice(0, 8)}`;
  const result = await callWrite(
    server.port,
    session,
    { document: { path: docName, template: 'research-tpl' } },
    server.contentDir,
  );
  expect(result.isError ?? false).toBe(false);

  await pollUntil(() => existsSync(join(server.contentDir, `${docName}.md`)));
  const created = readFileSync(join(server.contentDir, `${docName}.md`), 'utf-8');
  expect(created).toContain('type: research-note');
  expect(created).toContain('status: provisional');
  expect(created).toContain('## Question');
  expect(created).not.toContain('template:');
  expect(created).not.toContain('title: Research Log');
  expect(created).not.toContain('{{date}}');
  expect(created).toMatch(/created: \d{4}-\d{2}-\d{2}/);
});

test('batch `documents` write honors a per-entry `extension`', async () => {
  const session = await openMcpSession(server.port);
  const a = `mdx-batch-a-${randomUUID().slice(0, 8)}`;
  const b = `mdx-batch-b-${randomUUID().slice(0, 8)}`;

  const result = await callWrite(
    server.port,
    session,
    {
      documents: [
        { path: a, content: '# Batch A\n', extension: '.mdx' },
        { path: b, content: '# Batch B\n', extension: '.mdx' },
      ],
    },
    server.contentDir,
  );
  expect(result.isError ?? false).toBe(false);

  await pollUntil(
    () =>
      existsSync(join(server.contentDir, `${a}.mdx`)) &&
      existsSync(join(server.contentDir, `${b}.mdx`)),
  );
  expect(existsSync(join(server.contentDir, `${a}.md`))).toBe(false);
  expect(existsSync(join(server.contentDir, `${b}.md`))).toBe(false);
});
