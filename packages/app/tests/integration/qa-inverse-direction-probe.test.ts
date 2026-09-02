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
  const docName = `qa-inv-${crypto.randomUUID()}`;
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

function snapshot(clients: TestClient[]): Record<string, unknown> {
  return {
    ytext: clients.map((c) => c.ytext.toString()),
    fragment: clients.map((c) => serializeFragment(c.fragment)),
    blanks: clients.map((c) => countBlankLineNodes(c.fragment)),
  };
}

describe('inverse direction: source mode -> WYSIWYG', () => {
  test('INV-01: a tail blank run typed in source mode reaches every WYSIWYG', async () => {
    for (const b of [2, 3, 5]) {
      const clients = await seedDocument('Above.\n\nBelow.\n');
      try {
        const a = clients[0];
        a.doc.transact(() => {
          a.ytext.insert(a.ytext.length, '\n'.repeat(b));
        });
        const expected = `Above.\n\nBelow.\n${'\n'.repeat(b)}`;
        const converged = await settle(
          () =>
            clients.every(
              (c) =>
                c.ytext.toString() === expected &&
                serializeFragment(c.fragment) === expected &&
                countBlankLineNodes(c.fragment) === b,
            ),
          6000,
        );
        diag('INV-01', { b, converged, ...snapshot(clients) });
        for (const c of clients) {
          expect(c.ytext.toString(), `b=${b} ytext`).toBe(expected);
          expect(serializeFragment(c.fragment), `b=${b} fragment`).toBe(expected);
          expect(countBlankLineNodes(c.fragment), `b=${b} blanks`).toBe(b);
        }
      } finally {
        for (const c of clients) await c.cleanup();
      }
    }
  }, 60_000);

  test('INV-02: a head blank run typed in source mode reaches every WYSIWYG', async () => {
    for (const b of [2, 3, 5]) {
      const clients = await seedDocument('Above.\n\nBelow.\n');
      try {
        const a = clients[0];
        a.doc.transact(() => {
          a.ytext.insert(0, '\n'.repeat(b));
        });
        const expected = `${'\n'.repeat(b)}Above.\n\nBelow.\n`;
        const converged = await settle(
          () =>
            clients.every(
              (c) =>
                c.ytext.toString() === expected &&
                serializeFragment(c.fragment) === expected &&
                countBlankLineNodes(c.fragment) === b,
            ),
          6000,
        );
        diag('INV-02', { b, converged, ...snapshot(clients) });
        for (const c of clients) {
          expect(c.ytext.toString(), `b=${b} ytext`).toBe(expected);
          expect(serializeFragment(c.fragment), `b=${b} fragment`).toBe(expected);
          expect(countBlankLineNodes(c.fragment), `b=${b} blanks`).toBe(b);
        }
      } finally {
        for (const c of clients) await c.cleanup();
      }
    }
  }, 60_000);

  test('INV-04: deleting a carried edge run in source mode empties the WYSIWYG run and it never resurrects', async () => {
    const clients = await seedDocument('Above.\n\nBelow.\n');
    try {
      const a = clients[0];
      const b = clients[1];
      a.doc.transact(() => {
        a.fragment.insert(a.fragment.length, [para(), para()]);
      });
      const withRun = 'Above.\n\nBelow.\n\n\n';
      expect(
        await settle(
          () =>
            clients.every(
              (c) => c.ytext.toString() === withRun && countBlankLineNodes(c.fragment) === 2,
            ),
          6000,
        ),
        'precondition: forward path landed the run',
      ).toBe(true);

      a.doc.transact(() => {
        a.ytext.delete(a.ytext.length - 2, 2);
      });
      const withoutRun = 'Above.\n\nBelow.\n';
      const converged = await settle(
        () =>
          clients.every(
            (c) =>
              c.ytext.toString() === withoutRun &&
              serializeFragment(c.fragment) === withoutRun &&
              countBlankLineNodes(c.fragment) === 0,
          ),
        6000,
      );
      diag('INV-04:after-delete', { converged, ...snapshot(clients) });
      for (const c of clients) {
        expect(c.ytext.toString()).toBe(withoutRun);
        expect(serializeFragment(c.fragment), 'fragment after source delete').toBe(withoutRun);
        expect(countBlankLineNodes(c.fragment), 'phantom blanks after source delete').toBe(0);
      }

      b.doc.transact(() => {
        const first = b.fragment.get(0) as { get(i: number): unknown };
        (first.get(0) as { insert(i: number, s: string): void }).insert(0, 'Z');
      });
      const edited = 'ZAbove.\n\nBelow.\n';
      const convergedEdit = await settle(
        () => clients.every((c) => c.ytext.toString() === edited),
        6000,
      );
      diag('INV-04:after-wysiwyg-edit', { convergedEdit, ...snapshot(clients) });
      for (const c of clients) {
        expect(c.ytext.toString(), 'no resurrection of the deleted run').toBe(edited);
      }
    } finally {
      for (const c of clients) await c.cleanup();
    }
  }, 30_000);

  test('INV-08: concurrent source content edit + WYSIWYG edge run both survive', async () => {
    const clients = await seedDocument('Above.\n\nBelow.\n');
    try {
      const a = clients[0];
      const b = clients[1];
      a.doc.transact(() => {
        a.ytext.insert(0, 'X');
      });
      b.doc.transact(() => {
        b.fragment.insert(b.fragment.length, [para(), para()]);
      });
      const expected = 'XAbove.\n\nBelow.\n\n\n';
      const converged = await settle(
        () =>
          clients.every(
            (c) =>
              c.ytext.toString() === expected &&
              serializeFragment(c.fragment) === expected &&
              countBlankLineNodes(c.fragment) === 2,
          ),
        8000,
      );
      diag('INV-08', { converged, ...snapshot(clients) });
      for (const c of clients) {
        expect(c.ytext.toString()).toBe(expected);
        expect(serializeFragment(c.fragment)).toBe(expected);
        expect(countBlankLineNodes(c.fragment)).toBe(2);
      }
    } finally {
      for (const c of clients) await c.cleanup();
    }
  }, 30_000);

  test('INV-07: a full re-derive inverts the edge arithmetic exactly and repeated cycles do not creep', async () => {
    const clients = await seedDocument('Above.\n\nBelow.\n');
    try {
      const a = clients[0];
      a.doc.transact(() => {
        a.ytext.insert(a.ytext.length, '\n\n\n');
      });
      a.doc.transact(() => {
        a.ytext.insert(0, 'Q');
      });
      const withNudge = 'QAbove.\n\nBelow.\n\n\n\n';
      const converged = await settle(
        () =>
          clients.every(
            (c) =>
              c.ytext.toString() === withNudge &&
              serializeFragment(c.fragment) === withNudge &&
              countBlankLineNodes(c.fragment) === 3,
          ),
        8000,
      );
      diag('INV-07:nudged', { converged, ...snapshot(clients) });
      for (const c of clients) {
        expect(c.ytext.toString()).toBe(withNudge);
        expect(serializeFragment(c.fragment), 'tail b=3 blank lines <=> 3 empties, exact').toBe(
          withNudge,
        );
        expect(countBlankLineNodes(c.fragment)).toBe(3);
      }

      for (let i = 0; i < 3; i++) {
        a.doc.transact(() => {
          a.ytext.delete(0, 1);
        });
        const removed = 'Above.\n\nBelow.\n\n\n\n';
        expect(
          await settle(
            () =>
              clients.every(
                (c) => c.ytext.toString() === removed && serializeFragment(c.fragment) === removed,
              ),
            6000,
          ),
          `cycle ${i} remove converged`,
        ).toBe(true);
        a.doc.transact(() => {
          a.ytext.insert(0, 'Q');
        });
        expect(
          await settle(
            () =>
              clients.every(
                (c) =>
                  c.ytext.toString() === withNudge && serializeFragment(c.fragment) === withNudge,
              ),
            6000,
          ),
          `cycle ${i} re-add converged`,
        ).toBe(true);
      }
      diag('INV-07:cycles', snapshot(clients));
      for (const c of clients) {
        expect(countBlankLineNodes(c.fragment), 'no creep across re-derive cycles').toBe(3);
      }
    } finally {
      for (const c of clients) await c.cleanup();
    }
  }, 60_000);

  test('INV-09: a source-authored edge run is not permanently invisible to the WYSIWYG (healing probes)', async () => {
    const clients = await seedDocument('Above.\n\nBelow.\n');
    try {
      const a = clients[0];
      const b = clients[1];
      a.doc.transact(() => {
        a.ytext.insert(a.ytext.length, '\n\n');
      });
      const direct = await settle(
        () => clients.every((c) => countBlankLineNodes(c.fragment) === 2),
        5000,
      );
      diag('INV-09:direct', { direct, ...snapshot(clients) });

      b.doc.transact(() => {
        const first = b.fragment.get(0) as { get(i: number): unknown };
        (first.get(0) as { insert(i: number, s: string): void }).insert(0, 'Z');
      });
      const afterWysiwyg = await settle(
        () => clients.every((c) => countBlankLineNodes(c.fragment) === 2),
        5000,
      );
      diag('INV-09:after-wysiwyg', { afterWysiwyg, ...snapshot(clients) });

      a.doc.transact(() => {
        a.ytext.insert(a.ytext.toString().indexOf('Above'), 'W');
      });
      const afterSource = await settle(
        () => clients.every((c) => countBlankLineNodes(c.fragment) === 2),
        5000,
      );
      diag('INV-09:after-source', { afterSource, ...snapshot(clients) });

      const fresh = await createTestClient(server.port, a.docName, {
        skipInvariantWatcher: true,
      });
      try {
        const freshSees = await settle(() => countBlankLineNodes(fresh.fragment) === 2, 5000);
        diag('INV-09:fresh-client', {
          freshSees,
          fragment: serializeFragment(fresh.fragment),
          blanks: countBlankLineNodes(fresh.fragment),
        });
        expect(
          afterSource || freshSees,
          'run still invisible to WYSIWYG after WYSIWYG edit + source edit + fresh mount',
        ).toBe(true);
        for (const c of clients) {
          expect(c.ytext.toString(), 'authored bytes survive throughout').toContain('\n\n\n');
        }
      } finally {
        await fresh.cleanup();
      }
    } finally {
      for (const c of clients) await c.cleanup();
    }
  }, 60_000);

  test('INV-10: content stranded by the merge seam eventually reaches the WYSIWYG', async () => {
    const clients = await seedDocument('Above.\n\nBelow.\n');
    try {
      const a = clients[0];
      a.doc.transact(() => {
        a.fragment.insert(0, [para(), para()]);
        a.ytext.insert(a.ytext.toString().length - 1, '!');
      });
      const ytextSettled = '\n\nAbove.\n\nBelow.!\n';
      expect(
        await settle(() => clients.every((c) => c.ytext.toString() === ytextSettled), 8000),
        'precondition: pinned merge-seam Y.Text state reached',
      ).toBe(true);
      const strandedAtSettle = clients.map((c) => serializeFragment(c.fragment).includes('!'));
      diag('INV-10:settled', { strandedAtSettle, ...snapshot(clients) });

      a.doc.transact(() => {
        a.ytext.insert(a.ytext.toString().indexOf('Above'), 'W');
      });
      const healed = await settle(
        () => clients.every((c) => serializeFragment(c.fragment).includes('!')),
        6000,
      );
      diag('INV-10:after-source-edit', { healed, ...snapshot(clients) });
      expect(healed, 'the stranded keystroke reached the WYSIWYG after a source-side drain').toBe(
        true,
      );
    } finally {
      for (const c of clients) await c.cleanup();
    }
  }, 30_000);

  test('INV-05: whitespace-polluted blank lines at the tail hold safe, stable state', async () => {
    const clients = await seedDocument('Above.\n\nBelow.\n');
    try {
      const a = clients[0];
      a.doc.transact(() => {
        a.ytext.insert(a.ytext.length, '\n \n');
      });
      const expected = 'Above.\n\nBelow.\n\n \n';
      await settle(() => clients.every((c) => c.ytext.toString() === expected), 5000);
      const frag0 = clients.map((c) => serializeFragment(c.fragment));
      await wait(1500);
      const frag1 = clients.map((c) => serializeFragment(c.fragment));
      diag('INV-05', { frag0, frag1, ...snapshot(clients) });
      for (const c of clients) {
        expect(c.ytext.toString(), 'polluted bytes preserved verbatim').toBe(expected);
      }
      expect(frag1, 'fragment stable across settle windows (no loop)').toEqual(frag0);
    } finally {
      for (const c of clients) await c.cleanup();
    }
  }, 30_000);

  test('INV-03: a sub-floor single blank line survives in bytes across a later WYSIWYG edit', async () => {
    const clients = await seedDocument('Above.\n\nBelow.\n');
    try {
      const a = clients[0];
      const b = clients[1];
      a.doc.transact(() => {
        a.ytext.insert(a.ytext.length, '\n');
      });
      const withSubFloor = 'Above.\n\nBelow.\n\n';
      expect(
        await settle(() => clients.every((c) => c.ytext.toString() === withSubFloor), 5000),
        'sub-floor byte propagation to peers',
      ).toBe(true);

      b.doc.transact(() => {
        const first = b.fragment.get(0) as { get(i: number): unknown };
        (first.get(0) as { insert(i: number, s: string): void }).insert(0, 'Z');
      });
      const edited = 'ZAbove.\n\nBelow.\n\n';
      const converged = await settle(
        () => clients.every((c) => c.ytext.toString() === edited),
        6000,
      );
      diag('INV-03', { converged, ...snapshot(clients) });
      for (const c of clients) {
        expect(c.ytext.toString(), 'sub-floor blank line not destroyed by WYSIWYG edit').toBe(
          edited,
        );
      }
    } finally {
      for (const c of clients) await c.cleanup();
    }
  }, 30_000);
});

describe('inverse direction on frontmatter-bearing documents', () => {
  test('INV-13: a head run typed in source mode below the FM separator reaches every WYSIWYG and deletes back out', async () => {
    const seed = '---\ntitle: Edge\n---\n\nAbove.\n';
    const clients = await seedDocument(seed, 'Above.\n');
    try {
      const a = clients[0];
      a.doc.transact(() => {
        a.ytext.insert(a.ytext.toString().indexOf('Above'), '\n\n');
      });
      const authored = '---\ntitle: Edge\n---\n\n\n\nAbove.\n';
      const gained = await settle(
        () =>
          clients.every(
            (c) =>
              c.ytext.toString() === authored &&
              countBlankLineNodes(c.fragment) === 2 &&
              serializeFragment(c.fragment) === '\n\nAbove.\n',
          ),
        8000,
      );
      diag('INV-13:gained', { gained, ...snapshot(clients) });
      expect(gained, 'source-authored FM head run reaches every WYSIWYG').toBe(true);

      a.doc.transact(() => {
        const idx = a.ytext.toString().indexOf('\n\n\n');
        a.ytext.delete(idx, 2);
      });
      const dropped = await settle(
        () =>
          clients.every(
            (c) =>
              c.ytext.toString() === seed &&
              countBlankLineNodes(c.fragment) === 0 &&
              serializeFragment(c.fragment) === 'Above.\n',
          ),
        8000,
      );
      diag('INV-13:dropped', { dropped, ...snapshot(clients) });
      expect(dropped, 'source-deleting the run restores the separator-only shape everywhere').toBe(
        true,
      );
    } finally {
      for (const c of clients) await c.cleanup();
    }
  }, 30_000);
});

describe('split-brain settlements converge at rest', () => {
  test('INV-14: the merge-seam settlement reaches every WYSIWYG without a healing edit', async () => {
    const clients = await seedDocument('Above.\n\nBelow.\n');
    try {
      const a = clients[0];
      a.doc.transact(() => {
        a.fragment.insert(0, [para(), para()]);
        a.ytext.insert(a.ytext.toString().length - 1, '!');
      });
      const converged = await settle(
        () =>
          clients.every((c) => {
            const y = c.ytext.toString();
            return (
              y.includes('Below.!') &&
              serializeFragment(c.fragment) === y &&
              clients.every((o) => o.ytext.toString() === y)
            );
          }),
        8000,
      );
      diag('INV-14', snapshot(clients));
      expect(converged, 'the seam keystroke reaches every WYSIWYG at rest').toBe(true);
    } finally {
      for (const c of clients) await c.cleanup();
    }
  }, 30_000);
});
