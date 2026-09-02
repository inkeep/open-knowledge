import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { applyExternalChange } from '@inkeep/open-knowledge-server';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { HARNESS_BOOT_TIMEOUT_MS } from './harness-boot-timeout';
import {
  agentWriteMd,
  assertBridgeInvariant,
  createTestClients,
  createTestServer,
  pollUntil,
  type TestServer,
} from './test-harness';

let server: TestServer;

beforeAll(async () => {
  server = await createTestServer();
}, HARNESS_BOOT_TIMEOUT_MS);

afterAll(async () => {
  await server.cleanup();
});

const SEED_CONTENT = 'M3-echo foxtrot\n';
const REPLACED_CONTENT = 'M6-hotel golf\n';
const CONCURRENT_LINE = 'M8-golf alpha alpha';

async function runInterleave(clientId: number): Promise<string> {
  const docName = `stale-anchor-${clientId}-${crypto.randomUUID()}`;
  const clients = await createTestClients(server.port, {
    count: 2,
    docName,
    perClientOptions: { skipInvariantWatcher: true, syncControl: true },
  });
  const [live, paused] = clients;
  try {
    paused.doc.clientID = clientId;

    await agentWriteMd(server.port, SEED_CONTENT, { docName, position: 'replace' });
    for (const c of clients) {
      await pollUntil(() => c.ytext.toString().includes('M3-'), 5000);
    }
    await wait(300);

    paused.pauseSync();

    await agentWriteMd(
      server.port,
      '\n\nM4-echo delta golf\n\n<Steps>\n\n<Step>\n\nM5-jsx-bravo step body.\n\n</Step>\n\n</Steps>\n',
      { docName, position: 'append' },
    );
    await pollUntil(() => live.ytext.toString().includes('M5-'), 5000);

    writeFileSync(join(server.contentDir, `${docName}.md`), REPLACED_CONTENT, 'utf-8');
    applyExternalChange(
      server.instance.durabilityState,
      server.instance.hocuspocus,
      docName,
      REPLACED_CONTENT,
    );
    await pollUntil(() => live.ytext.toString().includes('M6-'), 5000);

    paused.doc.transact(() => {
      paused.ytext.insert(paused.ytext.length, `\n\n${CONCURRENT_LINE}\n`);
    });
    await wait(300);

    paused.resumeSync();
    await pollUntil(
      () =>
        live.ytext.toString() === paused.ytext.toString() &&
        live.ytext.toString().includes(CONCURRENT_LINE),
      10_000,
    );
    await wait(600);

    const texts = clients.map((c) => c.ytext.toString());
    expect(texts[1]).toBe(texts[0]);
    for (const c of clients) assertBridgeInvariant(c.ytext, c.fragment);
    return texts[0];
  } finally {
    for (const c of clients) await c.cleanup();
  }
}

describe('external-change wholesale replace vs stale-anchored concurrent insert', () => {
  test('replaced content survives contiguously when the concurrent writer clientID sorts first', async () => {
    const converged = await runInterleave(1);
    expect(converged).toContain(REPLACED_CONTENT.trimEnd());
    expect(converged).toContain(CONCURRENT_LINE);
  }, 30_000);

  test('replaced content survives contiguously when the concurrent writer clientID sorts last', async () => {
    const converged = await runInterleave(0xfffffffe);
    expect(converged).toContain(REPLACED_CONTENT.trimEnd());
    expect(converged).toContain(CONCURRENT_LINE);
  }, 30_000);
});
