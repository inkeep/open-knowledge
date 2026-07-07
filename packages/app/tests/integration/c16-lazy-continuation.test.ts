/**
 * C16: CommonMark lazy-continuation docs — multi-client convergence without
 * bridge health-check churn.
 *
 * A doc whose source carries a lazy continuation (an unindented wrapped
 * line inside a list item) rests byte-divergent beyond every normalizeBridge
 * class by design; the fragment still IS `parse(ytext)` (precedent #38).
 * Multi-client coverage per the observer-bridge rule: single-client rigs
 * miss remote-peer divergence, and this changeset touches
 * `server-observers.ts`.
 *
 * Pins, through the real client → server → client collab pipeline:
 *   - a WYSIWYG edit on a resting lazy-continuation doc converges on every
 *     peer with the authored bytes preserved verbatim (no sanitize, no
 *     canonical rewrite) and no `bridge-split-brain-rederive` emission for
 *     the doc;
 *   - the harness bridge-invariant watcher's parse-equivalence fallback
 *     does NOT swallow genuine divergence — a paired-origin transaction
 *     that moves Y.Text without the fragment still throws.
 *
 * Per-test docName isolation via createTestClients(port, { count }) default.
 * Client lifecycle in try/finally (not afterEach) per R8a.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { setTimeout as wait } from 'node:timers/promises';
import { BridgeInvariantViolationError } from '@inkeep/open-knowledge-core';
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

const LAZY_SOURCE =
  '- Also read at session start: operating rules,\ncontinues without indent on the next line.\n\nBody text stays.\n';
const PRESERVED_SLICE = 'operating rules,\ncontinues without indent';

/** Append a paragraph with the given text to a client's XmlFragment. */
function appendParagraph(client: TestClient, text: string): void {
  const paragraph = new Y.XmlElement('paragraph');
  const ytext = new Y.XmlText();
  ytext.applyDelta([{ insert: text }]);
  paragraph.insert(0, [ytext]);
  client.fragment.push([paragraph]);
}

/** Capture structured console.warn events for one docName while `fn` runs
 *  and the post-window settles. Filtering by docName keeps the capture safe
 *  under parallel test files sharing the process console. */
async function captureDocEvents(
  docName: string,
  eventName: string,
  fn: () => Promise<void>,
): Promise<Record<string, unknown>[]> {
  const originalWarn = console.warn;
  const lines: string[] = [];
  console.warn = (...args: unknown[]) => {
    lines.push(args.map(String).join(' '));
    originalWarn(...args);
  };
  try {
    await fn();
  } finally {
    console.warn = originalWarn;
  }
  return lines
    .map((l) => {
      try {
        return JSON.parse(l) as Record<string, unknown>;
      } catch {
        return null;
      }
    })
    .filter((e): e is Record<string, unknown> => e !== null)
    .filter((e) => e.event === eventName && e['doc.name'] === docName);
}

describe('C16: lazy-continuation docs across clients', () => {
  test('WYSIWYG edit on a resting lazy-continuation doc converges on both peers without rederive churn', async () => {
    const clients = await createTestClients(server.port, { count: 2 });
    try {
      // Client A authors the lazy continuation through the source surface
      // (W2) — the organic path that leaves Y.Text beyond byte tolerance
      // while the server derives the fragment from parse(ytext).
      clients[0].doc.transact(() => {
        clients[0].ytext.insert(0, LAZY_SOURCE);
      });
      await pollUntil(() => clients[1].ytext.toString().includes('Body text stays.'), 5000);
      await wait(500);

      // Client B edits WYSIWYG-side while the doc rests beyond tolerance.
      const events = await captureDocEvents(
        clients[0].docName,
        'bridge-split-brain-rederive',
        async () => {
          appendParagraph(clients[1], 'C16-CLIENT-B-WYSIWYG');
          for (const c of clients) {
            await pollUntil(() => c.ytext.toString().includes('C16-CLIENT-B-WYSIWYG'), 5000);
          }
          await wait(500);
        },
      );
      expect(events).toHaveLength(0);

      // Authored source form survives verbatim on every peer alongside the
      // new content; peers agree byte-for-byte.
      const ytexts = clients.map((c) => c.ytext.toString());
      for (const t of ytexts) {
        expect(t).toContain(PRESERVED_SLICE);
        expect(t).toContain('C16-CLIENT-B-WYSIWYG');
      }
      expect(ytexts[1]).toBe(ytexts[0]);
      for (const c of clients) {
        expect(serializeFragment(c.fragment)).toContain('C16-CLIENT-B-WYSIWYG');
        assertBridgeInvariant(c.ytext, c.fragment);
      }
    } finally {
      for (const c of clients) {
        await c.cleanup();
      }
    }
  });

  test('harness watcher fallback does not swallow genuine divergence — one-sided paired write still throws', async () => {
    const clients = await createTestClients(server.port, { count: 1 });
    try {
      clients[0].doc.transact(() => {
        clients[0].ytext.insert(0, 'Settled paragraph.\n');
      });
      await pollUntil(
        () => serializeFragment(clients[0].fragment).includes('Settled paragraph.'),
        5000,
      );
      await wait(500);

      // A paired-marked origin promises "both CRDTs mutated atomically";
      // moving ONLY Y.Text under it is a genuine fragment↔Y.Text divergence
      // (content the fragment lacks), which no parse-equivalence fallback
      // may bridge — the watcher must keep throwing on the drain.
      const onesidedPairedOrigin = { context: { paired: true } };
      expect(() => {
        clients[0].doc.transact(() => {
          clients[0].ytext.insert(0, 'Smuggled one-sided content.\n');
        }, onesidedPairedOrigin);
      }).toThrow(BridgeInvariantViolationError);
    } finally {
      for (const c of clients) {
        await c.cleanup();
      }
    }
  });
});
