/**
 * Server-authoritative bridge stress test.
 *
 * 5 clients x 30s of randomized mixed WYSIWYG + source edits against a real
 * Hocuspocus server. Measures end-to-end convergence timing after edit bursts
 * rather than instrumenting internal observer debounce callbacks.
 *
 * budget rationale:
 *   The convergence budget is generous because 5 concurrent clients produce
 *   significant cross-client CRDT merge load. Observer A debounce is 50ms,
 *   Observer B typing-defer is 300ms, CRDT WebSocket propagation is <50ms per
 *   hop. With 5 clients the full propagation chain is:
 *     edit → local observer → WebSocket → server merge → broadcast → 4 peers
 *       → each peer observer → settle
 *   Under load, this chain takes 1-3s typical. The 25s final convergence gate
 *   accounts for macOS scheduler jitter and accumulated edit volume.
 *
 * Design:
 *   - Each client makes a random edit (WYSIWYG paragraph append or Y.Text
 *     insert) every 200-500ms for 30s total
 *   - After edits stop, convergence is measured with a generous timeout
 *   - Final assertions: all clients converged, no duplicate markers, bridge
 *     invariant holds on all clients
 *   - skipInvariantWatcher: true (stress tests drive transient divergence)
 *
 * Deterministic enough to pass reliably: edits are append-only (no conflicting
 * overwrites), convergence is measured only after ALL edits stop (no mid-burst
 * measurement that races with in-flight ops).
 */

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

// ─── Seeded PRNG (xorshift32 — consistent with bridge-convergence.fuzz.test.ts) ───

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

// ─── Edit helpers ───

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

// ─── Active convergence driver ───

/**
 * Drive all clients to convergence using the same pattern as the fuzz test's
 * driveToConvergence:
 * 1. Wait for CRDT sync to settle (1.5s initial)
 * 2. Tickle ONE client at a time (round-robin) to force Observer A debounce
 * 3. Poll until all clients agree on ytext + fragment + bridge invariant
 *
 * Returns convergence time in ms, or null on timeout.
 */
async function driveToConvergence(
  clients: TestClient[],
  timeoutMs: number,
): Promise<number | null> {
  const start = Date.now();

  // Phase 1: initial settle for CRDT sync
  await wait(1500);

  // Phase 2: tickle + poll loop
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

    // Tickle ONE client to trigger Observer A reconciliation (round-robin).
    // Limit tickle attempts to avoid adding too much content.
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

// ─── No-duplicates oracle ───

/**
 * Check that no marker text appears more than once in a client's Y.Text.
 * Stress edits use unique markers, so any duplicate indicates a CRDT merge
 * or observer bug.
 */
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

// ─── Main test ───

describe('server-authoritative stress (US-013)', () => {
  let server: TestServer;

  beforeAll(async () => {
    server = await createTestServer();
  });

  afterAll(async () => {
    await server?.cleanup();
  });

  test('5-client stress: 30s mixed WYSIWYG + source edits converge', async () => {
    // Seed resolution: STRESS_SEED env wins (deterministic replay), otherwise
    // Date.now() for a fresh sample per run. The banner below is emitted
    // BEFORE any setup work so a pre-loop crash still leaves a seed trail in
    // the stdout — ad-hoc measurement scripts (`packages/app/scripts/
    // measure-stress.sh`) parse this exact banner to populate the JSONL
    // trend log's `stressSeed` and `failingSeeds` fields. Changing the
    // banner format is a breaking change for the measurement script's
    // regex.
    // Determinism contract: if STRESS_SEED is set, it MUST parse to a finite
    // integer. `Number("abc")` silently returns NaN, which would propagate
    // into XorShift and produce a non-deterministic run while the banner
    // still printed `seed=NaN` — destroying the one guarantee this script
    // sells. Throwing on malformed input keeps "I replayed seed 42" and
    // "I typoed and got a fresh random seed" observably distinct.
    // This throw fires before the seed banner, so measure-stress.sh sees
    // neither banner nor RESULT line and aborts without appending a record.
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
      // byte budget: running sum of authored content bytes (marker + minimal
      // per-write structure). The converged doc must stay within a small
      // multiple of this — unbounded growth past it is the M-7110 amplifier.
      let authoredBytes = 0;
      const testStart = Date.now();

      // ── Edit phase: 30s of continuous random edits ──
      while (Date.now() - testStart < durationMs) {
        const clientIdx = rng.nextInt(clientCount);
        const client = clients[clientIdx];
        // 80% WYSIWYG, 20% source — WYSIWYG-heavy because source edits
        // trigger Observer B which needs typing-defer (300ms) to settle,
        // and under 5-client load the Observer A→B chain is the slowest
        // convergence path.
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

      // ── Convergence phase: wait for all edits to propagate ──
      // 60s timeout: 5 clients with ~90 accumulated edits need the full
      // Observer A debounce (50ms) + Observer B typing-defer (300ms) +
      // CRDT WebSocket propagation chain to settle across all peers.
      // The tickle loop forces Observer A on lagging clients.
      //
      // Timeout is 60s (not 25s) because this test runs under
      // `turbo --concurrency=100%` in `check:full:parallel`, competing with
      // 14 other turbo tasks for CPU. Under contention, convergence time
      // can easily 2-3× the isolated-run time. In isolated runs this
      // converges in ~1.5s; under full parallel load it may take 30-50s —
      // still a bounded wall-clock, but we need headroom. A test that's
      // genuinely non-converging would hang indefinitely (livelock),
      // which 60s still catches.
      const converged = await driveToConvergence(clients, 60_000);

      if (converged === null) {
        // Diagnostic: log per-client state for debugging
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

      // ── Bridge invariant on all clients ──
      for (const c of clients) {
        assertBridgeInvariant(c.ytext, c.fragment);
      }

      // ── No-duplicates oracle ──
      // Diagnostic dump on the rare CI-only flake.
      // When
      // the oracle catches a duplicate, log structured state BEFORE the
      // assertion fires so the CI artifact is diagnostically complete:
      //   - seed (run identity; marker format embeds editCount+clientIdx but
      //     not seed, so this is the only way to correlate re-runs)
      //   - affected client + duplicate marker(s)
      //   - byte positions + ±150-char window around each duplicate (shows
      //     content context; the gap hints at whether both insertions landed
      //     in the same merge region or across regions)
      //   - per-client count of the first duplicate marker (shows whether the
      //     duplicate is on one client only, or propagated to all via CRDT)
      // No product code touched — this is test-side observation only.
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

        // byte budget: the converged doc stays within a small multiple of the
        // authored content. A 5-client 30s run authors only small markers, so a
        // doc that grew past ~2x authored + slack is the unbounded-growth
        // amplifier signature.
        expect(Buffer.byteLength(ytextStr)).toBeLessThanOrEqual(authoredBytes * 2 + 512);
      }

      // ── Summary ──
      console.log(
        `[stress] Complete: ${editCount} edits across ${clientCount} clients, ` +
          `convergence in ${convergenceMs}ms, seed=${seed}`,
      );
      // Machine-parseable result line — measure-stress.sh greps this to
      // classify pass/fail without relying on bun test's human-readable
      // `N pass / N fail` summary (which is fragile to bun output drift
      // and sensitive to stderr conflation via `2>&1`). Format:
      //   [stress] RESULT outcome=pass seed=<n> edits=<n> convergenceMs=<n>
      // Always emitted via process.stdout.write (not console.log) so no
      // extra formatting is appended; always on stdout (never stderr) so
      // the script's stdout-only grep is unambiguous.
      process.stdout.write(
        `[stress] RESULT outcome=pass seed=${seed} edits=${editCount} convergenceMs=${convergenceMs}\n`,
      );
    } finally {
      for (const c of clients) await c.cleanup();
    }
  }, 120_000);
});
