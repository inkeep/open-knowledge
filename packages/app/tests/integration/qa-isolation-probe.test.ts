import { appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { describe, expect, test } from 'vitest';
import {
  agentWriteMd,
  createTestClients,
  createTestServer,
  pollUntil,
  readTestDoc,
  serializeFragment,
} from './test-harness';

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

describe('isolation: external disk edit trajectory', () => {
  test('ISO-06: a live disk edit adding edge runs reaches Y.Text (30s trajectory + rescue)', async () => {
    const server = await createTestServer();
    const docName = `qa-iso-${crypto.randomUUID()}`;
    const clients = await createTestClients(server.port, {
      count: 2,
      docName,
      perClientOptions: { skipInvariantWatcher: true },
    });
    try {
      const seed = 'Above.\n\nBelow.\n';
      await agentWriteMd(server.port, seed, { docName, position: 'replace' });
      await pollUntil(() => clients.every((c) => c.ytext.toString() === seed), 10_000);
      expect(await settle(() => readTestDoc(server.contentDir, docName) === seed, 12_000)).toBe(
        true,
      );
      await wait(1500);

      const withRuns = '\n\nAbove.\n\nBelow.\n\n\n';
      writeFileSync(join(server.contentDir, `${docName}.md`), withRuns, 'utf-8');
      const trajectory: Array<Record<string, unknown>> = [];
      let rescued = false;
      for (let s = 0; s < 30; s++) {
        await wait(1000);
        const state = {
          t: s + 1,
          ytext: clients[0].ytext.toString(),
          disk: readTestDoc(server.contentDir, docName),
        };
        trajectory.push(state);
        if (state.ytext === withRuns) break;
        if (s === 9 && !rescued) {
          rescued = true;
          await fetch(`http://127.0.0.1:${server.port}/api/test-rescan-files`, {
            method: 'POST',
          }).catch(() => null);
        }
      }
      diag('ISO-06', { trajectory, rescued, fragment: serializeFragment(clients[0].fragment) });
      expect(clients[0].ytext.toString(), 'external edit reached Y.Text').toBe(withRuns);
      expect(readTestDoc(server.contentDir, docName), 'external edit not clobbered on disk').toBe(
        withRuns,
      );
    } finally {
      for (const c of clients) await c.cleanup();
      await server.cleanup();
    }
  }, 90_000);
});
