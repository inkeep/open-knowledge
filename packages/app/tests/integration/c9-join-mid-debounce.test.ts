import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { setTimeout as wait } from 'node:timers/promises';
import * as Y from 'yjs';
import { HARNESS_BOOT_TIMEOUT_MS } from './harness-boot-timeout';
import {
  agentWriteMd,
  assertBridgeInvariant,
  createTestClient,
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

describe('C9: join mid-debounce', () => {
  test('client joins after WYSIWYG edit, before debounce fires — receives full content', async () => {
    const docName = `c9-basic-${crypto.randomUUID()}`;

    const clientA = await createTestClient(server.port, docName, { skipInvariantWatcher: true });
    try {
      appendParagraph(clientA, 'C9-EXISTING-EDIT');

      const clientB = await createTestClient(server.port, docName, { skipInvariantWatcher: true });
      try {
        await assertConverged([clientA, clientB], ['C9-EXISTING-EDIT']);

        const textA = clientA.ytext.toString();
        const textB = clientB.ytext.toString();
        expect(textA.split('C9-EXISTING-EDIT').length - 1).toBe(1);
        expect(textB.split('C9-EXISTING-EDIT').length - 1).toBe(1);
      } finally {
        await clientB.cleanup();
      }
    } finally {
      await clientA.cleanup();
    }
  });

  test('client joins during rapid WYSIWYG edits — converges after edits settle', async () => {
    const docName = `c9-rapid-${crypto.randomUUID()}`;

    const clientA = await createTestClient(server.port, docName, { skipInvariantWatcher: true });
    try {
      appendParagraph(clientA, 'C9-RAPID-1');
      appendParagraph(clientA, 'C9-RAPID-2');

      const clientB = await createTestClient(server.port, docName, { skipInvariantWatcher: true });
      try {
        appendParagraph(clientA, 'C9-RAPID-3');

        await assertConverged([clientA, clientB], ['C9-RAPID-1', 'C9-RAPID-2', 'C9-RAPID-3']);
      } finally {
        await clientB.cleanup();
      }
    } finally {
      await clientA.cleanup();
    }
  });

  test('client joins after agent write, before bridge settles — receives agent content', async () => {
    const docName = `c9-agent-${crypto.randomUUID()}`;

    await agentWriteMd(server.port, '# C9 Agent Join\n\nC9-AGENT-SEEDED-CONTENT\n', {
      docName,
      position: 'replace',
    });

    await wait(100);

    const client = await createTestClient(server.port, docName, { skipInvariantWatcher: true });
    try {
      await assertConverged([client], ['C9 Agent Join', 'C9-AGENT-SEEDED-CONTENT']);
    } finally {
      await client.cleanup();
    }
  });

  test('two clients exist, third joins mid-debounce — all three converge', async () => {
    const docName = `c9-three-${crypto.randomUUID()}`;

    const clientA = await createTestClient(server.port, docName, { skipInvariantWatcher: true });
    const clientB = await createTestClient(server.port, docName, { skipInvariantWatcher: true });
    try {
      appendParagraph(clientA, 'C9-THREE-FROM-A');
      appendParagraph(clientB, 'C9-THREE-FROM-B');

      const clientC = await createTestClient(server.port, docName, { skipInvariantWatcher: true });
      try {
        await assertConverged([clientA, clientB, clientC], ['C9-THREE-FROM-A', 'C9-THREE-FROM-B']);
      } finally {
        await clientC.cleanup();
      }
    } finally {
      await clientA.cleanup();
      await clientB.cleanup();
    }
  });

  test('client joins after WYSIWYG + source edits — sees both representations', async () => {
    const docName = `c9-mixed-${crypto.randomUUID()}`;

    const clientA = await createTestClient(server.port, docName, { skipInvariantWatcher: true });
    try {
      appendParagraph(clientA, 'C9-MIXED-WYSIWYG');

      await pollUntil(() => clientA.ytext.toString().includes('C9-MIXED-WYSIWYG'), 5000);
      await wait(200);

      clientA.doc.transact(() => {
        clientA.ytext.insert(clientA.ytext.length, '\n\nC9-MIXED-SOURCE\n');
      });

      const clientB = await createTestClient(server.port, docName, { skipInvariantWatcher: true });
      try {
        await assertConverged([clientA, clientB], ['C9-MIXED-WYSIWYG', 'C9-MIXED-SOURCE']);
      } finally {
        await clientB.cleanup();
      }
    } finally {
      await clientA.cleanup();
    }
  });

  test('late joiner makes own edit — contributes to converged state', async () => {
    const docName = `c9-joiner-edits-${crypto.randomUUID()}`;

    const clientA = await createTestClient(server.port, docName, { skipInvariantWatcher: true });
    try {
      appendParagraph(clientA, 'C9-JOINER-ORIGINAL');

      const clientB = await createTestClient(server.port, docName, { skipInvariantWatcher: true });
      try {
        await pollUntil(() => clientB.ytext.toString().includes('C9-JOINER-ORIGINAL'), 5000);
        await wait(300);

        appendParagraph(clientB, 'C9-JOINER-CONTRIBUTION');

        await assertConverged([clientA, clientB], ['C9-JOINER-ORIGINAL', 'C9-JOINER-CONTRIBUTION']);

        for (const c of [clientA, clientB]) {
          const text = c.ytext.toString();
          expect(text.split('C9-JOINER-ORIGINAL').length - 1).toBe(1);
          expect(text.split('C9-JOINER-CONTRIBUTION').length - 1).toBe(1);
        }
      } finally {
        await clientB.cleanup();
      }
    } finally {
      await clientA.cleanup();
    }
  });

  test('sequential join-leave-join cycle — second joiner gets accumulated state', async () => {
    const docName = `c9-rejoin-${crypto.randomUUID()}`;

    const clientA = await createTestClient(server.port, docName, { skipInvariantWatcher: true });
    try {
      appendParagraph(clientA, 'C9-REJOIN-PHASE1');

      const clientB1 = await createTestClient(server.port, docName, { skipInvariantWatcher: true });
      try {
        await assertConverged([clientA, clientB1], ['C9-REJOIN-PHASE1']);

        appendParagraph(clientB1, 'C9-REJOIN-B1-EDIT');
        await assertConverged([clientA, clientB1], ['C9-REJOIN-PHASE1', 'C9-REJOIN-B1-EDIT']);
      } finally {
        clientB1.provider.destroy();
        clientB1.doc.destroy();
      }

      await wait(300);

      appendParagraph(clientA, 'C9-REJOIN-PHASE2');

      const clientB2 = await createTestClient(server.port, docName, { skipInvariantWatcher: true });
      try {
        await assertConverged(
          [clientA, clientB2],
          ['C9-REJOIN-PHASE1', 'C9-REJOIN-B1-EDIT', 'C9-REJOIN-PHASE2'],
        );
      } finally {
        await clientB2.cleanup();
      }
    } finally {
      await clientA.cleanup();
    }
  });
});
