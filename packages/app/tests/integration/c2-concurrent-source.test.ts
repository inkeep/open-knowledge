
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { setTimeout as wait } from 'node:timers/promises';
import { HARNESS_BOOT_TIMEOUT_MS } from './harness-boot-timeout';
import {
  assertBridgeInvariant,
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

/** Assert convergence: all clients have matching Y.Text and matching fragment,
 *  and bridge invariant holds on each. Polls for XmlFragment to contain all
 *  markers (server Observer B must parse Y.Text → XmlFragment). */
async function assertConverged(clients: TestClient[], markers: string[]): Promise<void> {
  for (const marker of markers) {
    for (let i = 0; i < clients.length; i++) {
      await pollUntil(() => serializeFragment(clients[i].fragment).includes(marker), 5000);
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

describe('C2: concurrent source mode edits', () => {
  test('two clients insert at different positions — both contributions present', async () => {
    const clients = await createTestClients(server.port, {
      count: 2,
      perClientOptions: { skipInvariantWatcher: true },
    });
    try {
      clients[0].doc.transact(() => {
        clients[0].ytext.insert(0, '# C2-SOURCE-HEADING-A\n\n');
      });

      clients[1].doc.transact(() => {
        clients[1].ytext.insert(0, 'C2-SOURCE-PARA-B\n\n');
      });

      await assertConverged(clients, ['C2-SOURCE-HEADING-A', 'C2-SOURCE-PARA-B']);
    } finally {
      for (const c of clients) await c.cleanup();
    }
  });

  test('three clients insert distinct paragraphs — all three converge in Y.Text and XmlFragment', async () => {
    const clients = await createTestClients(server.port, {
      count: 3,
      perClientOptions: { skipInvariantWatcher: true },
    });
    try {
      clients[0].doc.transact(() => {
        clients[0].ytext.insert(0, 'C2-THREE-A\n\n');
      });
      clients[1].doc.transact(() => {
        clients[1].ytext.insert(0, 'C2-THREE-B\n\n');
      });
      clients[2].doc.transact(() => {
        clients[2].ytext.insert(0, 'C2-THREE-C\n\n');
      });

      await assertConverged(clients, ['C2-THREE-A', 'C2-THREE-B', 'C2-THREE-C']);
    } finally {
      for (const c of clients) await c.cleanup();
    }
  });

  test('sequential source edits — no XmlFragment duplication', async () => {
    const clients = await createTestClients(server.port, {
      count: 2,
      perClientOptions: { skipInvariantWatcher: true },
    });
    try {
      clients[0].doc.transact(() => {
        clients[0].ytext.insert(0, '# C2-SEQ-FIRST\n\n');
      });
      await pollUntil(() => serializeFragment(clients[1].fragment).includes('C2-SEQ-FIRST'), 5000);

      clients[1].doc.transact(() => {
        clients[1].ytext.insert(clients[1].ytext.length, 'C2-SEQ-SECOND\n\n');
      });

      await assertConverged(clients, ['C2-SEQ-FIRST', 'C2-SEQ-SECOND']);

      for (const c of clients) {
        const frag = serializeFragment(c.fragment);
        const firstCount = frag.split('C2-SEQ-FIRST').length - 1;
        const secondCount = frag.split('C2-SEQ-SECOND').length - 1;
        expect(firstCount).toBe(1);
        expect(secondCount).toBe(1);
      }
    } finally {
      for (const c of clients) await c.cleanup();
    }
  });

  test('rapid concurrent Y.Text appends from two clients converge', async () => {
    const clients = await createTestClients(server.port, {
      count: 2,
      perClientOptions: { skipInvariantWatcher: true },
    });
    try {
      for (let i = 0; i < 3; i++) {
        clients[0].doc.transact(() => {
          clients[0].ytext.insert(clients[0].ytext.length, `C2-RAPID-A-${i}\n\n`);
        });
        clients[1].doc.transact(() => {
          clients[1].ytext.insert(clients[1].ytext.length, `C2-RAPID-B-${i}\n\n`);
        });
      }

      const markers: string[] = [];
      for (let i = 0; i < 3; i++) {
        markers.push(`C2-RAPID-A-${i}`, `C2-RAPID-B-${i}`);
      }
      await assertConverged(clients, markers);
    } finally {
      for (const c of clients) await c.cleanup();
    }
  });

  test('Y.Text char-level co-editing — interleaved appends merge correctly', async () => {
    const clients = await createTestClients(server.port, {
      count: 2,
      perClientOptions: { skipInvariantWatcher: true },
    });
    try {
      clients[0].doc.transact(() => {
        clients[0].ytext.insert(0, '# Title\n\n');
      });

      await pollUntil(() => clients[1].ytext.toString().includes('Title'), 5000);

      clients[0].doc.transact(() => {
        clients[0].ytext.insert(clients[0].ytext.length, 'Alpha content.\n\n');
      });
      clients[1].doc.transact(() => {
        clients[1].ytext.insert(clients[1].ytext.length, 'Beta content.\n\n');
      });

      await assertConverged(clients, ['Title', 'Alpha content', 'Beta content']);
    } finally {
      for (const c of clients) await c.cleanup();
    }
  });
});
