import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { setTimeout as wait } from 'node:timers/promises';
import * as Y from 'yjs';
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

function appendParagraph(client: TestClient, text: string): void {
  const paragraph = new Y.XmlElement('paragraph');
  const ytext = new Y.XmlText();
  ytext.applyDelta([{ insert: text }]);
  paragraph.insert(0, [ytext]);
  client.fragment.push([paragraph]);
}

/** Assert convergence: all clients have matching Y.Text and matching fragment,
 *  and bridge invariant holds on each. Uses pollUntil to wait for the full
 *  propagation chain (client → server observer → Y.Text → back to client). */
async function assertConverged(clients: TestClient[], markers: string[]): Promise<void> {
  for (const marker of markers) {
    for (let i = 0; i < clients.length; i++) {
      await pollUntil(() => clients[i].ytext.toString().includes(marker), 5000);
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

describe('C1: concurrent WYSIWYG edits', () => {
  test('two clients append paragraphs — both contributions present on both clients', async () => {
    const clients = await createTestClients(server.port, {
      count: 2,
      perClientOptions: { skipInvariantWatcher: true },
    });
    try {
      appendParagraph(clients[0], 'C1-CLIENT-A-WYSIWYG');
      appendParagraph(clients[1], 'C1-CLIENT-B-WYSIWYG');

      await assertConverged(clients, ['C1-CLIENT-A-WYSIWYG', 'C1-CLIENT-B-WYSIWYG']);

      for (const c of clients) {
        const frag = serializeFragment(c.fragment);
        expect(frag).toContain('C1-CLIENT-A-WYSIWYG');
        expect(frag).toContain('C1-CLIENT-B-WYSIWYG');
      }
    } finally {
      for (const c of clients) await c.cleanup();
    }
  });

  test('three clients append paragraphs — all three contributions converge', async () => {
    const clients = await createTestClients(server.port, {
      count: 3,
      perClientOptions: { skipInvariantWatcher: true },
    });
    try {
      appendParagraph(clients[0], 'C1-THREE-A');
      appendParagraph(clients[1], 'C1-THREE-B');
      appendParagraph(clients[2], 'C1-THREE-C');

      await assertConverged(clients, ['C1-THREE-A', 'C1-THREE-B', 'C1-THREE-C']);
    } finally {
      for (const c of clients) await c.cleanup();
    }
  });

  test('sequential WYSIWYG edits from two clients — no content duplication', async () => {
    const clients = await createTestClients(server.port, {
      count: 2,
      perClientOptions: { skipInvariantWatcher: true },
    });
    try {
      appendParagraph(clients[0], 'C1-SEQ-FIRST');
      await pollUntil(() => clients[1].ytext.toString().includes('C1-SEQ-FIRST'), 5000);

      appendParagraph(clients[1], 'C1-SEQ-SECOND');

      await assertConverged(clients, ['C1-SEQ-FIRST', 'C1-SEQ-SECOND']);

      for (const c of clients) {
        const text = c.ytext.toString();
        const firstCount = text.split('C1-SEQ-FIRST').length - 1;
        const secondCount = text.split('C1-SEQ-SECOND').length - 1;
        expect(firstCount).toBe(1);
        expect(secondCount).toBe(1);
      }
    } finally {
      for (const c of clients) await c.cleanup();
    }
  });

  test('rapid concurrent WYSIWYG appends from two clients converge without loss', async () => {
    const clients = await createTestClients(server.port, {
      count: 2,
      perClientOptions: { skipInvariantWatcher: true },
    });
    try {
      for (let i = 0; i < 3; i++) {
        appendParagraph(clients[0], `C1-RAPID-A-${i}`);
        appendParagraph(clients[1], `C1-RAPID-B-${i}`);
      }

      const markers: string[] = [];
      for (let i = 0; i < 3; i++) {
        markers.push(`C1-RAPID-A-${i}`, `C1-RAPID-B-${i}`);
      }
      await assertConverged(clients, markers);
    } finally {
      for (const c of clients) await c.cleanup();
    }
  });

  test('WYSIWYG heading + paragraph from two clients — structural integrity preserved', async () => {
    const clients = await createTestClients(server.port, {
      count: 2,
      perClientOptions: { skipInvariantWatcher: true },
    });
    try {
      const heading = new Y.XmlElement('heading');
      heading.setAttribute('level', 2);
      const headingText = new Y.XmlText();
      headingText.applyDelta([{ insert: 'C1-HEADING-FROM-A' }]);
      heading.insert(0, [headingText]);
      clients[0].fragment.push([heading]);

      appendParagraph(clients[1], 'C1-PARA-FROM-B');

      await assertConverged(clients, ['C1-HEADING-FROM-A', 'C1-PARA-FROM-B']);

      for (const c of clients) {
        const frag = serializeFragment(c.fragment);
        expect(frag).toContain('## C1-HEADING-FROM-A');
        expect(frag).toContain('C1-PARA-FROM-B');
      }
    } finally {
      for (const c of clients) await c.cleanup();
    }
  });
});
