import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { OK_DIR } from '@inkeep/open-knowledge-core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { type BootedServer, bootServer } from './boot.ts';
import { ConfigSchema } from './config/schema.ts';
import {
  __formatContributorsForTests,
  __resetContributorsForTests,
} from './contributor-tracker.ts';

const TEST_CONFIG = ConfigSchema.parse({
  contentRules: { markdownlint: { enabled: true } },
});
const TABBED_BODY = '# Doc\n\n\tindented with a hard tab\n';

interface ToolResult {
  content?: Array<{ type: string; text?: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

interface ObservedLintRequest {
  method: string | undefined;
  body: Record<string, unknown>;
}

let tmpDir: string;
let contentDir: string;
let booted: BootedServer;
let client: Client;
let apiHits: string[];
let nativeApiHits: string[];

function observeLintRequests(): ObservedLintRequest[] {
  const observed: ObservedLintRequest[] = [];
  const realFetch = globalThis.fetch;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const rawUrl =
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (new URL(rawUrl).pathname === '/api/lint/fix') {
      if (typeof init?.body !== 'string')
        throw new Error('Expected a serialized lint request body');
      observed.push({
        method: init.method,
        body: JSON.parse(init.body) as Record<string, unknown>,
      });
    }
    return realFetch(input, init);
  });
  return observed;
}

function writeFixableDocument(docName: string): string {
  const file = resolve(contentDir, `${docName}.md`);
  mkdirSync(resolve(file, '..'), { recursive: true });
  writeFileSync(file, TABBED_BODY, 'utf-8');
  return file;
}

function resultText(result: ToolResult): string {
  return result.content?.[0]?.text ?? '';
}

beforeAll(async () => {
  tmpDir = await mkdtemp(resolve(tmpdir(), 'ok-mcp-lint-http-'));
  contentDir = resolve(tmpDir, 'project');
  const okDir = resolve(contentDir, OK_DIR);
  mkdirSync(okDir, { recursive: true });
  writeFileSync(
    resolve(okDir, 'config.yml'),
    'contentRules:\n  markdownlint:\n    enabled: true\n',
  );
  writeFileSync(resolve(okDir, '.gitignore'), '');

  booted = await bootServer({
    host: '127.0.0.1',
    config: TEST_CONFIG,
    contentDir,
    port: 0,
    quiet: true,
    gitEnabled: false,
    idleShutdownMs: null,
    skipStateManifestCheck: true,
  });
  await booted.ready;

  apiHits = [];
  nativeApiHits = [];
  booted.httpServer.on('request', (req) => {
    const path = req.url?.split('?')[0];
    if (path?.startsWith('/api/')) apiHits.push(path);
  });
  const nativeDispatch = booted.serverInstance.nativeApi.dispatch;
  booted.serverInstance.nativeApi.dispatch = async (req, res) => {
    const handled = await nativeDispatch(req, res);
    if (handled) nativeApiHits.push(req.url?.split('?')[0] ?? '');
    return handled;
  };

  client = new Client({ name: 'codex', version: '0.0.0-test' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${booted.port}/mcp`)),
  );
}, 60_000);

beforeEach(() => {
  apiHits.length = 0;
  nativeApiHits.length = 0;
  __resetContributorsForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await client?.close().catch(() => {});
  await booted?.destroy();
  await rm(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe('MCP lint fix over the composed HTTP server', () => {
  test('fixes an extension-bearing document through the real lint HTTP endpoint with MCP identity', async () => {
    const docName = `nested/sdk-lint-${randomUUID()}`;
    const file = writeFixableDocument(docName);
    const requests = observeLintRequests();

    const result = (await client.callTool({
      name: 'lint',
      arguments: { document: `${docName}.md`, fix: true, cwd: contentDir },
    })) as ToolResult;

    expect(result.isError ?? false).toBe(false);
    expect(result.content?.[0]?.text).toContain('Fixed 1 problem');
    expect(result.structuredContent).toMatchObject({
      fixedCount: 1,
      errorCount: 0,
      warningCount: 0,
      ran: ['markdownlint'],
      cwd: contentDir,
      files: [{ file: `${docName}.md`, diagnostics: [] }],
    });
    expect(apiHits).toEqual(['/api/lint/fix']);
    expect(nativeApiHits).toEqual(['/api/lint/fix']);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.method).toBe('POST');
    expect(requests[0]?.body).toMatchObject({
      docName,
      agentName: 'Codex',
      clientName: 'codex',
    });
    expect(requests[0]?.body.agentId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    expect(requests[0]?.body.colorSeed).toBe('codex');
    const disk = readFileSync(file, 'utf-8');
    expect(disk).not.toContain('\t');

    const writerId = `agent-${String(requests[0]?.body.agentId)}`;
    expect(__formatContributorsForTests()).toContain(`"id":"${writerId}"`);
    const session = booted.serverInstance.sessionManager.getLiveSession(docName, writerId);
    expect(session?.dc.document.getText('source').toString()).toBe(disk);
    expect(session?.origin.context).toMatchObject({
      origin: 'agent-write',
      paired: true,
      session_id: requests[0]?.body.agentId,
      agent_type: 'codex',
    });
  });

  test('keeps an extension-less document name unchanged across the HTTP hop', async () => {
    const docName = `sdk-lint-${randomUUID()}`;
    const file = writeFixableDocument(docName);
    const requests = observeLintRequests();

    const result = (await client.callTool({
      name: 'lint',
      arguments: { document: docName, fix: true, cwd: contentDir },
    })) as ToolResult;

    expect(result.isError ?? false).toBe(false);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.body.docName).toBe(docName);
    expect(apiHits).toEqual(['/api/lint/fix']);
    expect(nativeApiHits).toEqual(['/api/lint/fix']);
    expect(readFileSync(file, 'utf-8')).not.toContain('\t');
  });

  test('rejects fix mode without a document before making a fix request', async () => {
    const requests = observeLintRequests();

    const result = (await client.callTool({
      name: 'lint',
      arguments: { fix: true, cwd: contentDir },
    })) as ToolResult;

    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain('requires `document`');
    expect(requests).toEqual([]);
    expect(apiHits).toEqual([]);
    expect(nativeApiHits).toEqual([]);
  });

  test.each([
    {
      document: '../outside',
      expected: 'docName must not contain',
      expectedHits: [],
    },
    {
      document: '__system__',
      expected: 'reserved document name',
      expectedHits: ['/api/lint/fix'],
    },
    {
      document: `missing-${randomUUID()}`,
      expected: 'Document not found',
      expectedHits: ['/api/lint/fix'],
    },
  ])(
    'preserves the MCP failure projection for $document',
    async ({ document, expected, expectedHits }) => {
      const requests = observeLintRequests();

      const result = (await client.callTool({
        name: 'lint',
        arguments: { document, fix: true, cwd: contentDir },
      })) as ToolResult;

      expect(result.isError).toBe(true);
      expect(resultText(result)).toContain(expected);
      expect(apiHits).toEqual(expectedHits);
      expect(nativeApiHits).toEqual(expectedHits);
      expect(requests).toHaveLength(expectedHits.length);
    },
  );
});
