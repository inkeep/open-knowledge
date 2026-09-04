import { appendFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { describe, expect, test } from 'vitest';
import * as Y from 'yjs';
import {
  agentWriteMd,
  createRestartableServer,
  createTestClient,
  createTestClients,
  createTestServer,
  pollUntil,
  readTestDoc,
  serializeFragment,
  type TestClient,
} from './test-harness';

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

function detachClient(c: TestClient): void {
  c.provider.destroy();
  c.doc.destroy();
}

describe('healing bounds for the stranded states', () => {
  test('HEAL-A: repeated source-side drains eventually surface a source-authored edge run in the WYSIWYG', async () => {
    const server = await createTestServer();
    const docName = `qa-heal-a-${crypto.randomUUID()}`;
    const clients = await createTestClients(server.port, {
      count: 2,
      docName,
      perClientOptions: { skipInvariantWatcher: true },
    });
    try {
      const seed = 'Above.\n\nBelow.\n';
      await agentWriteMd(server.port, seed, { docName, position: 'replace' });
      await pollUntil(() => clients.every((c) => c.ytext.toString() === seed), 10_000);
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
        const first = b.fragment.get(0) as { get(i: number): unknown };
        (first.get(0) as { insert(i: number, s: string): void }).insert(0, 'Z');
      });
      await wait(1000);

      const rounds: Array<Record<string, unknown>> = [];
      let healedAt = -1;
      for (let r = 0; r < 10; r++) {
        a.doc.transact(() => {
          a.ytext.insert(a.ytext.toString().indexOf('Above'), 'w');
        });
        await wait(800);
        const blanks = clients.map((c) => countBlankLineNodes(c.fragment));
        const frag = serializeFragment(a.fragment);
        const yt = a.ytext.toString();
        rounds.push({ r, blanks, fragHasAllEdits: frag === yt });
        if (blanks.every((n) => n === 2) && frag === yt) {
          healedAt = r;
          break;
        }
      }
      diag('HEAL-A', {
        healedAt,
        rounds,
        finalYtext: clients[0].ytext.toString(),
        finalFragment: serializeFragment(clients[0].fragment),
      });
      expect(
        healedAt,
        'WYSIWYG converged to the full source state within 10 further drains',
      ).toBeGreaterThanOrEqual(0);
    } finally {
      for (const c of clients) await c.cleanup();
      await server.cleanup();
    }
  }, 90_000);

  test('HEAL-B: repeated source-side drains eventually surface the merge-seam stranded keystroke', async () => {
    const server = await createTestServer();
    const docName = `qa-heal-b-${crypto.randomUUID()}`;
    const clients = await createTestClients(server.port, {
      count: 2,
      docName,
      perClientOptions: { skipInvariantWatcher: true },
    });
    try {
      const seed = 'Above.\n\nBelow.\n';
      await agentWriteMd(server.port, seed, { docName, position: 'replace' });
      await pollUntil(() => clients.every((c) => c.ytext.toString() === seed), 10_000);
      const a = clients[0];
      a.doc.transact(() => {
        a.fragment.insert(0, [para(), para()]);
        a.ytext.insert(a.ytext.toString().length - 1, '!');
      });
      await settle(
        () => clients.every((c) => c.ytext.toString() === '\n\nAbove.\n\nBelow.!\n'),
        8000,
      );

      const rounds: Array<Record<string, unknown>> = [];
      let healedAt = -1;
      for (let r = 0; r < 10; r++) {
        a.doc.transact(() => {
          a.ytext.insert(a.ytext.toString().indexOf('Above'), 'w');
        });
        await wait(800);
        const frag = serializeFragment(a.fragment);
        rounds.push({
          r,
          fragHasBang: frag.includes('!'),
          fragHasAllEdits: frag === a.ytext.toString(),
        });
        if (frag === a.ytext.toString()) {
          healedAt = r;
          break;
        }
      }
      diag('HEAL-B', {
        healedAt,
        rounds,
        finalYtext: clients[0].ytext.toString(),
        finalFragment: serializeFragment(clients[0].fragment),
      });
      expect(
        healedAt,
        'WYSIWYG converged to the full source state within 10 further drains',
      ).toBeGreaterThanOrEqual(0);
    } finally {
      for (const c of clients) await c.cleanup();
      await server.cleanup();
    }
  }, 90_000);

  test('INV-04b: the phantom fragment run does not resurrect into Y.Text on a later WYSIWYG edit', async () => {
    const server = await createTestServer();
    const docName = `qa-heal-c-${crypto.randomUUID()}`;
    const clients = await createTestClients(server.port, {
      count: 2,
      docName,
      perClientOptions: { skipInvariantWatcher: true },
    });
    try {
      const seed = 'Above.\n\nBelow.\n';
      await agentWriteMd(server.port, seed, { docName, position: 'replace' });
      await pollUntil(() => clients.every((c) => c.ytext.toString() === seed), 10_000);
      const a = clients[0];
      const b = clients[1];
      a.doc.transact(() => {
        a.fragment.insert(a.fragment.length, [para(), para()]);
      });
      await settle(
        () => clients.every((c) => c.ytext.toString() === 'Above.\n\nBelow.\n\n\n'),
        6000,
      );
      a.doc.transact(() => {
        a.ytext.delete(a.ytext.length - 2, 2);
      });
      await settle(() => clients.every((c) => c.ytext.toString() === 'Above.\n\nBelow.\n'), 5000);
      const phantomBlanks = clients.map((c) => countBlankLineNodes(c.fragment));

      b.doc.transact(() => {
        const first = b.fragment.get(0) as { get(i: number): unknown };
        (first.get(0) as { insert(i: number, s: string): void }).insert(0, 'Z');
      });
      await wait(1500);
      const finalYtexts = clients.map((c) => c.ytext.toString());
      diag('INV-04b', { phantomBlanks, finalYtexts, fragment: serializeFragment(b.fragment) });
      for (const yt of finalYtexts) {
        expect(yt, 'deleted run must not resurrect into the source bytes').toBe(
          'ZAbove.\n\nBelow.\n',
        );
      }
    } finally {
      for (const c of clients) await c.cleanup();
      await server.cleanup();
    }
  }, 60_000);
});

describe('restart lifecycle (corrected: no testReset truncation)', () => {
  test('RESTART-CLEAN: a source-authored edge run survives a clean server restart and re-derives', async () => {
    const contentDir = mkdtempSync(join(tmpdir(), 'qa-restart-clean-'));
    const docName = `qa-restart-${crypto.randomUUID()}`;
    const withRun = 'Above.\n\nBelow.\n\n\n';

    const s1 = await createTestServer({ contentDir, keepContentDir: true });
    const c1 = await createTestClient(s1.port, docName, { skipInvariantWatcher: true });
    await agentWriteMd(s1.port, 'Above.\n\nBelow.\n', { docName, position: 'replace' });
    await pollUntil(() => c1.ytext.toString() === 'Above.\n\nBelow.\n', 10_000);
    c1.doc.transact(() => {
      c1.ytext.insert(c1.ytext.length, '\n\n');
    });
    expect(
      await settle(() => readTestDoc(contentDir, docName) === withRun, 15_000),
      'flushed pre-restart',
    ).toBe(true);
    detachClient(c1);
    await s1.cleanup();
    const diskAfterShutdown = readTestDoc(contentDir, docName);

    const s2 = await createTestServer({ contentDir, keepContentDir: true });
    const c2 = await createTestClient(s2.port, docName, { skipInvariantWatcher: true });
    try {
      const loaded = await settle(
        () => c2.ytext.toString() === withRun && serializeFragment(c2.fragment) === withRun,
        10_000,
      );
      await wait(3000);
      const result = {
        diskAfterShutdown,
        loaded,
        ytext: c2.ytext.toString(),
        fragment: serializeFragment(c2.fragment),
        blanks: countBlankLineNodes(c2.fragment),
        diskFinal: readTestDoc(contentDir, docName),
      };
      diag('RESTART-CLEAN', result);
      expect(diskAfterShutdown, 'clean shutdown preserves bytes').toBe(withRun);
      expect(c2.ytext.toString(), 'reload restores bytes').toBe(withRun);
      expect(serializeFragment(c2.fragment), 'reload re-derives the run into the fragment').toBe(
        withRun,
      );
      expect(countBlankLineNodes(c2.fragment)).toBe(2);
      expect(readTestDoc(contentDir, docName), 'no creep after a reload store cycle').toBe(withRun);
    } finally {
      detachClient(c2);
      await s2.cleanup();
    }
  }, 90_000);

  test('RESTART-CRASH: a flushed edge run survives a crash-simulated fast restart', async () => {
    let restartable = await createRestartableServer({ keepContentDir: true });
    try {
      const docName = `qa-crash-${crypto.randomUUID()}`;
      await agentWriteMd(restartable.port, 'Above.\n\nBelow.\n', { docName, position: 'replace' });
      const c1 = await createTestClient(restartable.port, docName, { skipInvariantWatcher: true });
      await pollUntil(() => c1.ytext.toString() === 'Above.\n\nBelow.\n', 10_000);
      c1.doc.transact(() => {
        c1.ytext.insert(c1.ytext.length, '\n\n');
      });
      const withRun = 'Above.\n\nBelow.\n\n\n';
      expect(
        await settle(() => readTestDoc(restartable.contentDir, docName) === withRun, 15_000),
        'flushed pre-crash',
      ).toBe(true);
      detachClient(c1);

      restartable = await restartable.killAndRestartOnSamePort({ downtimeMs: 5000 });
      const c2 = await createTestClient(restartable.port, docName, { skipInvariantWatcher: true });
      try {
        const reloaded = await settle(
          () =>
            c2.ytext.toString() === withRun &&
            serializeFragment(c2.fragment) === withRun &&
            countBlankLineNodes(c2.fragment) === 2,
          10_000,
        );
        diag('RESTART-CRASH', {
          reloaded,
          ytext: c2.ytext.toString(),
          fragment: serializeFragment(c2.fragment),
          blanks: countBlankLineNodes(c2.fragment),
          disk: readTestDoc(restartable.contentDir, docName),
        });
        expect(c2.ytext.toString()).toBe(withRun);
        expect(serializeFragment(c2.fragment)).toBe(withRun);
        expect(countBlankLineNodes(c2.fragment)).toBe(2);
        expect(readTestDoc(restartable.contentDir, docName)).toBe(withRun);
      } finally {
        detachClient(c2);
      }
    } finally {
      await restartable.shutdown();
    }
  }, 120_000);
});

describe('defer-guard innocence under the honest early-exit', () => {
  test('C17: a pending WYSIWYG paragraph and a concurrent source keystroke both survive', async () => {
    const server = await createTestServer();
    const docName = `qa-c17-${crypto.randomUUID()}`;
    const clients = await createTestClients(server.port, {
      count: 2,
      docName,
      perClientOptions: { skipInvariantWatcher: true },
    });
    try {
      const seed = 'Alpha.\n\nOmega.\n';
      await agentWriteMd(server.port, seed, { docName, position: 'replace' });
      await pollUntil(() => clients.every((c) => c.ytext.toString() === seed), 10_000);
      const a = clients[0];
      a.doc.transact(() => {
        const p = new Y.XmlElement('paragraph');
        const t = new Y.XmlText();
        t.insert(0, 'Mid.');
        p.insert(0, [t]);
        a.fragment.insert(1, [p]);
        a.ytext.insert(a.ytext.toString().length - 1, '!');
      });
      const converged = await settle(
        () =>
          clients.every((c) => {
            const y = c.ytext.toString();
            return (
              y.includes('Mid.') &&
              y.includes('Omega.!') &&
              serializeFragment(c.fragment).includes('Mid.') &&
              serializeFragment(c.fragment).includes('Omega.!') &&
              clients.every((o) => o.ytext.toString() === y)
            );
          }),
        8000,
      );
      diag('C17', {
        ytext: clients.map((c) => c.ytext.toString()),
        fragment: clients.map((c) => serializeFragment(c.fragment)),
      });
      expect(converged, 'both the pending paragraph and the keystroke survive everywhere').toBe(
        true,
      );
    } finally {
      for (const c of clients) await c.cleanup();
      await server.cleanup();
    }
  }, 30_000);
});
