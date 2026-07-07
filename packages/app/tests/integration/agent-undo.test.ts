/**
 * Agent-undo integration tests — multi-client per-session undo.
 *
 * Verifies:
 *   1. Claude-1 writes section A, Claude-2 writes section B, undo for
 *      Claude-2 reverts section B without affecting section A.
 *   2. Bridge invariant holds on all clients after convergence.
 *   3. isPairedWriteOrigin(session.undoOrigin) === true (observer short-circuit).
 *
 * @see packages/server/src/agent-sessions.ts applyAgentUndo
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { setTimeout as wait } from 'node:timers/promises';
import { HARNESS_BOOT_TIMEOUT_MS } from './harness-boot-timeout';
import type { TestServer } from './test-harness';
import { assertBridgeInvariant, createTestClient, createTestServer } from './test-harness';

let server: TestServer;

beforeAll(async () => {
  server = await createTestServer();
}, HARNESS_BOOT_TIMEOUT_MS);

afterAll(async () => {
  await server.cleanup();
});

/** Write markdown as a specific agent (distinct connectionId per agentId suffix). */
async function agentWriteAs(
  port: number,
  agentIdSuffix: string,
  markdown: string,
  docName: string,
): Promise<void> {
  const res = await fetch(`http://127.0.0.1:${port}/api/agent-write-md`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      markdown,
      position: 'append',
      docName,
      agentId: agentIdSuffix,
      agentName: `TestAgent-${agentIdSuffix}`,
    }),
  });
  if (!res.ok) throw new Error(`agent-write-md failed for ${agentIdSuffix}: ${res.status}`);
}

/** POST to /api/agent-undo for a specific connectionId. */
async function agentUndoFor(
  port: number,
  docName: string,
  connectionId: string,
  scope: 'last' | 'session' = 'last',
): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/api/agent-undo`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ docName, connectionId, scope }),
  });
}

describe('Agent undo — V0-14 per-session', () => {
  test('multi-client: Claude-2 undo reverts section B without affecting Claude-1 section A', async () => {
    const docName = `test-undo-${crypto.randomUUID()}`;
    const client = await createTestClient(server.port, docName);

    try {
      // Session 1 writes section A.
      await agentWriteAs(server.port, 's1', '## Section A\n\nclaude-1 content\n', docName);
      // Session 2 writes section B.
      await agentWriteAs(server.port, 's2', '## Section B\n\nclaude-2 content\n', docName);

      // Wait for CRDT sync to settle.
      await wait(600);

      // Verify both sections exist before undo.
      expect(client.ytext.toString()).toContain('Section A');
      expect(client.ytext.toString()).toContain('claude-1 content');
      expect(client.ytext.toString()).toContain('Section B');
      expect(client.ytext.toString()).toContain('claude-2 content');

      // connectionId for s2: extractAgentIdentity prefixes agentId with 'agent-'
      const s2ConnectionId = 'agent-s2';
      const undoRes = await agentUndoFor(server.port, docName, s2ConnectionId, 'last');
      expect(undoRes.ok).toBe(true);

      // Wait for undo + CRDT propagation to settle.
      await wait(600);

      const finalText = client.ytext.toString();

      // Section A (Claude-1) must be preserved.
      expect(finalText).toContain('Section A');
      expect(finalText).toContain('claude-1 content');

      // Section B (Claude-2) must be reverted.
      expect(finalText).not.toContain('claude-2 content');

      // Bridge invariant must hold.
      assertBridgeInvariant(client.ytext, client.fragment);
    } finally {
      await client.cleanup();
    }
  });

  test('undo returns 404 when no active session for connectionId', async () => {
    const docName = `test-undo-404-${crypto.randomUUID()}`;
    const res = await agentUndoFor(server.port, docName, 'agent-nonexistent', 'last');
    expect(res.status).toBe(404);
  });

  test("scope='session' drains the entire UM stack across multiple writes", async () => {
    const docName = `test-undo-session-${crypto.randomUUID()}`;
    const client = await createTestClient(server.port, docName);

    try {
      // Three writes as the same session, each spaced > UM captureTimeout (500ms)
      // so each lands as its own UM stack frame.
      await agentWriteAs(server.port, 'drain', '## Frame 1\n\nfirst\n', docName);
      await wait(700);
      await agentWriteAs(server.port, 'drain', '## Frame 2\n\nsecond\n', docName);
      await wait(700);
      await agentWriteAs(server.port, 'drain', '## Frame 3\n\nthird\n', docName);
      await wait(700);

      // Sanity: all three frames landed.
      const before = client.ytext.toString();
      expect(before).toContain('first');
      expect(before).toContain('second');
      expect(before).toContain('third');

      // scope='session' should pop every frame in one call.
      const connectionId = 'agent-drain';
      const res = await agentUndoFor(server.port, docName, connectionId, 'session');
      expect(res.ok).toBe(true);
      const body = (await res.json()) as { undone?: boolean };
      expect(body.undone).toBe(true);

      await wait(600);

      const after = client.ytext.toString();
      // All session content must be reverted.
      expect(after).not.toContain('first');
      expect(after).not.toContain('second');
      expect(after).not.toContain('third');

      // Second drain on an already-empty stack is a no-op.
      const res2 = await agentUndoFor(server.port, docName, connectionId, 'session');
      expect(res2.ok).toBe(true);
      const body2 = (await res2.json()) as { undone?: boolean };
      expect(body2.undone).toBe(false);

      assertBridgeInvariant(client.ytext, client.fragment);
    } finally {
      await client.cleanup();
    }
  });

  test('undo is a no-op when UM stack is empty', async () => {
    const docName = `test-undo-empty-${crypto.randomUUID()}`;
    // Create a session by writing.
    await agentWriteAs(server.port, 'snoop', '# content\n', docName);
    await wait(400);

    const s1ConnectionId = 'agent-snoop';
    // First undo should revert the write.
    const res1 = await agentUndoFor(server.port, docName, s1ConnectionId, 'last');
    expect(res1.ok).toBe(true);

    await wait(400);

    // Second undo on empty stack should still return 200 (no-op).
    const res2 = await agentUndoFor(server.port, docName, s1ConnectionId, 'last');
    expect(res2.ok).toBe(true);
  });

  test('session.undoOrigin is a real PairedWriteOrigin (observer short-circuit)', async () => {
    const docName = `test-undo-origin-${crypto.randomUUID()}`;
    // Create a session via the manager so we inspect the real frozen origin,
    // not a hand-constructed literal. isPairedWriteOrigin is a structural
    // check (context.paired === true) used by server-observers to short-circuit.
    const sessionManager = server.instance.sessionManager;
    const session = await sessionManager.getSession(docName, 'undo-origin-test', {
      clientName: 'claude-code',
    });

    try {
      expect(session.undoOrigin).toBeDefined();
      expect(session.undoOrigin.source).toBe('local');

      const ctx = (session.undoOrigin as { context?: Record<string, unknown> }).context;
      expect(ctx).toBeDefined();
      expect(ctx?.origin).toBe('agent-undo');
      expect(ctx?.paired).toBe(true);
      expect(Object.isFrozen(ctx)).toBe(true);
      expect(Object.isFrozen(session.undoOrigin)).toBe(true);

      // session.origin (write) and session.undoOrigin (undo) must be distinct
      // object refs so the UndoManager's captureTransaction filter can
      // distinguish undo-of-undo from the write it reverts.
      expect(session.undoOrigin).not.toBe(session.origin);
    } finally {
      await sessionManager.closeAllForAgent('undo-origin-test');
    }
  });
});
