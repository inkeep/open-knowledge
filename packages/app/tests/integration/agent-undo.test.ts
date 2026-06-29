
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
      await agentWriteAs(server.port, 's1', '## Section A\n\nclaude-1 content\n', docName);
      await agentWriteAs(server.port, 's2', '## Section B\n\nclaude-2 content\n', docName);

      await wait(600);

      expect(client.ytext.toString()).toContain('Section A');
      expect(client.ytext.toString()).toContain('claude-1 content');
      expect(client.ytext.toString()).toContain('Section B');
      expect(client.ytext.toString()).toContain('claude-2 content');

      const s2ConnectionId = 'agent-s2';
      const undoRes = await agentUndoFor(server.port, docName, s2ConnectionId, 'last');
      expect(undoRes.ok).toBe(true);

      await wait(600);

      const finalText = client.ytext.toString();

      expect(finalText).toContain('Section A');
      expect(finalText).toContain('claude-1 content');

      expect(finalText).not.toContain('claude-2 content');

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
      await agentWriteAs(server.port, 'drain', '## Frame 1\n\nfirst\n', docName);
      await wait(700);
      await agentWriteAs(server.port, 'drain', '## Frame 2\n\nsecond\n', docName);
      await wait(700);
      await agentWriteAs(server.port, 'drain', '## Frame 3\n\nthird\n', docName);
      await wait(700);

      const before = client.ytext.toString();
      expect(before).toContain('first');
      expect(before).toContain('second');
      expect(before).toContain('third');

      const connectionId = 'agent-drain';
      const res = await agentUndoFor(server.port, docName, connectionId, 'session');
      expect(res.ok).toBe(true);
      const body = (await res.json()) as { undone?: boolean };
      expect(body.undone).toBe(true);

      await wait(600);

      const after = client.ytext.toString();
      expect(after).not.toContain('first');
      expect(after).not.toContain('second');
      expect(after).not.toContain('third');

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
    await agentWriteAs(server.port, 'snoop', '# content\n', docName);
    await wait(400);

    const s1ConnectionId = 'agent-snoop';
    const res1 = await agentUndoFor(server.port, docName, s1ConnectionId, 'last');
    expect(res1.ok).toBe(true);

    await wait(400);

    const res2 = await agentUndoFor(server.port, docName, s1ConnectionId, 'last');
    expect(res2.ok).toBe(true);
  });

  test('session.undoOrigin is a real PairedWriteOrigin (observer short-circuit)', async () => {
    const docName = `test-undo-origin-${crypto.randomUUID()}`;
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

      expect(session.undoOrigin).not.toBe(session.origin);
    } finally {
      await sessionManager.closeAllForAgent('undo-origin-test');
    }
  });
});
