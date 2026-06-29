import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { setTimeout as wait } from 'node:timers/promises';
import * as Y from 'yjs';
import { HARNESS_BOOT_TIMEOUT_MS } from './harness-boot-timeout';
import {
  agentWriteMd,
  assertAllConverged,
  createTestClient,
  createTestClients,
  createTestServer,
  getServerState,
  pollUntil,
  type TestClient,
  type TestServer,
} from './test-harness';

let server: TestServer;

beforeAll(async () => {
  server = await createTestServer();
}, HARNESS_BOOT_TIMEOUT_MS);

afterAll(async () => {
  await server.cleanup();
});

function appendParagraph(client: TestClient, text: string): void {
  const paragraph = new Y.XmlElement('paragraph');
  const ytext = new Y.XmlText();
  ytext.applyDelta([{ insert: text }]);
  paragraph.insert(0, [ytext]);
  client.fragment.push([paragraph]);
}

function appendYtext(client: TestClient, text: string): void {
  const cur = client.ytext.toString();
  client.ytext.insert(cur.length, text);
}

describe('FR-31 bridge watchdog — multi-peer drain', () => {
  test('concurrent ytext + WYSIWYG + agent writes from 3 peers — watchdog stays quiet', async () => {
    const docName = `wd-multi-${crypto.randomUUID()}`;

    const clients = await createTestClients(server.port, {
      count: 3,
      docName,
      perClientOptions: { skipInvariantWatcher: false },
    });

    try {
      await agentWriteMd(server.port, '# Seed\n\nBaseline.\n', {
        docName,
        position: 'replace',
      });
      for (const c of clients) {
        await pollUntil(() => c.ytext.toString().includes('Baseline'), 5000);
      }
      await wait(200);

      appendParagraph(clients[0], 'WD-MULTI-WYSIWYG');
      appendYtext(clients[1], '\n\nWD-MULTI-YTEXT\n');
      await agentWriteMd(server.port, '\n\nWD-MULTI-AGENT\n', {
        docName,
        position: 'append',
      });

      await pollUntil(() => clients[0].ytext.toString().includes('WD-MULTI-AGENT'), 8000);

      await assertAllConverged(clients, { timeout: 8000 });

      const text = clients[0].ytext.toString();
      expect(text).toContain('WD-MULTI-WYSIWYG');
      expect(text).toContain('WD-MULTI-YTEXT');
      expect(text).toContain('WD-MULTI-AGENT');

      const serverState = getServerState(server, docName);
      expect(serverState).toBeTruthy();
    } finally {
      for (const c of clients) await c.cleanup();
    }
  });

  test('drain settles cleanly after a deliberate divergence (recovery test)', async () => {
    const docName = `wd-recover-${crypto.randomUUID()}`;

    const driver = await createTestClient(server.port, docName, {
      skipInvariantWatcher: true,
    });

    try {
      await agentWriteMd(server.port, '# Recovery\n\nSeed.\n', {
        docName,
        position: 'replace',
      });
      await pollUntil(() => driver.ytext.toString().includes('Seed'), 5000);
      await wait(200);

      appendParagraph(driver, 'WD-RECOVER-WYSIWYG');
      appendYtext(driver, '\n\nWD-RECOVER-YTEXT\n');
      await agentWriteMd(server.port, '\n\nWD-RECOVER-AGENT\n', {
        docName,
        position: 'append',
      });

      await pollUntil(
        () =>
          driver.ytext.toString().includes('WD-RECOVER-WYSIWYG') &&
          driver.ytext.toString().includes('WD-RECOVER-YTEXT') &&
          driver.ytext.toString().includes('WD-RECOVER-AGENT'),
        8000,
      );
      await wait(500);

      const watcher = await createTestClient(server.port, docName, {
        skipInvariantWatcher: false,
      });
      try {
        await pollUntil(() => watcher.ytext.toString().includes('WD-RECOVER-WYSIWYG'), 5000);
        await assertAllConverged([driver, watcher], { timeout: 5000 });
      } finally {
        await watcher.cleanup();
      }
    } finally {
      await driver.cleanup();
    }
  });
});
