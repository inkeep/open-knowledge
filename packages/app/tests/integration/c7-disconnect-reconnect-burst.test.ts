
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { setTimeout as wait } from 'node:timers/promises';
import * as Y from 'yjs';
import { HARNESS_BOOT_TIMEOUT_MS } from './harness-boot-timeout';
import {
  agentWriteMd,
  assertBridgeInvariant,
  createTestClient,
  createTestClients,
  createTestServer,
  pollUntil,
  serializeFragment,
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

/** Assert convergence: polls until all markers appear in BOTH Y.Text and
 *  XmlFragment on all clients, then verifies bridge invariant and consistency. */
async function assertConverged(clients: TestClient[], markers: string[]): Promise<void> {
  for (const marker of markers) {
    for (let i = 0; i < clients.length; i++) {
      await pollUntil(
        () =>
          clients[i].ytext.toString().includes(marker) &&
          serializeFragment(clients[i].fragment).includes(marker),
        5000,
      );
    }
  }

  await wait(500);

  for (const c of clients) {
    assertBridgeInvariant(c.ytext, c.fragment);
  }

  const ytexts = clients.map((c) => c.ytext.toString());
  for (let i = 1; i < ytexts.length; i++) {
    expect(ytexts[i]).toBe(ytexts[0]);
  }
}

describe('C7: disconnect-reconnect burst', () => {
  test('two clients pause, edit locally, resume — both edits preserved', async () => {
    const docName = `c7-basic-${crypto.randomUUID()}`;
    const clients = await createTestClients(server.port, {
      count: 2,
      docName,
      perClientOptions: { skipInvariantWatcher: true, syncControl: true },
    });
    try {
      clients[0].pauseSync();
      clients[1].pauseSync();

      appendParagraph(clients[0], 'C7-DISCONNECTED-A');
      appendParagraph(clients[1], 'C7-DISCONNECTED-B');

      await wait(200);

      clients[0].resumeSync();
      clients[1].resumeSync();

      await assertConverged(clients, ['C7-DISCONNECTED-A', 'C7-DISCONNECTED-B']);

      for (const c of clients) {
        const text = c.ytext.toString();
        expect(text.split('C7-DISCONNECTED-A').length - 1).toBe(1);
        expect(text.split('C7-DISCONNECTED-B').length - 1).toBe(1);
      }
    } finally {
      for (const c of clients) await c.cleanup();
    }
  });

  test('three clients disconnect-reconnect with seeded content — seed + all edits survive', async () => {
    const docName = `c7-seeded-${crypto.randomUUID()}`;

    await agentWriteMd(server.port, '# C7 Seeded Doc\n\nBase content here.', {
      docName,
      position: 'replace',
    });
    await wait(500);

    const clients = await createTestClients(server.port, {
      count: 3,
      docName,
      perClientOptions: { skipInvariantWatcher: true, syncControl: true },
    });
    try {
      for (const c of clients) {
        await pollUntil(() => c.ytext.toString().includes('Base content'), 5000);
      }
      await wait(300);

      for (const c of clients) c.pauseSync();

      appendParagraph(clients[0], 'C7-SEEDED-EDIT-A');
      appendParagraph(clients[1], 'C7-SEEDED-EDIT-B');
      appendParagraph(clients[2], 'C7-SEEDED-EDIT-C');

      await wait(200);

      for (const c of clients) c.resumeSync();

      await assertConverged(clients, [
        'C7 Seeded Doc',
        'Base content',
        'C7-SEEDED-EDIT-A',
        'C7-SEEDED-EDIT-B',
        'C7-SEEDED-EDIT-C',
      ]);

      for (const c of clients) {
        const text = c.ytext.toString();
        expect(text.split('Base content').length - 1).toBe(1);
      }
    } finally {
      for (const c of clients) await c.cleanup();
    }
  });

  test('client pauses, agent writes, client resumes — both contributions merged', async () => {
    const docName = `c7-agent-${crypto.randomUUID()}`;
    const client = await createTestClient(server.port, docName, {
      skipInvariantWatcher: true,
      syncControl: true,
    });
    try {
      await agentWriteMd(server.port, '# C7 Agent Test\n\nInitial.', {
        docName,
        position: 'replace',
      });
      await pollUntil(() => client.ytext.toString().includes('Initial'), 5000);
      await wait(500);

      client.pauseSync();

      appendParagraph(client, 'C7-AGENT-CLIENT-EDIT');

      await agentWriteMd(server.port, '\n\nC7-AGENT-SERVER-EDIT\n', {
        docName,
        position: 'append',
      });

      await wait(300);

      client.resumeSync();

      await assertConverged(
        [client],
        ['C7 Agent Test', 'Initial', 'C7-AGENT-CLIENT-EDIT', 'C7-AGENT-SERVER-EDIT'],
      );
    } finally {
      await client.cleanup();
    }
  });

  test('staggered resume — clients resume one at a time with delay between', async () => {
    const docName = `c7-stagger-${crypto.randomUUID()}`;
    const clients = await createTestClients(server.port, {
      count: 3,
      docName,
      perClientOptions: { skipInvariantWatcher: true, syncControl: true },
    });
    try {
      for (const c of clients) c.pauseSync();

      appendParagraph(clients[0], 'C7-STAGGER-A');
      appendParagraph(clients[1], 'C7-STAGGER-B');
      appendParagraph(clients[2], 'C7-STAGGER-C');

      await wait(200);

      clients[0].resumeSync();
      await wait(200);
      clients[1].resumeSync();
      await wait(200);
      clients[2].resumeSync();

      await assertConverged(clients, ['C7-STAGGER-A', 'C7-STAGGER-B', 'C7-STAGGER-C']);
    } finally {
      for (const c of clients) await c.cleanup();
    }
  });

  test('pause-edit-resume cycle repeated twice — no content loss across cycles', async () => {
    const docName = `c7-repeat-${crypto.randomUUID()}`;
    const clients = await createTestClients(server.port, {
      count: 2,
      docName,
      perClientOptions: { skipInvariantWatcher: true, syncControl: true },
    });
    try {
      for (const c of clients) c.pauseSync();

      appendParagraph(clients[0], 'C7-CYCLE1-A');
      appendParagraph(clients[1], 'C7-CYCLE1-B');

      await wait(200);
      for (const c of clients) c.resumeSync();

      await assertConverged(clients, ['C7-CYCLE1-A', 'C7-CYCLE1-B']);

      for (const c of clients) c.pauseSync();

      appendParagraph(clients[0], 'C7-CYCLE2-A');
      appendParagraph(clients[1], 'C7-CYCLE2-B');

      await wait(200);
      for (const c of clients) c.resumeSync();

      await assertConverged(clients, ['C7-CYCLE1-A', 'C7-CYCLE1-B', 'C7-CYCLE2-A', 'C7-CYCLE2-B']);

      for (const c of clients) {
        const text = c.ytext.toString();
        expect(text.split('C7-CYCLE1-A').length - 1).toBe(1);
        expect(text.split('C7-CYCLE2-A').length - 1).toBe(1);
      }
    } finally {
      for (const c of clients) await c.cleanup();
    }
  });
});
