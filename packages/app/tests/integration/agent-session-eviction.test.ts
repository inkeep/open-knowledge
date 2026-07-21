/**
 * LRU-idle session eviction against the real server stack.
 *
 * Proves the piece the unit suite's mock cannot: eviction's teardown is the
 * real `DirectConnection.disconnect`, which stores the doc immediately (not
 * debounced) before unloading — an evicted session's writes reach disk, and
 * a fresh session re-reads them intact.
 *
 * @see packages/server/src/agent-sessions.eviction.test.ts — LRU/floor/undo
 *      semantics on the unit mock
 */

import { randomUUID } from 'node:crypto';
import { AgentSessionManager, applyAgentMarkdownWrite } from '@inkeep/open-knowledge-server';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { HARNESS_BOOT_TIMEOUT_MS } from './harness-boot-timeout';
import type { TestServer } from './test-harness';
import { createTestServer, readTestDoc } from './test-harness';

let server: TestServer;

beforeAll(async () => {
  server = await createTestServer();
}, HARNESS_BOOT_TIMEOUT_MS);

afterAll(async () => {
  await server.cleanup();
});

describe('agent-session LRU eviction (real Hocuspocus + persistence)', () => {
  test('evicted session state is persisted: write, evict under pressure, re-read intact', async () => {
    // A dedicated manager over the SAME hocuspocus instance, with a tiny cap
    // and a zero idle floor so cap pressure evicts deterministically.
    const manager = new AgentSessionManager(server.instance.hocuspocus, {
      maxSessions: 2,
      minEvictableIdleMs: 0,
    });

    const docName = `evict-persist-${randomUUID()}`;
    const content = '# Evicted Doc\n\nBytes written before eviction.\n';

    const session = await manager.getSession(docName, 'agent-evict-int');
    session.dc.document.transact(() => {
      applyAgentMarkdownWrite(session.dc.document, content, 'replace');
    }, session.origin);

    // No manual flush: the eviction path itself must persist. Fill the cap
    // with two more distinct docs — the first create evicts our LRU session
    // and awaits its disconnect, which stores the doc before unload.
    await manager.getSession(`evict-fill-a-${randomUUID()}`, 'agent-evict-int');
    await manager.getSession(`evict-fill-b-${randomUUID()}`, 'agent-evict-int');

    expect(manager.hasSession(docName, 'agent-evict-int')).toBe(false);
    expect(manager.evictionCount).toBeGreaterThanOrEqual(1);

    // The write survived teardown to disk.
    expect(readTestDoc(server.contentDir, docName)).toBe(content);

    // A fresh session sees the persisted bytes and starts with a clean undo
    // stack — the evicted session's stack died with it, never corrupting the
    // successor.
    const fresh = await manager.getSession(docName, 'agent-evict-int');
    expect(fresh.dc.document.getText('source').toString()).toBe(content);
    expect(fresh.um.undoStack.length).toBe(0);
    // Same derived writer identity across the evict/recreate boundary.
    expect(fresh.origin.context.session_id).toBe(session.origin.context.session_id);

    await manager.closeAll();
  });
});
