import { appendFileSync } from 'node:fs';
import { setTimeout as wait } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import * as Y from 'yjs';
import { HARNESS_BOOT_TIMEOUT_MS } from './harness-boot-timeout';
import {
  agentWriteMd,
  createTestClient,
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

const DIAG = process.env.QA_DIAG_OUT;
function diag(probe: string, data: Record<string, unknown>): void {
  if (!DIAG) return;
  appendFileSync(DIAG, `${JSON.stringify({ probe, ...data })}\n`);
}

const para = () => new Y.XmlElement('paragraph');

function countBlankLineNodes(fragment: Y.XmlFragment): number {
  let count = 0;
  for (let i = 0; i < fragment.length; i++) {
    if (String(fragment.get(i)) === '<paragraph></paragraph>') count += 1;
  }
  return count;
}

async function settle(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await wait(25);
  }
  return false;
}

async function seedDocument(raw: string, fragmentBody = raw): Promise<TestClient[]> {
  const docName = `qa-fwd-${crypto.randomUUID()}`;
  const clients = await createTestClients(server.port, {
    count: 2,
    docName,
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

describe('#3132 forward verification + regression checks', () => {
  test('FWD-02: one Enter at the tail stays below the carry floor; the second Enter carries both', async () => {
    const clients = await seedDocument('Above.\n\nBelow.\n');
    try {
      const a = clients[0];
      a.doc.transact(() => {
        a.fragment.insert(a.fragment.length, [para()]);
      });
      await wait(1500);
      const afterOne = clients.map((c) => c.ytext.toString());
      diag('FWD-02:one-enter', { afterOne });
      for (const yt of afterOne) {
        expect(yt, 'single Enter is affordance-ambiguous and must not write bytes').toBe(
          'Above.\n\nBelow.\n',
        );
      }
      a.doc.transact(() => {
        a.fragment.insert(a.fragment.length, [para()]);
      });
      const expected = 'Above.\n\nBelow.\n\n\n';
      const converged = await settle(
        () => clients.every((c) => c.ytext.toString() === expected),
        6000,
      );
      diag('FWD-02:two-enters', { converged, ytext: clients.map((c) => c.ytext.toString()) });
      for (const c of clients) {
        expect(c.ytext.toString(), 'second Enter crosses the floor and carries the run').toBe(
          expected,
        );
      }
    } finally {
      for (const c of clients) await c.cleanup();
    }
  }, 30_000);

  test('FWD-03: an agent write carrying head AND tail runs lands verbatim on every surface', async () => {
    const raw = '\n\nHead.\n\nTail.\n\n\n';
    const docName = `qa-fwd-w3-${crypto.randomUUID()}`;
    const clients = await createTestClients(server.port, {
      count: 2,
      docName,
      perClientOptions: { skipInvariantWatcher: true },
    });
    try {
      await agentWriteMd(server.port, raw, { docName, position: 'replace' });
      const converged = await settle(
        () =>
          clients.every(
            (c) =>
              c.ytext.toString() === raw &&
              serializeFragment(c.fragment) === raw &&
              countBlankLineNodes(c.fragment) === 4,
          ),
        8000,
      );
      diag('FWD-03', {
        converged,
        ytext: clients.map((c) => c.ytext.toString()),
        fragment: clients.map((c) => serializeFragment(c.fragment)),
        blanks: clients.map((c) => countBlankLineNodes(c.fragment)),
      });
      for (const c of clients) {
        expect(c.ytext.toString()).toBe(raw);
        expect(serializeFragment(c.fragment)).toBe(raw);
        expect(countBlankLineNodes(c.fragment), 'head 2 + tail 2').toBe(4);
      }
      expect(await settle(() => readTestDoc(server.contentDir, docName) === raw, 10_000)).toBe(
        true,
      );
    } finally {
      for (const c of clients) await c.cleanup();
    }
  }, 30_000);

  test('FWD-05: FM-bearing docs keep the separator distinct from authored head runs', async () => {
    const seed = '---\ntitle: Edge\n---\n\nAbove.\n';
    const clients = await seedDocument(seed, 'Above.\n');
    try {
      const a = clients[0];
      a.doc.transact(() => {
        a.fragment.insert(0, [para(), para()]);
      });
      const stableState = await settle(() => {
        const y = clients[0].ytext.toString();
        return (
          y === '---\ntitle: Edge\n---\n\n\n\nAbove.\n' &&
          countBlankLineNodes(clients[0].fragment) === 2 &&
          clients.every((c) => c.ytext.toString() === y)
        );
      }, 8000);
      const afterAuthor = clients[0].ytext.toString();
      diag('FWD-05:authored', {
        stableState,
        afterAuthor,
        fragment: serializeFragment(clients[0].fragment),
      });
      expect(stableState, 'head-run authoring on an FM doc converges with FM intact').toBe(true);
      expect(afterAuthor.startsWith('---\ntitle: Edge\n---\n'), 'FM region intact').toBe(true);
      expect(afterAuthor.endsWith('Above.\n')).toBe(true);

      a.doc.transact(() => {
        a.ytext.insert(a.ytext.toString().indexOf('Above'), 'Q');
      });
      const nudged = afterAuthor.replace('Above.', 'QAbove.');
      const nudgeConverged = await settle(
        () =>
          clients.every(
            (c) => c.ytext.toString() === nudged && countBlankLineNodes(c.fragment) === 2,
          ),
        8000,
      );
      diag('FWD-05:nudged', { nudgeConverged, ytext: clients[0].ytext.toString() });
      expect(nudgeConverged, 'full re-derive keeps FM + head run byte-stable').toBe(true);

      a.doc.transact(() => {
        a.fragment.delete(0, 2);
      });
      const expectedBack = seed.replace('Above.', 'QAbove.');
      const deleted = await settle(
        () => clients.every((c) => c.ytext.toString() === expectedBack),
        8000,
      );
      diag('FWD-05:deleted', { deleted, ytext: clients[0].ytext.toString() });
      expect(deleted, 'deleting the head run restores the separator-only shape').toBe(true);
    } finally {
      for (const c of clients) await c.cleanup();
    }
  }, 40_000);

  test('FWD-06: floor hazards guarded — heading-final mount mints nothing; a 2-empties doc does not creep', async () => {
    const headingDoc = `qa-fwd-floor-a-${crypto.randomUUID()}`;
    await agentWriteMd(server.port, '## Head\n', { docName: headingDoc, position: 'replace' });
    const c1 = await createTestClient(server.port, headingDoc, { skipInvariantWatcher: true });
    await pollUntil(() => c1.ytext.toString() === '## Head\n', 10_000);
    await wait(4000);
    const headingDisk = readTestDoc(server.contentDir, headingDoc);
    const headingYtext = c1.ytext.toString();
    diag('FWD-06:heading-final', {
      headingDisk,
      headingYtext,
      fragment: serializeFragment(c1.fragment),
    });
    expect(headingYtext, 'no phantom blank from the type-here affordance').toBe('## Head\n');
    expect(headingDisk).toBe('## Head\n');
    await c1.cleanup();

    const twoEmpties = `qa-fwd-floor-b-${crypto.randomUUID()}`;
    const raw = 'Body.\n\n\n';
    await agentWriteMd(server.port, raw, { docName: twoEmpties, position: 'replace' });
    const c2 = await createTestClient(server.port, twoEmpties, { skipInvariantWatcher: true });
    await pollUntil(() => c2.ytext.toString() === raw, 10_000);
    await wait(4000);
    const twoDisk = readTestDoc(server.contentDir, twoEmpties);
    const twoYtext = c2.ytext.toString();
    diag('FWD-06:two-empties', { twoDisk, twoYtext, blanks: countBlankLineNodes(c2.fragment) });
    expect(twoYtext, 'floor stability: no third empty walks in').toBe(raw);
    expect(twoDisk).toBe(raw);
    await c2.cleanup();
  }, 40_000);

  test('FWD-08: degenerate docs (empty, single newline, all-blank) are stable', async () => {
    for (const raw of ['', '\n', '\n\n\n']) {
      const docName = `qa-fwd-degen-${crypto.randomUUID()}`;
      const clients = await createTestClients(server.port, {
        count: 2,
        docName,
        perClientOptions: { skipInvariantWatcher: true },
      });
      try {
        await agentWriteMd(server.port, raw, { docName, position: 'replace' });
        const converged = await settle(
          () => clients.every((c) => c.ytext.toString() === raw),
          6000,
        );
        const frag0 = clients.map((c) => serializeFragment(c.fragment));
        await wait(1500);
        const frag1 = clients.map((c) => serializeFragment(c.fragment));
        const yt = clients.map((c) => c.ytext.toString());
        diag('FWD-08', { raw: JSON.stringify(raw), converged, yt, frag0, frag1 });
        for (const c of clients) {
          expect(c.ytext.toString(), `bytes stable for ${JSON.stringify(raw)}`).toBe(raw);
        }
        expect(frag1, 'no observer churn on degenerate docs').toEqual(frag0);
      } finally {
        for (const c of clients) await c.cleanup();
      }
    }
  }, 60_000);

  test('FWD-10: simultaneous head-run and tail-run authoring on different peers both survive', async () => {
    const clients = await seedDocument('Above.\n\nBelow.\n');
    try {
      const a = clients[0];
      const b = clients[1];
      a.doc.transact(() => {
        a.fragment.insert(0, [para(), para()]);
      });
      b.doc.transact(() => {
        b.fragment.insert(b.fragment.length, [para(), para()]);
      });
      const expected = '\n\nAbove.\n\nBelow.\n\n\n';
      const converged = await settle(
        () =>
          clients.every(
            (c) =>
              c.ytext.toString() === expected &&
              serializeFragment(c.fragment) === expected &&
              countBlankLineNodes(c.fragment) === 4,
          ),
        8000,
      );
      diag('FWD-10', {
        converged,
        ytext: clients.map((c) => c.ytext.toString()),
        fragment: clients.map((c) => serializeFragment(c.fragment)),
        blanks: clients.map((c) => countBlankLineNodes(c.fragment)),
      });
      for (const c of clients) {
        expect(c.ytext.toString()).toBe(expected);
        expect(serializeFragment(c.fragment)).toBe(expected);
        expect(countBlankLineNodes(c.fragment)).toBe(4);
      }
    } finally {
      for (const c of clients) await c.cleanup();
    }
  }, 30_000);

  test('FWD-12: human undo of a WYSIWYG-authored edge run removes it everywhere', async () => {
    const clients = await seedDocument('Above.\n\nBelow.\n');
    try {
      const a = clients[0];
      const undoManager = new Y.UndoManager(a.fragment);
      a.doc.transact(() => {
        a.fragment.insert(a.fragment.length, [para(), para()]);
      });
      const withRun = 'Above.\n\nBelow.\n\n\n';
      expect(
        await settle(() => clients.every((c) => c.ytext.toString() === withRun), 6000),
        'precondition: run landed',
      ).toBe(true);

      undoManager.undo();
      const back = 'Above.\n\nBelow.\n';
      const converged = await settle(
        () =>
          clients.every(
            (c) => c.ytext.toString() === back && countBlankLineNodes(c.fragment) === 0,
          ),
        6000,
      );
      diag('FWD-12', {
        converged,
        ytext: clients.map((c) => c.ytext.toString()),
        blanks: clients.map((c) => countBlankLineNodes(c.fragment)),
      });
      for (const c of clients) {
        expect(c.ytext.toString(), 'undo removes the run from the source bytes').toBe(back);
        expect(countBlankLineNodes(c.fragment)).toBe(0);
      }
    } finally {
      for (const c of clients) await c.cleanup();
    }
  }, 30_000);

  test('DESTROY-A: a WYSIWYG paragraph delete beside a source-only tail run does not destroy the run', async () => {
    const clients = await seedDocument('Above.\n\nBelow.\n');
    try {
      const a = clients[0];
      const b = clients[1];
      a.doc.transact(() => {
        a.ytext.insert(a.ytext.length, '\n\n');
      });
      await settle(
        () => clients.every((c) => c.ytext.toString() === 'Above.\n\nBelow.\n\n\n'),
        5000,
      );

      b.doc.transact(() => {
        b.fragment.delete(1, 1);
      });
      await settle(() => clients.every((c) => c.ytext.toString() === 'Above.\n\n\n'), 8000);
      const finalYtexts = clients.map((c) => c.ytext.toString());
      diag('DESTROY-A', {
        finalYtexts,
        fragment: clients.map((c) => serializeFragment(c.fragment)),
      });
      for (const yt of finalYtexts) {
        expect(yt, 'the source-authored run survives the adjacent WYSIWYG delete').toBe(
          'Above.\n\n\n',
        );
      }
    } finally {
      for (const c of clients) await c.cleanup();
    }
  }, 30_000);
});
