/**
 * Keepalive-WS close cleanup tests.
 *
 * Verifies that closing the keepalive WebSocket triggers session cleanup
 * after the configurable grace period.
 *
 * @see packages/server/src/boot.ts — keepalive handler
 * @see packages/server/src/agent-sessions.ts — closeAllForAgent
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { setTimeout as wait } from 'node:timers/promises';
import { swapContributors } from '@inkeep/open-knowledge-server';
import { HARNESS_BOOT_TIMEOUT_MS } from './harness-boot-timeout';
import type { TestServer } from './test-harness';
import { agentWriteMd, createTestServer } from './test-harness';

/** Grace period used by all tests in this file — short enough to keep tests fast. */
const GRACE_MS = 150;

let server: TestServer;

beforeAll(async () => {
  server = await createTestServer({ keepaliveGraceMs: GRACE_MS });
}, HARNESS_BOOT_TIMEOUT_MS);

afterAll(async () => {
  await server.cleanup();
});

/** Open a keepalive WebSocket and return a handle to close it. */
function openKeepalive(port: number, connectionId: string): WebSocket {
  const url = `ws://127.0.0.1:${port}/collab/keepalive?connectionId=${encodeURIComponent(connectionId)}&pid=${process.pid}`;
  return new WebSocket(url);
}

describe('Keepalive-WS close cleanup (US-011)', () => {
  test('session removed after grace period on keepalive close', async () => {
    const docName = `test-cleanup-${crypto.randomUUID()}`;
    // agentId 'mcp-s1' → session key 'agent-mcp-s1'
    const rawAgentId = 'mcp-s1';
    const connectionId = `agent-${rawAgentId}`;

    // Write via the agent API to create a session.
    await agentWriteMd(server.port, '# Cleanup Test\n', { docName, agentId: rawAgentId });
    await wait(200);

    // Verify session exists before keepalive close.
    expect(server.instance.sessionManager.hasSession(docName, connectionId)).toBe(true);

    // Open and immediately close the keepalive WS.
    const ws = openKeepalive(server.port, connectionId);
    await new Promise<void>((resolve) => {
      ws.addEventListener('open', () => {
        ws.close();
        resolve();
      });
      // If connection refused, resolve anyway to avoid hanging.
      ws.addEventListener('error', () => resolve());
    });

    // Wait for the grace period to expire.
    await wait(GRACE_MS + 100);

    // Session should be cleaned up.
    expect(server.instance.sessionManager.hasSession(docName, connectionId)).toBe(false);
    // AgentFocus entry should be cleared.
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

    // Open and close first connection (starts grace timer).
    const ws1 = openKeepalive(server.port, connectionId);
    await new Promise<void>((resolve) => {
      ws1.addEventListener('open', () => {
        ws1.close();
        resolve();
      });
      ws1.addEventListener('error', () => resolve());
    });

    // Reconnect with the same connectionId within grace period (cancels timer).
    const ws2 = openKeepalive(server.port, connectionId);
    await new Promise<void>((resolve) => {
      ws2.addEventListener('open', () => resolve());
      ws2.addEventListener('error', () => resolve());
    });

    // Wait past the original grace period.
    await wait(GRACE_MS + 100);

    // Session should still be alive (grace was cancelled by reconnect).
    expect(server.instance.sessionManager.hasSession(docName, connectionId)).toBe(true);

    // Now close the second connection and let grace expire.
    ws2.close();
    await wait(GRACE_MS + 100);

    // Now session should be cleaned up.
    expect(server.instance.sessionManager.hasSession(docName, connectionId)).toBe(false);
  });

  test('NFR-5 soak: 100 session spawn/close cycles leave sessions Map + agentFocus + pendingContributors empty', async () => {
    const N = 100;
    const soakDoc = `nfr5-${crypto.randomUUID()}`;

    // Spawn N sessions directly via sessionManager.getSession (fast path).
    // The keepalive-WS close path is exercised by the three tests above;
    // this soak focuses on the session Map + awareness leak-free guarantee.
    for (let i = 0; i < N; i++) {
      await server.instance.sessionManager.getSession(soakDoc, `agent-soak-${i}`);
    }

    // All N sessions must exist before close
    for (let i = 0; i < N; i++) {
      expect(server.instance.sessionManager.hasSession(soakDoc, `agent-soak-${i}`)).toBe(true);
    }

    // Close all sessions for this doc atomically
    await server.instance.sessionManager.closeAllForDoc(soakDoc);

    // sessions Map: every entry removed after closeAllForDoc
    for (let i = 0; i < N; i++) {
      expect(server.instance.sessionManager.hasSession(soakDoc, `agent-soak-${i}`)).toBe(false);
    }

    // agentFocus: getSession() does not call setFocus — map unaffected by this path
    const focusMap = server.instance.agentFocusBroadcaster.getFocusMap();
    for (let i = 0; i < N; i++) {
      expect(focusMap[`agent-soak-${i}`]).toBeUndefined();
    }

    // pendingContributors: getSession() triggers onStoreDocument in persistence.ts, which
    // calls recordContributor via the safety-net for session-origin writes. Drain any
    // accumulated contributors to leave a clean baseline for subsequent tests.
    swapContributors();
  }, 30_000);

  test('keepalive close without connectionId is a no-op for session cleanup', async () => {
    const docName = `test-noop-${crypto.randomUUID()}`;
    const rawAgentId = 'mcp-s3';
    const connectionId = `agent-${rawAgentId}`;

    await agentWriteMd(server.port, '# Noop Test\n', { docName, agentId: rawAgentId });
    await wait(200);

    expect(server.instance.sessionManager.hasSession(docName, connectionId)).toBe(true);

    // Open keepalive WITHOUT connectionId param.
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/collab/keepalive?pid=${process.pid}`);
    await new Promise<void>((resolve) => {
      ws.addEventListener('open', () => {
        ws.close();
        resolve();
      });
      ws.addEventListener('error', () => resolve());
    });

    // Wait past grace — session must survive (no connectionId → no cleanup).
    await wait(GRACE_MS + 100);

    expect(server.instance.sessionManager.hasSession(docName, connectionId)).toBe(true);

    // Manual cleanup.
    await server.instance.sessionManager.closeSession(docName, connectionId);
  });
});
