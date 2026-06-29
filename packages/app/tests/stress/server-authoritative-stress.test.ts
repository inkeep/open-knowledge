
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { setTimeout as wait } from 'node:timers/promises';
import * as Y from 'yjs';
import {
  assertBridgeInvariant,
  createTestClients,
  createTestServer,
  serializeFragment,
  type TestClient,
  type TestServer,
} from '../integration/test-harness';


function createPRNG(seed: number) {
  let state = seed | 0 || 1;
  return {
    next(): number {
      state ^= state << 13;
      state ^= state >> 17;
      state ^= state << 5;
      return (state >>> 0) / 4294967296;
    },
    nextInt(max: number): number {
      return Math.floor(this.next() * max);
    },
  };
}


function wysiwygAppend(client: TestClient, text: string): void {
  const paragraph = new Y.XmlElement('paragraph');
  const ytext = new Y.XmlText();
  ytext.applyDelta([{ insert: text }]);
  paragraph.insert(0, [ytext]);
  client.fragment.push([paragraph]);
}

function sourceAppend(client: TestClient, text: string): void {
  client.doc.transact(() => {
    client.ytext.insert(client.ytext.length, `\n\n${text}\n`);
  });
}


async function driveToConvergence(
  clients: TestClient[],
  timeoutMs: number,
): Promise<number | null> {
  const start = Date.now();

  await wait(1500);

  let attempts = 0;
  while (Date.now() - start < timeoutMs) {
    const ytexts = clients.map((c) => c.ytext.toString());
    const fragMds = clients.map((c) => serializeFragment(c.fragment));
    const allYtextSame = ytexts.every((t) => t === ytexts[0]);
    const allFragSame = fragMds.every((m) => m === fragMds[0]);

    if (allYtextSame && allFragSame) {
      let allBridgeOk = true;
      for (const c of clients) {
        try {
          assertBridgeInvariant(c.ytext, c.fragment);
        } catch {
          allBridgeOk = false;
          break;
        }
      }
      if (allBridgeOk) return Date.now() - start;
    }

    if (attempts < 8) {
      const target = clients[attempts % clients.length];
      const paragraph = new Y.XmlElement('paragraph');
      const text = new Y.XmlText();
      text.applyDelta([{ insert: `r${attempts}` }]);
      paragraph.insert(0, [text]);
      target.fragment.push([paragraph]);
    }
    attempts++;
    await wait(800);
  }
  return null;
}


function findDuplicates(ytext: string, markers: Set<string>): string[] {
  const duplicates: string[] = [];
  for (const marker of markers) {
    const firstIdx = ytext.indexOf(marker);
    if (firstIdx !== -1) {
      const secondIdx = ytext.indexOf(marker, firstIdx + marker.length);
      if (secondIdx !== -1) {
        duplicates.push(marker);
      }
    }
  }
  return duplicates;
}


describe('server-authoritative stress (US-013)', () => {
  let server: TestServer;

  beforeAll(async () => {
    server = await createTestServer();
  });

  afterAll(async () => {
    await server?.cleanup();
  });

  test('5-client stress: 30s mixed WYSIWYG + source edits converge', async () => {
    let seed: number;
    if (process.env.STRESS_SEED !== undefined) {
      const raw = process.env.STRESS_SEED;
      const parsed = Number(raw);
      if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
        throw new Error(
          `STRESS_SEED must be a finite integer, got ${JSON.stringify(raw)}. ` +
            `Example: STRESS_SEED=42 bun test tests/stress/server-authoritative-stress.test.ts`,
        );
      }
      seed = parsed;
    } else {
      seed = Date.now();
    }
    console.log(
      `[server-authoritative stress] seed=${seed}${process.env.STRESS_SEED ? ' (replay)' : ''}`,
    );
    const rng = createPRNG(seed);
    const clientCount = 5;
    const docName = `stress-${crypto.randomUUID()}`;
    const durationMs = 30_000;

    const clients = await createTestClients(server.port, {
      count: clientCount,
      docName,
      perClientOptions: { skipInvariantWatcher: true },
    });

    try {
      const allMarkers = new Set<string>();
      let editCount = 0;
      let authoredBytes = 0;
      const testStart = Date.now();

      while (Date.now() - testStart < durationMs) {
        const clientIdx = rng.nextInt(clientCount);
        const client = clients[clientIdx];
        const editType = rng.next() < 0.8 ? 'wysiwyg' : 'source';
        const marker = `s-${editCount}-c${clientIdx}-${editType === 'wysiwyg' ? 'w' : 's'}-${rng.nextInt(10000)}`;
        allMarkers.add(marker);
        authoredBytes += Buffer.byteLength(marker) + 4;

        if (editType === 'wysiwyg') {
          wysiwygAppend(client, marker);
        } else {
          sourceAppend(client, marker);
        }

        editCount++;
        const delay = 200 + rng.nextInt(300); // 200-500ms
        await wait(delay);
      }

      const converged = await driveToConvergence(clients, 60_000);

      if (converged === null) {
        for (let i = 0; i < clients.length; i++) {
          const c = clients[i];
          console.warn(
            `[stress] Client ${i}: ytext=${c.ytext.toString().length}ch, ` +
              `frag=${serializeFragment(c.fragment).length}ch`,
          );
        }
      }

      expect(converged).not.toBeNull();
      // biome-ignore lint/style/noNonNullAssertion: guarded by expect above
      const convergenceMs = converged!;

      for (const c of clients) {
        assertBridgeInvariant(c.ytext, c.fragment);
      }

      for (let i = 0; i < clients.length; i++) {
        const c = clients[i];
        const ytextStr = c.ytext.toString();
        const dupes = findDuplicates(ytextStr, allMarkers);
        if (dupes.length > 0) {
          const fragMd = serializeFragment(c.fragment);
          const perMarkerDetail = dupes.map((dup) => {
            const first = ytextStr.indexOf(dup);
            const second = ytextStr.indexOf(dup, first + dup.length);
            const sliceStart1 = Math.max(0, first - 150);
            const sliceStart2 = Math.max(0, second - 150);
            return {
              marker: dup,
              firstPos: first,
              secondPos: second,
              gap: second - first,
              firstWindow: ytextStr.slice(sliceStart1, first + dup.length + 150),
              secondWindow: ytextStr.slice(sliceStart2, second + dup.length + 150),
            };
          });
          const firstDup = dupes[0];
          const escapedFirst = firstDup.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          const dupRegex = new RegExp(escapedFirst, 'g');
          const allClientDupCounts = clients.map((cc, j) => ({
            client: j,
            count: (cc.ytext.toString().match(dupRegex) || []).length,
          }));
          console.warn(
            JSON.stringify({
              event: 'stress-duplicate-detected',
              seed,
              editCount,
              clientCount,
              affectedClient: i,
              duplicateMarkers: dupes,
              ytextLength: ytextStr.length,
              fragLength: fragMd.length,
              perMarkerDetail,
              allClientDupCountsFor: firstDup,
              allClientDupCounts,
            }),
          );
        }
        expect(dupes).toEqual([]);

        expect(Buffer.byteLength(ytextStr)).toBeLessThanOrEqual(authoredBytes * 2 + 512);
      }

      console.log(
        `[stress] Complete: ${editCount} edits across ${clientCount} clients, ` +
          `convergence in ${convergenceMs}ms, seed=${seed}`,
      );
      process.stdout.write(
        `[stress] RESULT outcome=pass seed=${seed} edits=${editCount} convergenceMs=${convergenceMs}\n`,
      );
    } finally {
      for (const c of clients) await c.cleanup();
    }
  }, 120_000);
});
