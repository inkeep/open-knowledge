import { describe as _bunDescribe, afterAll, beforeAll, expect, test } from 'vitest';

// Same skip-on-CI gate as boot.test.ts (oven-sh/bun#11892): boots a real
// server; local runs + the full check gate cover it.
const describe = process.env.CI ? _bunDescribe.skip : _bunDescribe;

import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { OK_DIR } from '@inkeep/open-knowledge-core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { type BootedServer, bootServer } from './boot.ts';
import { ConfigSchema } from './config/schema.ts';
import { createMcpHttpHandler, type McpHttpHandler } from './mcp-http.ts';

/**
 * End-to-end transport parity for the collapsed MCP self-calls: the SAME
 * project server answers two MCP sessions — the boot-mounted `/mcp` (wired
 * with `localApi`, so collapsed tools dispatch in-process) and a side
 * handler created WITHOUT `localApi` (every tool call round-trips HTTP).
 * For each covered tool the two sessions' final MCP responses must match
 * after masking genuinely per-call fields (timings).
 */

const TEST_CONFIG = ConfigSchema.parse({});

let tmpDir: string;
let booted: BootedServer;
let httpOnlyMcp: McpHttpHandler;
let sideServer: Server;
let localClient: Client;
let httpClient: Client;

type ToolResult = {
  content?: Array<{ type: string; text?: string }>;
  structuredContent?: unknown;
  isError?: boolean;
};

function seedOkScaffold(projectDir: string): void {
  const okDir = resolve(projectDir, OK_DIR);
  mkdirSync(okDir, { recursive: true });
  writeFileSync(resolve(okDir, 'config.yml'), '', 'utf-8');
  writeFileSync(resolve(okDir, '.gitignore'), '', 'utf-8');
}

async function connectClient(url: string, name: string): Promise<Client> {
  const client = new Client({ name, version: '0.0.0-test' });
  await client.connect(new StreamableHTTPClientTransport(new URL(url)));
  return client;
}

/** Mask per-call volatile fields so the two transports compare stably. */
function maskVolatile(result: ToolResult): unknown {
  return JSON.parse(
    JSON.stringify({
      isError: result.isError ?? false,
      text: result.content?.map((c) => c.text ?? '').join('\n') ?? '',
      structured: result.structuredContent ?? null,
    }),
    (key, value) => (key === 'elapsedMs' ? null : value),
  );
}

async function callBoth(name: string, args: Record<string, unknown>): Promise<[unknown, unknown]> {
  const viaLocal = (await localClient.callTool({ name, arguments: args })) as ToolResult;
  const viaHttp = (await httpClient.callTool({ name, arguments: args })) as ToolResult;
  return [maskVolatile(viaLocal), maskVolatile(viaHttp)];
}

beforeAll(async () => {
  tmpDir = await mkdtemp(resolve(tmpdir(), 'ok-mcp-parity-'));
  const contentDir = resolve(tmpDir, 'project');
  mkdirSync(contentDir, { recursive: true });
  seedOkScaffold(contentDir);
  writeFileSync(resolve(contentDir, 'alpha.md'), '# Alpha\n\nThe alpha reference doc.\n', 'utf-8');
  writeFileSync(
    resolve(contentDir, 'beta.md'),
    '# Beta\n\nSee [[alpha]] and the missing [[gamma-nowhere]].\n',
    'utf-8',
  );
  writeFileSync(resolve(contentDir, 'del-local.md'), '# Doomed\n\nSame body.\n', 'utf-8');
  writeFileSync(resolve(contentDir, 'del-http.md'), '# Doomed\n\nSame body.\n', 'utf-8');

  booted = await bootServer({
    host: '127.0.0.1',
    config: TEST_CONFIG,
    contentDir,
    port: 0,
    quiet: true,
    gitEnabled: false,
    idleShutdownMs: null,
    attachUiSibling: false,
  });
  await booted.ready;

  // Side MCP endpoint against the SAME server, minus localApi — the pure-HTTP
  // control arm of the comparison.
  httpOnlyMcp = createMcpHttpHandler({
    contentDir: booted.contentDir,
    projectDir: booted.contentDir,
    config: TEST_CONFIG,
    getServerUrl: () => `http://127.0.0.1:${booted.port}`,
  });
  sideServer = createServer((req, res) => {
    void httpOnlyMcp.handle(req, res);
  });
  const sidePort = await new Promise<number>((resolvePort) => {
    sideServer.listen(0, '127.0.0.1', () => {
      resolvePort((sideServer.address() as AddressInfo).port);
    });
  });

  localClient = await connectClient(`http://127.0.0.1:${booted.port}/mcp`, 'parity-suite');
  httpClient = await connectClient(`http://127.0.0.1:${sidePort}/mcp`, 'parity-suite');

  // Wait out the search-index warmup so the read comparisons are stable.
  const deadline = Date.now() + 15_000;
  for (;;) {
    const res = await fetch(`http://127.0.0.1:${booted.port}/api/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'alpha' }),
    });
    const body = (await res.json()) as { ready?: boolean };
    if (body.ready !== false) break;
    if (Date.now() > deadline) throw new Error('search index never became ready');
    await new Promise((r) => setTimeout(r, 250));
  }
}, 60_000);

afterAll(async () => {
  await localClient?.close().catch(() => {});
  await httpClient?.close().catch(() => {});
  await httpOnlyMcp?.close();
  sideServer?.closeAllConnections();
  sideServer?.close();
  await booted?.destroy();
  await rm(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe('MCP local-dispatch transport parity (same server, two sessions)', () => {
  test('collapsed calls never touch the HTTP listener; the control arm does', async () => {
    const apiHits: string[] = [];
    const onRequest = (req: { url?: string }): void => {
      if (req.url?.startsWith('/api/')) apiHits.push(req.url.split('?')[0] ?? '');
    };
    booted.httpServer.on('request', onRequest);
    try {
      await localClient.callTool({ name: 'search', arguments: { query: 'alpha' } });
      expect(apiHits).toEqual([]);
      await httpClient.callTool({ name: 'search', arguments: { query: 'alpha' } });
      expect(apiHits).toEqual(['/api/search']);
    } finally {
      booted.httpServer.off('request', onRequest);
    }
  });

  test('links — backlinks / forward / orphans / hubs / dead in one multi-kind call', async () => {
    const [viaLocal, viaHttp] = await callBoth('links', {
      kind: ['backlinks', 'forward', 'orphans', 'hubs', 'dead'],
      document: 'alpha',
    });
    expect(viaLocal).toEqual(viaHttp);
  });

  test('links — suggest', async () => {
    const [viaLocal, viaHttp] = await callBoth('links', { kind: 'suggest', document: 'alpha' });
    expect(viaLocal).toEqual(viaHttp);
  });

  test('search — success path returns identical hits', async () => {
    const [viaLocal, viaHttp] = await callBoth('search', { query: 'alpha' });
    expect(viaLocal).toEqual(viaHttp);
  });

  test('search — server-side 400 (over-long query) surfaces identically', async () => {
    const [viaLocal, viaHttp] = await callBoth('search', { query: 'x'.repeat(250) });
    expect(viaLocal).toEqual(viaHttp);
    expect((viaLocal as { text: string }).text).toContain('Query is too long (max 200 chars).');
  });

  test('checkpoint — snapshot lands through both transports', async () => {
    const [viaLocal, viaHttp] = await callBoth('checkpoint', {});
    // Each call mints its own checkpoint commit; the SHA is the one
    // legitimately different byte-run between the transports.
    const normalize = (value: unknown): unknown =>
      JSON.parse(JSON.stringify(value).replace(/[0-9a-f]{40}/g, '<sha>'));
    expect(normalize(viaLocal)).toEqual(normalize(viaHttp));
    expect((viaLocal as { text: string }).text).toContain('Checkpoint saved.');
  });

  test('delete — document delete lands with identical response shape', async () => {
    const viaLocal = (await localClient.callTool({
      name: 'delete',
      arguments: { document: 'del-local' },
    })) as ToolResult;
    const viaHttp = (await httpClient.callTool({
      name: 'delete',
      arguments: { document: 'del-http' },
    })) as ToolResult;
    // Different docs (each session deletes its own), so normalize the names
    // before comparing the full response.
    const normalize = (result: ToolResult, doc: string): unknown =>
      JSON.parse(JSON.stringify(maskVolatile(result)).replaceAll(doc, '<doc>'));
    expect(normalize(viaLocal, 'del-local')).toEqual(normalize(viaHttp, 'del-http'));
    expect(viaLocal.isError ?? false).toBe(false);
  });

  test('delete — missing document error surfaces identically', async () => {
    const [viaLocal, viaHttp] = await callBoth('delete', { document: 'never-existed' });
    expect(viaLocal).toEqual(viaHttp);
    expect((viaLocal as { isError: boolean }).isError).toBe(true);
  });

  test('write — asset upload via multipart lands through both transports', async () => {
    const bytesA = Buffer.from('local-transport-bytes-1234567890');
    const bytesB = Buffer.from('http--transport-bytes-1234567890');
    const viaLocal = (await localClient.callTool({
      name: 'write',
      arguments: {
        asset: { path: 'assets/local-side.bin', content: bytesA.toString('base64') },
      },
    })) as ToolResult;
    const viaHttp = (await httpClient.callTool({
      name: 'write',
      arguments: {
        asset: { path: 'assets/http-side.bin', content: bytesB.toString('base64') },
      },
    })) as ToolResult;
    expect(viaLocal.isError ?? false).toBe(false);
    expect(viaHttp.isError ?? false).toBe(false);
    const normalize = (result: ToolResult, name: string): unknown =>
      JSON.parse(JSON.stringify(maskVolatile(result)).replaceAll(name, '<name>'));
    expect(normalize(viaLocal, 'local-side')).toEqual(normalize(viaHttp, 'http-side'));
  });

  test('write — folder create lands through both transports', async () => {
    const viaLocal = (await localClient.callTool({
      name: 'write',
      arguments: { folder: { path: 'made/by-local' } },
    })) as ToolResult;
    const viaHttp = (await httpClient.callTool({
      name: 'write',
      arguments: { folder: { path: 'made/by-httpx' } },
    })) as ToolResult;
    expect(viaLocal.isError ?? false).toBe(false);
    const normalize = (result: ToolResult, leaf: string): unknown =>
      JSON.parse(JSON.stringify(maskVolatile(result)).replaceAll(leaf, '<leaf>'));
    expect(normalize(viaLocal, 'by-local')).toEqual(normalize(viaHttp, 'by-httpx'));
  });

  test('write — folder create conflict (409) surfaces identically', async () => {
    const [viaLocal, viaHttp] = await callBoth('write', { folder: { path: 'made/by-local' } });
    expect(viaLocal).toEqual(viaHttp);
    expect((viaLocal as { isError: boolean }).isError).toBe(true);
  });

  // Deliberately no success-path arms for `/api/skill/import` and
  // `/api/skill/install`: their responses are not deterministic even between
  // two consecutive plain-HTTP calls — the reported bundle `path` and the
  // "now lives at" location ordering depend on editor-host detection against
  // the developer's real home dir and on background projection fan-out
  // timing relative to response assembly. A byte-compare here measures that
  // race, not the transport. Their marshaling (validation, envelopes, error
  // mapping) is pinned by the CI-run handler-level parity suite
  // (`http/local-api-dispatch.test.ts`); the deterministic error path is
  // compared below.
  test('install — unknown skill error surfaces identically', async () => {
    const [viaLocal, viaHttp] = await callBoth('install', {
      name: 'no-such-skill-here',
      add: ['claude'],
    });
    expect(viaLocal).toEqual(viaHttp);
    expect((viaLocal as { isError: boolean }).isError).toBe(true);
  });
});
