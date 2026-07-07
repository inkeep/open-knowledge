/**
 * bridge invariant watchdog — multi-client integration coverage.
 *
 * The watchdog (attachBridgeInvariantWatcher / assertBridgeInvariant) was
 * unit-tested at the string-pair level and exercised by single-Y.Doc
 * server-observer tests. The multi-client integration tests pass
 * `skipInvariantWatcher: true`, so multi-peer drain behavior was untested
 * at the unit tier — leaving a coverage gap on the rule that "changes to
 * server-observers.ts require multi-client integration tests."
 *
 * This file closes the gap. Two scenarios:
 *   1. Concurrent multi-surface writes from 3 peers (ytext source-mode +
 *      WYSIWYG XmlFragment + agent paired-write) — every peer has the
 *      watcher attached; the test passes by absence of throw.
 *   2. Post-divergence recovery — drive a deliberate divergence on one
 *      peer with the watcher disabled, allow drain to settle, attach a
 *      fresh watcher and confirm steady-state quiet.
 *
 * Pattern after `c8-triple-concurrent.test.ts`. Watcher attachment is the
 * key differentiator — `createTestClient` defaults `skipInvariantWatcher`
 * to false, so omitting the option in `perClientOptions` is sufficient.
 * Explicit `skipInvariantWatcher: false` here for documentation.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { setTimeout as wait } from 'node:timers/promises';
import * as Y from 'yjs';
import { HARNESS_BOOT_TIMEOUT_MS } from './harness-boot-timeout';
import {
  agentWriteMd,
  assertAllConverged,
  createTestClient,
  createTestClients,
  createTestServer,
  getServerState,
  pollUntil,
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

/** Append a paragraph with the given text to a client's XmlFragment. */
function appendParagraph(client: TestClient, text: string): void {
  const paragraph = new Y.XmlElement('paragraph');
  const ytext = new Y.XmlText();
  ytext.applyDelta([{ insert: text }]);
  paragraph.insert(0, [ytext]);
  client.fragment.push([paragraph]);
}

/** Append text to ytext (source-mode write surface). */
function appendYtext(client: TestClient, text: string): void {
  const cur = client.ytext.toString();
  client.ytext.insert(cur.length, text);
}

describe('FR-31 bridge watchdog — multi-peer drain', () => {
  test('concurrent ytext + WYSIWYG + agent writes from 3 peers — watchdog stays quiet', async () => {
    const docName = `wd-multi-${crypto.randomUUID()}`;

    // All 3 clients have `attachBridgeInvariantWatcher` attached (default).
    // If the watcher fires under any client during drain, it throws
    // BridgeInvariantViolationError and fails this test.
    const clients = await createTestClients(server.port, {
      count: 3,
      docName,
      perClientOptions: { skipInvariantWatcher: false },
    });

    try {
      // Seed via agent paired-write so all clients start from a known body.
      await agentWriteMd(server.port, '# Seed\n\nBaseline.\n', {
        docName,
        position: 'replace',
      });
      for (const c of clients) {
        await pollUntil(() => c.ytext.toString().includes('Baseline'), 5000);
      }
      await wait(200);

      // Drive concurrent multi-surface writes:
      //  - client[0]: WYSIWYG XmlFragment paragraph append
      //  - client[1]: ytext source-mode paragraph append
      //  - agent: paired-write via HTTP API
      appendParagraph(clients[0], 'WD-MULTI-WYSIWYG');
      appendYtext(clients[1], '\n\nWD-MULTI-YTEXT\n');
      await agentWriteMd(server.port, '\n\nWD-MULTI-AGENT\n', {
        docName,
        position: 'append',
      });

      // The local WYSIWYG + ytext writes mutate Y.Doc state synchronously, but
      // the agent paired-write returns from HTTP before its server-side delta
      // has been broadcast over WS. assertAllConverged returns the moment all
      // peers AGREE, which can include a transient `{seed + WYSIWYG + YTEXT}`
      // intermediate state where the two local writes have propagated round-
      // trip but the agent's append hasn't landed yet. The expects below would
      // then fail on the missing AGENT marker. Wait for the agent marker on at
      // least one peer first.
      await pollUntil(() => clients[0].ytext.toString().includes('WD-MULTI-AGENT'), 8000);

      await assertAllConverged(clients, { timeout: 8000 });

      const text = clients[0].ytext.toString();
      expect(text).toContain('WD-MULTI-WYSIWYG');
      expect(text).toContain('WD-MULTI-YTEXT');
      expect(text).toContain('WD-MULTI-AGENT');

      const serverState = getServerState(server, docName);
      expect(serverState).toBeTruthy();
    } finally {
      for (const c of clients) await c.cleanup();
    }
  });

  test('drain settles cleanly after a deliberate divergence (recovery test)', async () => {
    const docName = `wd-recover-${crypto.randomUUID()}`;

    // First client opts out so we can drive a brief divergence without
    // the watcher throwing mid-drain. Steady-state recovery is what's
    // under test — not the in-flight watchdog.
    const driver = await createTestClient(server.port, docName, {
      skipInvariantWatcher: true,
    });

    try {
      await agentWriteMd(server.port, '# Recovery\n\nSeed.\n', {
        docName,
        position: 'replace',
      });
      await pollUntil(() => driver.ytext.toString().includes('Seed'), 5000);
      await wait(200);

      // Drive a divergence: WYSIWYG + ytext + agent in a tight burst.
      appendParagraph(driver, 'WD-RECOVER-WYSIWYG');
      appendYtext(driver, '\n\nWD-RECOVER-YTEXT\n');
      await agentWriteMd(server.port, '\n\nWD-RECOVER-AGENT\n', {
        docName,
        position: 'append',
      });

      // Allow the drain to settle.
      await pollUntil(
        () =>
          driver.ytext.toString().includes('WD-RECOVER-WYSIWYG') &&
          driver.ytext.toString().includes('WD-RECOVER-YTEXT') &&
          driver.ytext.toString().includes('WD-RECOVER-AGENT'),
        8000,
      );
      await wait(500);

      // Attach a watcher on a FRESH client. If steady-state quiescence
      // holds, the watcher syncs, observes the converged state, and never
      // fires. A persistent post-drain divergence would make the watcher
      // throw on its first observation.
      const watcher = await createTestClient(server.port, docName, {
        skipInvariantWatcher: false,
      });
      try {
        await pollUntil(() => watcher.ytext.toString().includes('WD-RECOVER-WYSIWYG'), 5000);
        await assertAllConverged([driver, watcher], { timeout: 5000 });
      } finally {
        await watcher.cleanup();
      }
    } finally {
      await driver.cleanup();
    }
  });
});
