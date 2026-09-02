import { appendFileSync } from 'node:fs';
import { setTimeout as wait } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { HARNESS_BOOT_TIMEOUT_MS } from './harness-boot-timeout';
import {
  agentUndo,
  agentWriteMd,
  createTestClients,
  createTestServer,
  pollUntil,
  serializeFragment,
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

async function settle(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await wait(25);
  }
  return false;
}

describe('W5 agent undo across an edge-run write (corrected timing)', () => {
  test('FWD-04b: undo restores pre-write bytes and fragments on every peer', async () => {
    const docName = `qa-undo-${crypto.randomUUID()}`;
    const rawId = crypto.randomUUID().replace(/-/g, '').slice(0, 12);
    const connectionId = `agent-${rawId}`;
    const original = 'Original.\n';
    const withRuns = '\n\nHead.\n\nTail.\n\n\n';
    const clients = await createTestClients(server.port, {
      count: 2,
      docName,
      perClientOptions: { skipInvariantWatcher: true },
    });
    try {
      await agentWriteMd(server.port, original, { docName, position: 'replace', agentId: rawId });
      await pollUntil(() => clients.every((c) => c.ytext.toString() === original), 10_000);
      await wait(600);
      await agentWriteMd(server.port, withRuns, { docName, position: 'replace', agentId: rawId });
      await pollUntil(() => clients.every((c) => c.ytext.toString() === withRuns), 10_000);
      await wait(600);

      await agentUndo(server.port, { docName, connectionId, scope: 'last' });
      const converged = await settle(
        () =>
          clients.every(
            (c) => c.ytext.toString() === original && serializeFragment(c.fragment) === original,
          ),
        8000,
      );
      diag('FWD-04b', {
        converged,
        ytext: clients.map((c) => c.ytext.toString()),
        fragment: clients.map((c) => serializeFragment(c.fragment)),
      });
      for (const c of clients) {
        expect(c.ytext.toString(), 'undo restores pre-write bytes').toBe(original);
        expect(serializeFragment(c.fragment), 'undo re-derives fragments').toBe(original);
      }
    } finally {
      for (const c of clients) await c.cleanup();
    }
  }, 60_000);
});
