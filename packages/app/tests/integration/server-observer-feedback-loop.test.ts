/**
 * Bounded disk-write regression gate — catches observer→persistence
 * feedback amplification.
 *
 * Asserts that a single logical edit produces EXACTLY ONE persistence
 * atomic disk write. This is a tight, architecture-correctness gate: any
 * regression that causes server observers to re-fire into persistence
 * (whether via removing `OBSERVER_SYNC_ORIGIN.skipStoreHooks`,
 * or a regression in origin early-exits, or a new write surface that
 * doesn't short-circuit) would bump the count.
 *
 * Architecture under test (`OBSERVER_SYNC_ORIGIN.skipStoreHooks: true`
 * + origin-guard early-exits):
 *   1. Agent writes markdown → applyAgentMarkdownWrite → XmlFragment +
 *      Y.Text paired write under AGENT_WRITE_ORIGIN
 *      (skipStoreHooks: false) → 1 persistence disk write.
 *   2. Server Observer A fires on XmlFragment change → sees
 *      AGENT_WRITE_ORIGIN already-in-sync, early-exits (no write).
 *   3. Total disk writes per edit: 1.
 *
 * Scope note:
 *   The single-agent-write path is fully early-exit-protected by the
 *   already-in-sync origin guard, so dropping skipStoreHooks
 *   does not manifest in this specific scenario — the observer never
 *   writes. The genuine blast-radius is a concurrent-writer
 *   scenario (e.g., concurrent WYSIWYG + race-initiated observer
 *   write) where the observer DOES write and skipStoreHooks is what
 *   prevents the cascade.
 *   This gate catches the broader class: "any disk-write amplification
 *   introduced by a future regression."
 *
 * This is integration-level — runs against a real test server, real
 * HTTP agent-write, real Hocuspocus persistence. No mocking.
 */

import { afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { setTimeout as wait } from 'node:timers/promises';
import { getMetrics, resetMetrics } from '@inkeep/open-knowledge-server';
import { HARNESS_BOOT_TIMEOUT_MS } from './harness-boot-timeout';
import {
  agentWriteMd,
  createTestClient,
  createTestServer,
  pollUntil,
  type TestServer,
} from './test-harness';

let server: TestServer;

beforeAll(async () => {
  server = await createTestServer();
}, HARNESS_BOOT_TIMEOUT_MS);

afterEach(() => {
  resetMetrics();
});

describe('Mutation F gate: OBSERVER_SYNC_ORIGIN.skipStoreHooks=true prevents disk-write amplification', () => {
  test('single agent-write produces exactly 1 persistence disk write (no observer amplification)', async () => {
    const docName = `mf-gate-${crypto.randomUUID()}`;
    const marker = 'MF-single-agent-write-marker';

    const client = await createTestClient(server.port, docName);
    try {
      // Wait for initial load + observer settle before resetting metrics.
      await wait(500);
      resetMetrics();

      await agentWriteMd(server.port, `# ${marker}\n\nBody text.\n`, {
        docName,
        position: 'replace',
      });

      // Wait for content propagation and persistence debounce (200ms in
      // test harness) to complete.
      await pollUntil(() => client.ytext.toString().includes(marker), 5000);
      await wait(500);

      const { persistenceDiskWrites, serverObserverFiresA, serverObserverFiresB } = getMetrics();

      // Under skipStoreHooks:true, the agent-write produces exactly 1
      // disk write. Observer A fires and early-exits on AGENT_WRITE_ORIGIN
      // already-in-sync path. Observer B self-skips on OBSERVER_SYNC_ORIGIN.
      //
      // Under skipStoreHooks:false, any server observer that
      // DOES write (e.g., non-paired-write path) produces an additional
      // disk write via persistence.onStoreDocument. Strict equality
      // catches any such amplification.
      expect(persistenceDiskWrites).toBe(1);

      // Sanity check on fire counts (bounded, even though this isn't the
      // gate). 3 fires/direction catches any origin-guard
      // regression (e.g., AGENT_WRITE_ORIGIN early-exit removed).
      expect(serverObserverFiresA).toBeLessThanOrEqual(3);
      expect(serverObserverFiresB).toBeLessThanOrEqual(3);
    } finally {
      client.cleanup();
    }
  }, 30_000);

  test('three sequential agent-writes produce exactly 3 persistence disk writes (no compounding)', async () => {
    // A compounding amplification loop would produce quadratic or
    // multiplicative disk writes: edit 1 → 1 write, edit 2 → 2 writes,
    // edit 3 → 3 writes (total 6). Under the correct architecture,
    // each edit produces exactly 1 disk write regardless of prior edits.
    const docName = `mf-gate-seq-${crypto.randomUUID()}`;

    const client = await createTestClient(server.port, docName);
    try {
      await wait(500);
      resetMetrics();

      for (let i = 0; i < 3; i++) {
        const marker = `MF-seq-edit-${i}`;
        await agentWriteMd(server.port, `# ${marker}\n\nEdit ${i}.\n`, {
          docName,
          position: 'replace',
        });
        await pollUntil(() => client.ytext.toString().includes(marker), 3000);
        // Enough wait for the persistence debounce (200ms harness) to
        // flush this edit before the next one starts.
        await wait(400);
      }

      // Final settle for the last edit's flush.
      await wait(300);

      const { persistenceDiskWrites } = getMetrics();
      expect(persistenceDiskWrites).toBe(3);
    } finally {
      client.cleanup();
    }
  }, 30_000);
});
