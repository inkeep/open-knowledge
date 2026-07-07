/**
 * Per-session UndoManager performance gate.
 *
 * Verifies that N=10 concurrent sessions each running 100 transacts completes
 * within proportional time and memory bounds relative to a single-session
 * baseline — proving the per-session UndoManager design scales linearly, not
 * exponentially.
 *
 * Tier: 2 (nightly). Run via `bun run test:perf:sessions` or
 * `bunx turbo run test:perf:sessions`. Not part of `bun run check` (tier 1).
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { HARNESS_BOOT_TIMEOUT_MS } from './harness-boot-timeout';
import type { TestServer } from './test-harness';
import { createTestServer } from './test-harness';

let server: TestServer;

beforeAll(async () => {
  server = await createTestServer();
}, HARNESS_BOOT_TIMEOUT_MS);

afterAll(async () => {
  await server.cleanup();
});

/**
 * Run N sessions on a fresh doc, each executing T transacts.
 * Returns elapsed time in ms and heap delta in bytes.
 */
async function runSessionBatch(
  n: number,
  transactsPerSession: number,
): Promise<{ durationMs: number; heapDeltaBytes: number }> {
  const docName = `nfr7-${crypto.randomUUID()}`;

  const heapBefore = process.memoryUsage().heapUsed;
  const start = performance.now();

  // Sequential creation avoids overwhelming the test server with concurrent
  // openDirectConnection calls — the timer still covers all N sessions.
  for (let i = 0; i < n; i++) {
    const session = await server.instance.sessionManager.getSession(docName, `perf-agent-${i}`);
    for (let t = 0; t < transactsPerSession; t++) {
      session.dc.document.transact(() => {
        session.dc.document.getText('source').insert(0, 'x');
      }, session.origin);
    }
  }

  const durationMs = performance.now() - start;
  const heapDeltaBytes = process.memoryUsage().heapUsed - heapBefore;

  await server.instance.sessionManager.closeAllForDoc(docName);

  return { durationMs, heapDeltaBytes };
}

describe('NFR-7: per-session UndoManager proportional cost', () => {
  test('N=10 sessions × 100 transacts completes within proportional bounds vs single-session baseline', async () => {
    const TRANSACTS = 100;

    // Baseline: 1 session × 100 transacts
    const baseline = await runSessionBatch(1, TRANSACTS);

    // Load: 10 sessions × 100 transacts
    const load = await runSessionBatch(10, TRANSACTS);

    // time must not grow super-linearly (< 20× baseline for 10× sessions)
    // The 20× ceiling absorbs scheduling jitter without masking O(N²) regressions.
    const timeRatio = load.durationMs / Math.max(baseline.durationMs, 1);
    expect(timeRatio).toBeLessThan(20);

    // heap delta must not grow super-linearly (<10× baseline for 10× sessions).
    // Negative deltas (GC freed more than allocated) are treated as 0 for ratio math.
    const baselineHeap = Math.max(baseline.heapDeltaBytes, 1024 * 1024); // floor 1 MB
    const loadHeap = Math.max(load.heapDeltaBytes, 0);
    const heapRatio = loadHeap / baselineHeap;
    expect(heapRatio).toBeLessThan(10);

    // absolute wall-clock ceiling — 10 sessions × 100 transacts must finish in < 30s
    expect(load.durationMs).toBeLessThan(30_000);

    // absolute heap ceiling — < 200 MB for 10 sessions (not 10× 200 MB)
    const heapDeltaMb = loadHeap / (1024 * 1024);
    expect(heapDeltaMb).toBeLessThan(200);
  }, 60_000);
});
