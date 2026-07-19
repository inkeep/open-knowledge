/**
 * Stale-anchor interleave over an external-change wholesale replace.
 *
 * A sync-paused client (inbound paused, outbound flowing — the
 * ControllableWebSocket contract) types a source-mode insert anchored to
 * pre-replace Y.Text items while the file watcher applies a wholesale disk
 * replace. The bridge materializer must land the replaced content so that no
 * concurrent stale-anchored op can integrate INSIDE it: the replaced marker
 * line must survive contiguously on every converged peer, for either relative
 * clientID ordering (Yjs orders concurrent same-position inserts by clientID,
 * so a materializer that stitches new content out of reused old items splits
 * it only when the concurrent writer's clientID sorts first).
 *
 * Deterministic distillation of fuzz seeds 1784396512201 / 1784413394675 /
 * 1784413395177 (failClass content-preservation): forced clientIDs replace the
 * seeds' random-ordering coin flip.
 *
 * Per-test docName isolation; client lifecycle in try/finally.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { applyExternalChange } from '@inkeep/open-knowledge-server';
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

/**
 * Drive the interleave with the paused client's Y.Doc forced to `clientId`.
 * Returns the converged text (asserted byte-identical across peers first).
 */
async function runInterleave(clientId: number): Promise<string> {
  const docName = `stale-anchor-${clientId}-${crypto.randomUUID()}`;
  const clients = await createTestClients(server.port, {
    count: 2,
    docName,
    perClientOptions: { skipInvariantWatcher: true, syncControl: true },
  });
  const [live, paused] = clients;
  try {
    // Force the paused client's clientID BEFORE it authors any Y items, so
    // the concurrent-insert ordering is deterministic instead of the fuzz
    // harness's per-run coin flip. The server side allocates a random
    // uint32; 1 sorts below it (and 0xfffffffe above it) with probability
    // ~1 - 2^-32.
    paused.doc.clientID = clientId;

    await agentWriteMd(server.port, SEED_CONTENT, { docName, position: 'replace' });
    for (const c of clients) {
      await pollUntil(() => c.ytext.toString().includes('M3-'), 5000);
    }
    await wait(300);

    // Divergence window: the paused client stops RECEIVING; its own edits
    // still flow out (inbound-only pause).
    paused.pauseSync();

    // Server-side growth the paused client never sees (mirrors the seeds'
    // mid-window wysiwyg + jsx agent writes). A char-granular diff of the
    // subsequent replace would retain the doc-start 'M' and a trailing '\n'
    // from DIFFERENT generations with a large tombstone range between them —
    // the seam the stale-anchored insert integrates into.
    await agentWriteMd(
      server.port,
      '\n\nM4-echo delta golf\n\n<Steps>\n\n<Step>\n\nM5-jsx-bravo step body.\n\n</Step>\n\n</Steps>\n',
      { docName, position: 'append' },
    );
    await pollUntil(() => live.ytext.toString().includes('M5-'), 5000);

    // External wholesale replace lands on the server and reaches the live
    // client only.
    writeFileSync(join(server.contentDir, `${docName}.md`), REPLACED_CONTENT, 'utf-8');
    applyExternalChange(server.instance.hocuspocus, docName, REPLACED_CONTENT);
    await pollUntil(() => live.ytext.toString().includes('M6-'), 5000);

    // Concurrent stale-anchored insert: the paused client still sees the
    // pre-replace bytes, so this append anchors on pre-replace items.
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
    // The replaced marker line must not be split by the concurrent insert
    // integrating inside a reused-item seam.
    expect(converged).toContain(REPLACED_CONTENT.trimEnd());
    // The concurrent insert itself must also survive intact.
    expect(converged).toContain(CONCURRENT_LINE);
  }, 30_000);

  test('replaced content survives contiguously when the concurrent writer clientID sorts last', async () => {
    const converged = await runInterleave(0xfffffffe);
    expect(converged).toContain(REPLACED_CONTENT.trimEnd());
    expect(converged).toContain(CONCURRENT_LINE);
  }, 30_000);
});
