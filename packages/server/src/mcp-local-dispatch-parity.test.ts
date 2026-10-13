import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { OK_DIR } from '@inkeep/open-knowledge-core';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { BootedServer } from './boot.ts';
import {
  type DualTransportMcpRig,
  startDualTransportMcpRig,
} from './mcp-dual-transport-rig.test-helper.ts';

let rig: DualTransportMcpRig | undefined;
let booted: BootedServer;
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
  rig = await startDualTransportMcpRig({
    tmpPrefix: 'ok-mcp-parity-',
    clientName: 'parity-suite',
    seed: (contentDir) => {
      seedOkScaffold(contentDir);
      writeFileSync(
        resolve(contentDir, 'alpha.md'),
        '# Alpha\n\nThe alpha reference doc.\n',
        'utf-8',
      );
      writeFileSync(
        resolve(contentDir, 'beta.md'),
        '# Beta\n\nSee [[alpha]] and the missing [[gamma-nowhere]].\n',
        'utf-8',
      );
      writeFileSync(resolve(contentDir, 'del-local.md'), '# Doomed\n\nSame body.\n', 'utf-8');
      writeFileSync(resolve(contentDir, 'del-http.md'), '# Doomed\n\nSame body.\n', 'utf-8');
    },
  });
  ({ booted, localClient, httpClient } = rig);

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
  await rig?.close();
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

  test('install — unknown skill error surfaces identically', async () => {
    const [viaLocal, viaHttp] = await callBoth('install', {
      name: 'no-such-skill-here',
      add: ['claude'],
    });
    expect(viaLocal).toEqual(viaHttp);
    expect((viaLocal as { isError: boolean }).isError).toBe(true);
  });
});
