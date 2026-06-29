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

async function runSessionBatch(
  n: number,
  transactsPerSession: number,
): Promise<{ durationMs: number; heapDeltaBytes: number }> {
  const docName = `nfr7-${crypto.randomUUID()}`;

  const heapBefore = process.memoryUsage().heapUsed;
  const start = performance.now();

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

    const baseline = await runSessionBatch(1, TRANSACTS);

    const load = await runSessionBatch(10, TRANSACTS);

    const timeRatio = load.durationMs / Math.max(baseline.durationMs, 1);
    expect(timeRatio).toBeLessThan(20);

    const baselineHeap = Math.max(baseline.heapDeltaBytes, 1024 * 1024); // floor 1 MB
    const loadHeap = Math.max(load.heapDeltaBytes, 0);
    const heapRatio = loadHeap / baselineHeap;
    expect(heapRatio).toBeLessThan(10);

    expect(load.durationMs).toBeLessThan(30_000);

    const heapDeltaMb = loadHeap / (1024 * 1024);
    expect(heapDeltaMb).toBeLessThan(200);
  }, 60_000);
});
