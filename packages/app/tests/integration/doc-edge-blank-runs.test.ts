/**
 * Blank runs the user authors at the LEADING or TRAILING edge of a document.
 *
 * The interior case has its own suite. This one covers the two ends, where the
 * gesture is identical from the user's side — hold Enter at the top or the
 * bottom of the page — but the bytes take a different route to `Y.Text` and to
 * disk, and never arrive.
 *
 * Multi-client on purpose: the server is the sole fragment writer, so a run
 * that is only ever held in the authoring client's own fragment looks correct
 * to that client for as long as nothing re-derives. Two real WebSocket peers
 * make "reached the source bytes" and "survived a re-derive" separable, which
 * single-client coverage cannot do.
 *
 * Every assertion is raw-byte. The bridge comparator collapses three-or-more
 * newlines on both sides, so a `toContain` or a `startsWith` would sit inside
 * the tolerance and pass on a document that lost the run it is about.
 */

import { setTimeout as wait } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import * as Y from 'yjs';
import { HARNESS_BOOT_TIMEOUT_MS } from './harness-boot-timeout';
import {
  agentWriteMd,
  createTestClients,
  createTestServer,
  pollUntil,
  readTestDoc,
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

/** What pressing Enter mints in the WYSIWYG: a top-level empty paragraph. */
const para = () => new Y.XmlElement('paragraph');

/** Top-level children of a fragment that hold no text — the blank lines. */
function countBlankLineNodes(fragment: Y.XmlFragment): number {
  let count = 0;
  for (let i = 0; i < fragment.length; i++) {
    if (String(fragment.get(i)) === '<paragraph></paragraph>') count += 1;
  }
  return count;
}

/**
 * Wait for the settled state, returning quietly if it never arrives.
 *
 * The `expect` that follows is the oracle. A throwing poll would report a
 * document that never converged as a harness error and hide which bytes are
 * actually wrong, so the budget is spent here and the diagnosis is left to the
 * byte comparison.
 */
async function settle(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await wait(25);
  }
}

/**
 * A converged two-peer document holding exactly `raw`, seeded through the
 * agent byte-writer. Seeds carry no edge run of their own, so this poll
 * settles identically before and after the fix.
 */
async function seedDocument(raw: string, fragmentBody = raw): Promise<TestClient[]> {
  const docName = `doc-edge-${crypto.randomUUID()}`;
  const clients = await createTestClients(server.port, {
    count: 2,
    docName,
    // These tests drive the exact divergence the watcher reports, and its
    // throw would pre-empt the byte assertions that say what diverged.
    perClientOptions: { skipInvariantWatcher: true },
  });
  await agentWriteMd(server.port, raw, { docName, position: 'replace' });
  await pollUntil(
    () =>
      clients.every(
        (c) => c.ytext.toString() === raw && serializeFragment(c.fragment) === fragmentBody,
      ),
    10_000,
  );
  return clients;
}

/** The three surfaces that have to agree, checked byte for byte on every peer. */
async function expectEverywhereExactly(
  clients: TestClient[],
  expected: string,
  blankNodes: number,
  diskTimeoutMs: number,
  expectedFragment = expected,
): Promise<void> {
  for (const c of clients) {
    expect(c.ytext.toString()).toBe(expected);
    expect(serializeFragment(c.fragment)).toBe(expectedFragment);
    expect(countBlankLineNodes(c.fragment)).toBe(blankNodes);
  }
  // Persistence is debounced, so the bytes land after convergence.
  const docName = clients[0].docName;
  await settle(() => readTestDoc(server.contentDir, docName) === expected, diskTimeoutMs);
  expect(readTestDoc(server.contentDir, docName)).toBe(expected);
}

describe('doc-edge blank runs on the CRDT path', () => {
  test('a trailing blank run authored in the WYSIWYG reaches the source bytes', async () => {
    const clients = await seedDocument('Above.\n\nBelow.\n');
    try {
      const a = clients[0];
      // Enter pressed twice at the very end of the document.
      a.doc.transact(() => {
        a.fragment.insert(a.fragment.length, [para(), para()]);
      });

      const expected = 'Above.\n\nBelow.\n\n\n';
      await settle(() => clients.every((c) => c.ytext.toString() === expected), 6000);
      await expectEverywhereExactly(clients, expected, 2, 10_000);
    } finally {
      for (const c of clients) await c.cleanup();
    }
  });

  test('a trailing blank run on a frontmatter document reaches the source bytes', async () => {
    // The other branch of the merge byte-space: an FM-bearing document keeps a
    // single newline in the boundary slot rather than stripping it, and the
    // body the carrier sees starts one newline in. Every other case here is
    // FM-less, so without this one the composition that every real document
    // has is only covered at unit level.
    const clients = await seedDocument(
      '---\ntitle: Edge\n---\n\nAbove.\n\nBelow.\n',
      'Above.\n\nBelow.\n',
    );
    try {
      const a = clients[0];
      a.doc.transact(() => {
        a.fragment.insert(a.fragment.length, [para(), para()]);
      });

      const expected = '---\ntitle: Edge\n---\n\nAbove.\n\nBelow.\n\n\n';
      await settle(() => clients.every((c) => c.ytext.toString() === expected), 6000);
      await expectEverywhereExactly(clients, expected, 2, 10_000, 'Above.\n\nBelow.\n\n\n');
    } finally {
      for (const c of clients) await c.cleanup();
    }
  });

  test('a leading blank run authored in the WYSIWYG reaches the source bytes', async () => {
    const clients = await seedDocument('Above.\n\nBelow.\n');
    try {
      const a = clients[0];
      // Enter pressed twice at the very start of the document.
      a.doc.transact(() => {
        a.fragment.insert(0, [para(), para()]);
      });

      // The head carries no preceding block, so two empty paragraphs are two
      // newlines here where the same two at the tail would be three.
      const expected = '\n\nAbove.\n\nBelow.\n';
      await settle(() => clients.every((c) => c.ytext.toString() === expected), 6000);
      await expectEverywhereExactly(clients, expected, 2, 10_000);
    } finally {
      for (const c of clients) await c.cleanup();
    }
  });

  test('a trailing blank run on a single-block document reaches the source bytes', async () => {
    // One block means the trailing run is also the document's only gap, so
    // there is no interior run for a positional comparison to fall back on.
    const clients = await seedDocument('Hello.\n');
    try {
      const a = clients[0];
      a.doc.transact(() => {
        a.fragment.insert(a.fragment.length, [para(), para(), para()]);
      });

      const expected = 'Hello.\n\n\n\n';
      await settle(() => clients.every((c) => c.ytext.toString() === expected), 6000);
      await expectEverywhereExactly(clients, expected, 3, 10_000);
    } finally {
      for (const c of clients) await c.cleanup();
    }
  });

  test('a source-mode edit beside a trailing blank run does not destroy it', async () => {
    const clients = await seedDocument('Above.\n\nBelow.\n');
    try {
      const a = clients[0];
      const b = clients[1];
      a.doc.transact(() => {
        a.fragment.insert(a.fragment.length, [para(), para()]);
      });
      await settle(() => a.ytext.toString() === 'Above.\n\nBelow.\n\n\n', 4000);

      // The other peer in source mode: a direct Y.Text write, which is exactly
      // what CodeMirror does on a keystroke.
      b.doc.transact(() => {
        b.ytext.insert(0, 'X');
      });

      const expected = 'XAbove.\n\nBelow.\n\n\n';
      await settle(() => clients.every((c) => c.ytext.toString() === expected), 6000);
      await expectEverywhereExactly(clients, expected, 2, 8000);
    } finally {
      for (const c of clients) await c.cleanup();
    }
  });

  test('a fragment-only blank run survives the three-way merge seam at either position', async () => {
    // The seam the cases above never reach. Both surfaces have to diverge
    // inside ONE settlement window for the merge to run at all, and the merge
    // projects its three inputs into a byte space that strips the doc-start
    // run from frontmatter-less documents and re-attaches it from the Y.Text
    // side. That projection was written while the fragment structurally could
    // not hold a doc-start run, so a run only the fragment has is precisely
    // what it was never asked to carry, and it was dropped here.
    //
    // The concurrent Y.Text keystroke is scaffolding to force that window,
    // and the settlement's enqueued re-derive carries it back into the
    // fragment in the same drain (the split-brain request survives the
    // witness tautology), so every surface converges byte-exact — the run
    // AND the keystroke on both peers and disk. Both arms assert every
    // surface byte-exact so a change to either behaviour fails loudly
    // instead of passing over a lost run.
    async function mergeSeam(insertAt: number, ytext: string, fragment: string): Promise<void> {
      const clients = await seedDocument('Above.\n\nBelow.\n');
      try {
        const a = clients[0];
        a.doc.transact(() => {
          a.fragment.insert(insertAt, [para(), para()]);
          a.ytext.insert(a.ytext.toString().length - 1, '!');
        });

        await settle(
          () =>
            clients.every(
              (c) => c.ytext.toString() === ytext && serializeFragment(c.fragment) === fragment,
            ),
          8000,
        );
        for (const c of clients) {
          expect(c.ytext.toString()).toBe(ytext);
          expect(serializeFragment(c.fragment)).toBe(fragment);
          expect(countBlankLineNodes(c.fragment)).toBe(2);
        }
        const docName = clients[0].docName;
        await settle(() => readTestDoc(server.contentDir, docName) === ytext, 8000);
        expect(readTestDoc(server.contentDir, docName)).toBe(ytext);
      } finally {
        for (const c of clients) await c.cleanup();
      }
    }

    await mergeSeam(0, '\n\nAbove.\n\nBelow.!\n', '\n\nAbove.\n\nBelow.!\n');
    await mergeSeam(1, 'Above.\n\n\n\nBelow.!\n', 'Above.\n\n\n\nBelow.!\n');
  });

  test('an external write that carries a trailing run lands it in every fragment', async () => {
    // The reverse direction. The agent byte-writer puts the run into the
    // source bytes verbatim, so the question is whether the fragment every
    // peer renders from the following derive still has it — a run the
    // fragment cannot carry retracts here and takes the disk copy with it on
    // the next persistence pass.
    const clients = await seedDocument('Alpha.\n\nOmega.\n');
    try {
      const a = clients[0];
      a.doc.transact(() => {
        a.fragment.insert(a.fragment.length, [para(), para()]);
      });
      await settle(() => a.ytext.toString() === 'Alpha.\n\nOmega.\n\n\n', 4000);

      const expected = 'Alpha edited.\n\nOmega.\n\n\n';
      await agentWriteMd(server.port, expected, { docName: a.docName, position: 'replace' });

      await settle(() => clients.every((c) => c.ytext.toString() === expected), 6000);
      await expectEverywhereExactly(clients, expected, 2, 8000);
    } finally {
      for (const c of clients) await c.cleanup();
    }
  });

  test('a text edit and a trailing run in one transaction both reach the source bytes', async () => {
    // Both halves land in a single transaction, so the two sides cannot
    // normalize-compare equal and no already-in-sync shortcut is reachable.
    // Whatever carries the text change to Y.Text has to carry the run with it.
    const clients = await seedDocument('Above.\n\nBelow.\n');
    try {
      const a = clients[0];
      a.doc.transact(() => {
        const first = a.fragment.get(0) as { get(i: number): unknown };
        (first.get(0) as { insert(i: number, s: string): void }).insert(0, 'Z');
        a.fragment.insert(a.fragment.length, [para(), para()]);
      });

      const expected = 'ZAbove.\n\nBelow.\n\n\n';
      await settle(() => clients.every((c) => c.ytext.toString() === expected), 6000);
      await expectEverywhereExactly(clients, expected, 2, 8000);
    } finally {
      for (const c of clients) await c.cleanup();
    }
  });

  test('CONTROL: an interior blank run still reaches the source bytes unchanged', async () => {
    // Colocated deliberately. The interior path already works, and the edge
    // rule is a change to the same carrier, so a regression there would
    // otherwise only surface in a different file and a different run.
    const clients = await seedDocument('Above.\n\nBelow.\n');
    try {
      const a = clients[0];
      a.doc.transact(() => {
        a.fragment.insert(1, [para(), para()]);
      });

      const expected = 'Above.\n\n\n\nBelow.\n';
      await settle(() => clients.every((c) => c.ytext.toString() === expected), 6000);
      await expectEverywhereExactly(clients, expected, 2, 10_000);
    } finally {
      for (const c of clients) await c.cleanup();
    }
  });
});
