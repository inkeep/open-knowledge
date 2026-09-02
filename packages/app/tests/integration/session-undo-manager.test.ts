import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { HARNESS_BOOT_TIMEOUT_MS } from './harness-boot-timeout';
import { createTestServer, type TestServer } from './test-harness';

let server: TestServer;

beforeAll(async () => {
  server = await createTestServer();
}, HARNESS_BOOT_TIMEOUT_MS);

afterAll(async () => {
  await server.cleanup();
});

describe('US-008: per-session UndoManager integration', () => {
  test('S1.um.undo() reverts only S1 write — S2 write preserved', async () => {
    const docName = `test-um-s1s2-${crypto.randomUUID()}`;
    const sessionManager = server.instance.sessionManager;

    const s1 = await sessionManager.getSession(docName, 'agent-s1');
    const s2 = await sessionManager.getSession(docName, 'agent-s2');

    const ytext = s1.dc.document.getText('source');

    s1.dc.document.transact(() => {
      ytext.insert(0, 'S1 content\n');
    }, s1.origin);

    s2.dc.document.transact(() => {
      ytext.insert(ytext.length, 'S2 content\n');
    }, s2.origin);

    expect(ytext.toString()).toContain('S1 content');
    expect(ytext.toString()).toContain('S2 content');

    expect(s1.um.undoStack.length).toBeGreaterThan(0);
    s1.um.undo();

    expect(ytext.toString()).not.toContain('S1 content');
    expect(ytext.toString()).toContain('S2 content');

    await sessionManager.closeSession(docName, 'agent-s1');
    await sessionManager.closeSession(docName, 'agent-s2');
  });

  test('one transact() on [Y.Text + flashMap] = one undo step', async () => {
    const docName = `test-um-atomic-${crypto.randomUUID()}`;
    const sessionManager = server.instance.sessionManager;

    const session = await sessionManager.getSession(docName, 'agent-atomic');
    const ytext = session.dc.document.getText('source');
    const flashMap = session.dc.document.getMap('agent-flash');

    session.dc.document.transact(() => {
      ytext.insert(0, '---\ntitle: Test\n---\natomic write\n');
      flashMap.set('agent-atomic', { timestamp: Date.now() });
    }, session.origin);

    expect(session.um.undoStack.length).toBe(1);

    session.um.undo();

    expect(ytext.toString()).toBe('');
    expect(flashMap.get('agent-atomic')).toBeUndefined();

    await sessionManager.closeSession(docName, 'agent-atomic');
  });

  test('closeSession() destroys the UM — no longer tracks new writes', async () => {
    const docName = `test-um-destroy-${crypto.randomUUID()}`;
    const sessionManager = server.instance.sessionManager;

    const session = await sessionManager.getSession(docName, 'agent-destroy');
    const ytext = session.dc.document.getText('source');

    session.dc.document.transact(() => {
      ytext.insert(0, 'before destroy\n');
    }, session.origin);
    expect(session.um.undoStack.length).toBeGreaterThan(0);

    const um = session.um;
    const stackLenBeforeClose = um.undoStack.length;

    await sessionManager.closeSession(docName, 'agent-destroy');

    const session2 = await sessionManager.getSession(docName, 'agent-destroy-2');
    const ytext2 = session2.dc.document.getText('source');
    session2.dc.document.transact(() => {
      ytext2.insert(ytext2.length, 'after destroy\n');
    }, session.origin);

    expect(um.undoStack.length).toBe(stackLenBeforeClose);

    await sessionManager.closeSession(docName, 'agent-destroy-2');
  });
});
