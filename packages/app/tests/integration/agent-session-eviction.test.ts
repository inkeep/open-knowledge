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

    await manager.getSession(`evict-fill-a-${randomUUID()}`, 'agent-evict-int');
    await manager.getSession(`evict-fill-b-${randomUUID()}`, 'agent-evict-int');

    expect(manager.hasSession(docName, 'agent-evict-int')).toBe(false);
    expect(manager.evictionCount).toBeGreaterThanOrEqual(1);

    expect(readTestDoc(server.contentDir, docName)).toBe(content);

    const fresh = await manager.getSession(docName, 'agent-evict-int');
    expect(fresh.dc.document.getText('source').toString()).toBe(content);
    expect(fresh.um.undoStack.length).toBe(0);
    expect(fresh.origin.context.session_id).toBe(session.origin.context.session_id);

    await manager.closeAll();
  });
});
