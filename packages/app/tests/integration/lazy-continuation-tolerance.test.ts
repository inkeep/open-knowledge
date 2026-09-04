import { setTimeout as wait } from 'node:timers/promises';
import { describe, expect, test } from 'vitest';
import * as Y from 'yjs';
import {
  agentWriteMd,
  assertBridgeInvariant,
  awaitDocQuiescence,
  classifyFinalState,
  createTestClients,
  createTestServer,
} from './test-harness';

describe('paragraph lazy-continuation indent — doc settles within tolerance', () => {
  test('leading-space continuation line converges and the invariant holds', async () => {
    const server = await createTestServer();
    const docName = `stall-repro-${Date.now()}`;
    try {
      await agentWriteMd(server.port, 'seed paragraph\n', { docName, position: 'replace' });
      await wait(200);
      const clients = await createTestClients(server.port, {
        count: 2,
        docName,
        perClientOptions: { skipInvariantWatcher: true },
      });
      const [c0, c1] = clients;
      try {
        c0.doc.transact(() => {
          c0.ytext.insert(c0.ytext.length, '\n\npara two\n continuation text');
        });
        await awaitDocQuiescence(c0.doc, { timeoutMs: 3000 });
        await wait(300);
        await Promise.all(clients.map((c) => awaitDocQuiescence(c.doc, { timeoutMs: 3000 })));

        const paragraph = new Y.XmlElement('paragraph');
        const t = new Y.XmlText();
        t.applyDelta([{ insert: 'healer edit' }]);
        paragraph.insert(0, [t]);
        c1.fragment.push([paragraph]);
        await Promise.all(clients.map((c) => awaitDocQuiescence(c.doc, { timeoutMs: 3000 })));
        await wait(300);

        const outcome = classifyFinalState(clients);
        expect(outcome.outcome).toBe('converged-late');
        for (const c of clients) {
          assertBridgeInvariant(c.ytext, c.fragment);
        }
        const finalText = c0.ytext.toString();
        expect(finalText).toContain('\n continuation text');
        expect(finalText).toContain('healer edit');
        expect(finalText.split('continuation text').length - 1).toBe(1);
      } finally {
        for (const c of clients) await c.cleanup();
      }
    } finally {
      await server.cleanup();
    }
  }, 30_000);
});
