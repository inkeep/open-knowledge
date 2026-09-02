import { mkdtempSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { MessageType } from '@hocuspocus/server';
import * as encoding from 'lib0/encoding';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { WebSocket as WsClient } from 'ws';
import { messageYjsUpdate } from 'y-protocols/sync';
import * as Y from 'yjs';
import type { BootedServer } from './boot.ts';
import { bootCompositionRig } from './composition-rig.test-helper.ts';

const MCP_PROTOCOL_VERSION = '2025-06-18';
const JSON_HEADERS = {
  'content-type': 'application/json',
  accept: 'application/json, text/event-stream',
};

async function openMcpSession(base: string): Promise<Record<string, string>> {
  const init = await fetch(base, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'composition-characterization', version: '0.0.0' },
      },
    }),
  });
  expect(init.status).toBe(200);
  const sessionId = init.headers.get('mcp-session-id');
  expect(sessionId).toBeTruthy();
  const headers = {
    ...JSON_HEADERS,
    'mcp-session-id': sessionId as string,
    'mcp-protocol-version': MCP_PROTOCOL_VERSION,
  };
  const notified = await fetch(base, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
  });
  expect(notified.status).toBe(202);
  return headers;
}

function syncFrame(docName: string, update: Uint8Array): Uint8Array {
  const enc = encoding.createEncoder();
  encoding.writeVarString(enc, docName);
  encoding.writeVarUint(enc, MessageType.Sync);
  encoding.writeVarUint(enc, messageYjsUpdate);
  encoding.writeVarUint8Array(enc, update);
  return encoding.toUint8Array(enc);
}

async function openCollab(port: number): Promise<WsClient> {
  const ws = new WsClient(`ws://127.0.0.1:${port}/collab`);
  await new Promise<void>((resolvePromise, reject) => {
    ws.once('open', () => resolvePromise());
    ws.once('error', reject);
  });
  return ws;
}

let tmpRoot: string;
let booted: BootedServer;
let mcpBase: string;

beforeAll(async () => {
  tmpRoot = await mkdtemp(resolve(tmpdir(), 'ok-mcp-collab-'));
  booted = await bootCompositionRig(mkdtempSync(resolve(tmpRoot, 'proj-')));
  await booted.ready;
  mcpBase = `http://127.0.0.1:${booted.port}/mcp`;
}, 60_000);

afterAll(async () => {
  await booted?.destroy();
  await rm(tmpRoot, { recursive: true, force: true });
});

describe('MCP over the composed listener (real handlers, no stubs)', () => {
  test('initialize → tools/list round-trip returns the tool set as plain JSON', async () => {
    const headers = await openMcpSession(mcpBase);
    const list = await fetch(mcpBase, {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
    });
    expect(list.status).toBe(200);
    expect(list.headers.get('content-type')).toContain('application/json');
    const body = (await list.json()) as { result: { tools: Array<{ name: string }> } };
    const names = body.result.tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(['search', 'exec', 'write']));
  }, 30_000);

  test('tools/call write lands a real document, observable over the API', async () => {
    const headers = await openMcpSession(mcpBase);
    const call = await fetch(mcpBase, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          name: 'write',
          arguments: {
            document: { path: 'mcp-written-note', content: 'written via mcp\n' },
          },
        },
      }),
    });
    expect(call.status).toBe(200);
    const body = (await call.json()) as { result?: { isError?: boolean } };
    expect(body.result).toBeDefined();
    expect(body.result?.isError).not.toBe(true);

    const doc = await fetch(
      `http://127.0.0.1:${booted.port}/api/document?docName=mcp-written-note`,
    );
    expect(doc.status).toBe(200);
    const content = ((await doc.json()) as { content: string }).content;
    expect(content).toContain('written via mcp');
  }, 30_000);

  test('no server-initiated streaming surface: sessionless GET /mcp is a 400', async () => {
    const res = await fetch(mcpBase, { method: 'GET', headers: JSON_HEADERS });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('Missing MCP session');
  });
});

describe('collab connection lifecycle over the composed listener', () => {
  test('a raw client joins, hard-drops, and rejoins; each upgrade is admitted and the server survives', async () => {
    const seed = new Y.Doc();
    seed.getText('source').insert(0, 'collab payload\n');
    const update = Y.encodeStateAsUpdate(seed);
    const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

    const ws1 = await openCollab(booted.port);
    let ws1ClosedEarly = false;
    ws1.once('close', () => {
      ws1ClosedEarly = true;
    });
    ws1.send(syncFrame('collab-reconnect-doc', update));
    await settle(300);
    expect(ws1ClosedEarly).toBe(false);

    ws1.terminate();
    await settle(100);

    const ws2 = await openCollab(booted.port);
    let ws2ClosedEarly = false;
    ws2.once('close', () => {
      ws2ClosedEarly = true;
    });
    ws2.send(syncFrame('collab-reconnect-doc', update));
    await settle(300);
    expect(ws2ClosedEarly).toBe(false);
    ws2.terminate();

    const health = await fetch(`http://127.0.0.1:${booted.port}/api/server-info`);
    expect(health.status).toBe(200);
  }, 30_000);
});
