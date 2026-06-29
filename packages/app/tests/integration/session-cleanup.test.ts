
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { setTimeout as wait } from 'node:timers/promises';
import { swapContributors } from '@inkeep/open-knowledge-server';
import { HARNESS_BOOT_TIMEOUT_MS } from './harness-boot-timeout';
import type { TestServer } from './test-harness';
import { agentWriteMd, createTestServer } from './test-harness';

const GRACE_MS = 150;

let server: TestServer;

beforeAll(async () => {
  server = await createTestServer({ keepaliveGraceMs: GRACE_MS });
}, HARNESS_BOOT_TIMEOUT_MS);

afterAll(async () => {
  await server.cleanup();
});

function openKeepalive(port: number, connectionId: string): WebSocket {
  const url = `ws://127.0.0.1:${port}/collab/keepalive?connectionId=${encodeURIComponent(connectionId)}&pid=${process.pid}`;
  return new WebSocket(url);
}

describe('Keepalive-WS close cleanup (US-011)', () => {
  test('session removed after grace period on keepalive close', async () => {
    const docName = `test-cleanup-${crypto.randomUUID()}`;
    const rawAgentId = 'mcp-s1';
    const connectionId = `agent-${rawAgentId}`;

    await agentWriteMd(server.port, '# Cleanup Test\n', { docName, agentId: rawAgentId });
    await wait(200);

    expect(server.instance.sessionManager.hasSession(docName, connectionId)).toBe(true);

    const ws = openKeepalive(server.port, connectionId);
    await new Promise<void>((resolve) => {
      ws.addEventListener('open', () => {
        ws.close();
        resolve();
      });
      ws.addEventListener('error', () => resolve());
    });

    await wait(GRACE_MS + 100);

    expect(server.instance.sessionManager.hasSession(docName, connectionId)).toBe(false);
    const focusMap = server.instance.agentFocusBroadcaster?.getFocusMap() ?? {};
    expect(focusMap[connectionId]).toBeUndefined();
  });

  test('reconnect during grace period cancels cleanup', async () => {
    const docName = `test-reconnect-${crypto.randomUUID()}`;
    const rawAgentId = 'mcp-s2';
    const connectionId = `agent-${rawAgentId}`;

    await agentWriteMd(server.port, '# Reconnect Test\n', { docName, agentId: rawAgentId });
    await wait(200);

    expect(server.instance.sessionManager.hasSession(docName, connectionId)).toBe(true);

    const ws1 = openKeepalive(server.port, connectionId);
    await new Promise<void>((resolve) => {
      ws1.addEventListener('open', () => {
        ws1.close();
        resolve();
      });
      ws1.addEventListener('error', () => resolve());
    });

    const ws2 = openKeepalive(server.port, connectionId);
    await new Promise<void>((resolve) => {
      ws2.addEventListener('open', () => resolve());
      ws2.addEventListener('error', () => resolve());
    });

    await wait(GRACE_MS + 100);

    expect(server.instance.sessionManager.hasSession(docName, connectionId)).toBe(true);

    ws2.close();
    await wait(GRACE_MS + 100);

    expect(server.instance.sessionManager.hasSession(docName, connectionId)).toBe(false);
  });

  test('NFR-5 soak: 100 session spawn/close cycles leave sessions Map + agentFocus + pendingContributors empty', async () => {
    const N = 100;
    const soakDoc = `nfr5-${crypto.randomUUID()}`;

    for (let i = 0; i < N; i++) {
      await server.instance.sessionManager.getSession(soakDoc, `agent-soak-${i}`);
    }

    for (let i = 0; i < N; i++) {
      expect(server.instance.sessionManager.hasSession(soakDoc, `agent-soak-${i}`)).toBe(true);
    }

    await server.instance.sessionManager.closeAllForDoc(soakDoc);

    for (let i = 0; i < N; i++) {
      expect(server.instance.sessionManager.hasSession(soakDoc, `agent-soak-${i}`)).toBe(false);
    }

    const focusMap = server.instance.agentFocusBroadcaster.getFocusMap();
    for (let i = 0; i < N; i++) {
      expect(focusMap[`agent-soak-${i}`]).toBeUndefined();
    }

    swapContributors();
  }, 30_000);

  test('keepalive close without connectionId is a no-op for session cleanup', async () => {
    const docName = `test-noop-${crypto.randomUUID()}`;
    const rawAgentId = 'mcp-s3';
    const connectionId = `agent-${rawAgentId}`;

    await agentWriteMd(server.port, '# Noop Test\n', { docName, agentId: rawAgentId });
    await wait(200);

    expect(server.instance.sessionManager.hasSession(docName, connectionId)).toBe(true);

    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/collab/keepalive?pid=${process.pid}`);
    await new Promise<void>((resolve) => {
      ws.addEventListener('open', () => {
        ws.close();
        resolve();
      });
      ws.addEventListener('error', () => resolve());
    });

    await wait(GRACE_MS + 100);

    expect(server.instance.sessionManager.hasSession(docName, connectionId)).toBe(true);

    await server.instance.sessionManager.closeSession(docName, connectionId);
  });
});
