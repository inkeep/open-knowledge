
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { setTimeout as wait } from 'node:timers/promises';
import { toBroadcasterKey } from '@inkeep/open-knowledge-server';
import type { EffectValue } from '../../../../packages/server/src/activity-log.ts';
import { HARNESS_BOOT_TIMEOUT_MS } from './harness-boot-timeout';
import { createTestClient, createTestServer, type TestServer } from './test-harness.ts';

const MCP_PROTOCOL_VERSION = '2025-06-18';
const CLIENT_NAME = 'Claude';

interface InitializedSession {
  sessionId: string;
  protocolVersion: string;
}

async function openMcpSession(port: number, clientName: string): Promise<InitializedSession> {
  const init = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: {
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: clientName, version: '1.0.0' },
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

interface ToolCallResult {
  content?: Array<{ type: string; text?: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

async function callWriteDocument(
  port: number,
  session: InitializedSession,
  args: {
    docName: string;
    markdown: string;
    position: 'append' | 'prepend' | 'replace';
    cwd: string;
  },
  rpcId: number,
): Promise<ToolCallResult> {
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
      id: rpcId,
      method: 'tools/call',
      params: {
        name: 'write',
        arguments: {
          document: {
            path: args.docName,
            content: args.markdown,
            ...(args.position ? { position: args.position } : {}),
          },
          ...(args.cwd ? { cwd: args.cwd } : {}),
        },
      },
    }),
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { result?: ToolCallResult; error?: unknown };
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

test('two simultaneous Claude MCP sessions land with identical displayName but distinct connectionIds', async () => {
  const sessionA = await openMcpSession(server.port, CLIENT_NAME);
  const sessionB = await openMcpSession(server.port, CLIENT_NAME);

  expect(sessionA.sessionId).not.toBe(sessionB.sessionId);

  const docName = `mcp-id-${randomUUID().slice(0, 8)}`;
  const client = await createTestClient(server.port, docName);
  try {
    const writeA = await callWriteDocument(
      server.port,
      sessionA,
      { docName, markdown: '# Session A\n', position: 'replace', cwd: server.contentDir },
      2,
    );
    expect(writeA.isError ?? false).toBe(false);

    const writeB = await callWriteDocument(
      server.port,
      sessionB,
      { docName, markdown: '\n# Session B\n', position: 'append', cwd: server.contentDir },
      2,
    );
    expect(writeB.isError ?? false).toBe(false);

    await wait(300);

    const effectsMap = client.doc.getMap<EffectValue>('agent-effects');
    const sessionIds = new Set([...effectsMap.values()].map((value) => value.sessionId));
    expect(sessionIds.size).toBe(2);
    for (const sid of sessionIds) {
      expect(sid.startsWith('agent-')).toBe(true);
      expect(sid.slice('agent-'.length)).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      );
    }

    const presenceMap = server.instance.agentPresenceBroadcaster.getPresenceMap();
    const claudeCodeKeys = Object.entries(presenceMap)
      .filter(([, entry]) => entry.displayName === CLIENT_NAME)
      .map(([key]) => key);
    expect(claudeCodeKeys.length).toBe(2);
    expect(new Set(claudeCodeKeys).size).toBe(2);

    for (const key of claudeCodeKeys) {
      expect(key.startsWith('agent-')).toBe(true);
      expect(sessionIds.has(key)).toBe(true);
    }

    for (const sid of sessionIds) {
      expect(toBroadcasterKey(sid)).toBe(sid);
    }
  } finally {
    await client.cleanup();
    await fetch(`http://127.0.0.1:${server.port}/mcp`, {
      method: 'DELETE',
      headers: { 'mcp-session-id': sessionA.sessionId },
    });
    await fetch(`http://127.0.0.1:${server.port}/mcp`, {
      method: 'DELETE',
      headers: { 'mcp-session-id': sessionB.sessionId },
    });
  }
});
