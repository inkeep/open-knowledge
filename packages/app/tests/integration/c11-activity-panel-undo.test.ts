import { setTimeout as wait } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { listAgentActivity } from '../../../../packages/server/src/agent-activity.ts';
import { HARNESS_BOOT_TIMEOUT_MS } from './harness-boot-timeout';
import type { TestServer } from './test-harness';
import { agentUndo, agentWriteMd, createTestServer } from './test-harness';

let server: TestServer;

beforeAll(async () => {
  server = await createTestServer();
}, HARNESS_BOOT_TIMEOUT_MS);

afterAll(async () => {
  await server.cleanup();
});

async function writeAs(
  agentIdSuffix: string,
  markdown: string,
  docName: string,
  srv: TestServer = server,
): Promise<void> {
  await agentWriteMd(srv.port, markdown, {
    docName,
    agentId: agentIdSuffix,
    agentName: `TestAgent-${agentIdSuffix}`,
  });
}

describe('C11 — Activity Panel undo isolation + CC1 signal', () => {
  test('AC-P4: last-scope undo on fileX pops exactly one StackItem; fileY stack untouched', async () => {
    const docX = `test-c11-p4-x-${crypto.randomUUID()}`;
    const docY = `test-c11-p4-y-${crypto.randomUUID()}`;
    const agentSuffix = `p4-${crypto.randomUUID().slice(0, 8)}`;
    const connectionId = `agent-${agentSuffix}`;
    const sessionManager = server.instance.sessionManager;

    await writeAs(agentSuffix, 'burst 1\n', docX);
    await wait(600);
    await writeAs(agentSuffix, 'burst 2\n', docX);
    await wait(600);
    await writeAs(agentSuffix, 'burst Y\n', docY);
    await wait(400);

    const sessX = await sessionManager.getSession(docX, connectionId);
    const sessY = await sessionManager.getSession(docY, connectionId);

    const stackXBefore = sessX.um.undoStack.length;
    const stackYBefore = sessY.um.undoStack.length;

    expect(stackXBefore).toBeGreaterThanOrEqual(2);
    expect(stackYBefore).toBeGreaterThanOrEqual(1);

    await agentUndo(server.port, { docName: docX, connectionId, scope: 'last' });
    await wait(300);

    expect(sessX.um.undoStack.length).toBe(stackXBefore - 1);
    expect(sessY.um.undoStack.length).toBe(stackYBefore);

    await sessionManager.closeSession(docX, connectionId);
    await sessionManager.closeSession(docY, connectionId);
  });

  test('AC-P5: session/file-scope undo on fileX pops entire stack; fileX reverts; fileY preserved', async () => {
    const docX = `test-c11-p5-x-${crypto.randomUUID()}`;
    const docY = `test-c11-p5-y-${crypto.randomUUID()}`;
    const agentSuffix = `p5-${crypto.randomUUID().slice(0, 8)}`;
    const connectionId = `agent-${agentSuffix}`;
    const sessionManager = server.instance.sessionManager;

    await writeAs(agentSuffix, 'alpha\n', docX);
    await wait(600);
    await writeAs(agentSuffix, 'beta\n', docX);
    await wait(600);
    await writeAs(agentSuffix, 'Y-content\n', docY);
    await wait(400);

    const sessX = await sessionManager.getSession(docX, connectionId);
    const sessY = await sessionManager.getSession(docY, connectionId);
    const ytextX = sessX.dc.document.getText('source');
    const ytextY = sessY.dc.document.getText('source');

    const stackXBefore = sessX.um.undoStack.length;
    const stackYBefore = sessY.um.undoStack.length;

    expect(stackXBefore).toBeGreaterThanOrEqual(2);
    expect(stackYBefore).toBeGreaterThanOrEqual(1);

    await agentUndo(server.port, { docName: docX, connectionId, scope: 'session' });
    await wait(400);

    expect(sessX.um.undoStack.length).toBe(0);

    expect(ytextX.toString().trim()).toBe('');

    expect(sessY.um.undoStack.length).toBe(stackYBefore);
    expect(ytextY.toString()).toContain('Y-content');

    await sessionManager.closeSession(docX, connectionId);
    await sessionManager.closeSession(docY, connectionId);
  });

  test('AC-P6: session undo for A pops only A Items; B + human content survive', async () => {
    const docZ = `test-c11-p6-z-${crypto.randomUUID()}`;
    const agentA = `p6a-${crypto.randomUUID().slice(0, 8)}`;
    const agentB = `p6b-${crypto.randomUUID().slice(0, 8)}`;
    const connectionIdA = `agent-${agentA}`;
    const sessionManager = server.instance.sessionManager;

    await writeAs(agentA, 'A-unique-content\n', docZ);
    await writeAs(agentB, 'B-unique-content\n', docZ);

    const sessA = await sessionManager.getSession(docZ, connectionIdA);
    const ytext = sessA.dc.document.getText('source');
    sessA.dc.document.transact(() => {
      ytext.insert(ytext.length, 'human-unique-content\n');
    });

    await wait(400);

    expect(ytext.toString()).toContain('A-unique-content');
    expect(ytext.toString()).toContain('B-unique-content');
    expect(ytext.toString()).toContain('human-unique-content');

    await agentUndo(server.port, { docName: docZ, connectionId: connectionIdA, scope: 'session' });
    await wait(400);

    const finalText = ytext.toString();

    expect(finalText).not.toContain('A-unique-content');
    expect(finalText).toContain('B-unique-content');
    expect(finalText).toContain('human-unique-content');

    await sessionManager.closeSession(docZ, connectionIdA);
  });

  test('CC1: agent write triggers signal("session-activity") on cc1Broadcaster', async () => {
    const ccServer = await createTestServer({ gitEnabled: true, commitDebounceMs: 200 });

    try {
      const broadcaster = ccServer.instance.cc1Broadcaster;
      if (!broadcaster) throw new Error('cc1Broadcaster unexpectedly null');
      const spy = vi.spyOn(broadcaster, 'signal');

      const docName = `test-c11-cc1-${crypto.randomUUID()}`;
      const agentSuffix = `cc1-${crypto.randomUUID().slice(0, 8)}`;

      await writeAs(agentSuffix, '# CC1 test\n\ncontent\n', docName, ccServer);

      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline) {
        const called = spy.mock.calls.some((args) => args[0] === 'session-activity');
        if (called) break;
        await wait(100);
      }

      const sessionActivityCalls = spy.mock.calls.filter((args) => args[0] === 'session-activity');
      if (sessionActivityCalls.length === 0) {
        const channels = spy.mock.calls.map((args) => args[0]);
        throw new Error(
          `CC1 'session-activity' never fired within 20s. cc1Broadcaster.signal was called ${spy.mock.calls.length} time(s); channels seen: [${channels.join(', ') || 'none'}]. The persistence-debounce -> git-commit -> CC1-debounce chain likely stalled under load.`,
        );
      }
      expect(sessionActivityCalls.length).toBeGreaterThan(0);
    } finally {
      await ccServer.cleanup();
    }
  }, 30_000);

  test('listAgentActivity: no sessions → { sessionAlive: false, agent: null, files: [] }', () => {
    const sessionManager = server.instance.sessionManager;
    const result = listAgentActivity(sessionManager, 'agent-does-not-exist-xyz');
    expect(result).toEqual({ sessionAlive: false, agent: null, files: [] });
  });

  test('listAgentActivity: files ordered by most-recent-burst DESC, bursts by stackIndex DESC', async () => {
    const docFirst = `test-c11-ord-first-${crypto.randomUUID()}`;
    const docSecond = `test-c11-ord-second-${crypto.randomUUID()}`;
    const agentSuffix = `ord-${crypto.randomUUID().slice(0, 8)}`;
    const connectionId = `agent-${agentSuffix}`;
    const sessionManager = server.instance.sessionManager;

    await writeAs(agentSuffix, 'first-doc-burst1\n', docFirst);
    await wait(600);
    await writeAs(agentSuffix, 'second-doc-burst1\n', docSecond);
    await wait(600);
    await writeAs(agentSuffix, 'second-doc-burst2\n', docSecond);
    await wait(400);

    await sessionManager.getSession(docFirst, connectionId);
    await sessionManager.getSession(docSecond, connectionId);

    const result = listAgentActivity(sessionManager, connectionId);

    expect(result.sessionAlive).toBe(true);
    expect(result.files.length).toBeGreaterThanOrEqual(2);

    const fileNames = result.files.map((f) => f.docName);
    const idxFirst = fileNames.indexOf(docFirst);
    const idxSecond = fileNames.indexOf(docSecond);
    expect(idxSecond).toBeLessThan(idxFirst);

    const secondFile = result.files.find((f) => f.docName === docSecond);
    expect(secondFile).toBeDefined();
    if (secondFile && secondFile.bursts.length >= 2) {
      for (let i = 0; i < secondFile.bursts.length - 1; i++) {
        expect(secondFile.bursts[i].stackIndex).toBeGreaterThan(
          secondFile.bursts[i + 1].stackIndex,
        );
      }
    }

    await sessionManager.closeSession(docFirst, connectionId);
    await sessionManager.closeSession(docSecond, connectionId);
  });
});
