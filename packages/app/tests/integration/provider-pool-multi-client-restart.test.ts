/**
 * Multi-client fast restart.
 *
 * Extends the single-client fast restart repro in provider-pool-reconnect.test.ts
 * with a second connected pool, simulating two browser tabs open against the same
 * doc when the server restarts.
 *
 * Bug-class arithmetic: with N clients holding Y.Docs before the restart, the
 * post-restart sync union contains each client's clientID PLUS the server's
 * freshly-generated clientID. For N=2, the expected merged clientID set size is 3
 * (two client clientIDs + one server clientID). Content from the fresh-server-
 * clientID items duplicates the on-disk markdown.
 *
 * Expected: PASS post-fix. Regression guard for the multi-client restart duplication bug class
 * — marker counts at baseline and clientID-drift assertion holds. Any
 * reintroduction of the multi-client restart duplication trips this red.
 */
import './idb-preload';
import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import {
  assertNoClientIdDrift,
  clientIdsInDoc,
  createMultiClientContext,
  createRestartableServer,
  pollDiskContentStable,
  pollUntil,
} from './test-harness';

const MULTI_FIXTURE = `# T2 Multi-Client Doc

## Section A

Content for section A.

## Section B

Content for section B.

[[sibling-page]]

[[another-sibling]]
`;

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.();
  }
}, 30_000);

describe('T2: Multi-client fast restart', () => {
  test('REPRO: 2 clients + fast restart → no 3-way duplication', async () => {
    let server = await createRestartableServer();
    cleanups.push(() => server.shutdown());

    const docName = 'multi-doc';
    // Seed the fixture on disk before clients connect, so persistence.onLoadDocument
    // loads canonical content into each doc session.
    writeFileSync(join(server.contentDir, `${docName}.md`), MULTI_FIXTURE, 'utf-8');

    const ctx = await createMultiClientContext({
      server,
      docName,
      clientCount: 2,
    });
    cleanups.push(() => ctx.cleanup());

    // Baseline — each pool's provider is synced with canonical content.
    const initialProviders = ctx.pools.map((p) => p.getActive()?.provider);
    expect(initialProviders.every((p) => p !== undefined)).toBe(true);

    // Let any post-sync persistence drain settle.
    await wait(300);

    const baseline = readFileSync(join(server.contentDir, `${docName}.md`), 'utf-8');
    const baselineSectionA = (baseline.match(/## Section A/g) ?? []).length;
    const baselineSectionB = (baseline.match(/## Section B/g) ?? []).length;
    const baselineSibling = (baseline.match(/\[\[sibling-page\]\]/g) ?? []).length;
    expect(baselineSectionA).toBe(1);
    expect(baselineSectionB).toBe(1);
    expect(baselineSibling).toBe(1);

    // Capture pre-restart clientID sets per pool.
    const preRestartClientIdSets = ctx.pools.map((p) => {
      const entry = p.getActive();
      if (!entry) throw new Error('pool has no active entry pre-restart');
      return clientIdsInDoc(entry.provider.document);
    });
    const preRestartSummary = preRestartClientIdSets.map((s) => [...s]);

    // Fast restart: 500ms downtime, well under RECYCLE_DEBOUNCE_MS = 4000.
    server = await server.killAndRestartOnSamePort({ downtimeMs: 500 });
    cleanups.unshift(() => server.shutdown());

    // Wait for all pools to re-sync.
    await pollUntil(
      () => ctx.pools.every((p) => p.getActive()?.provider.isSynced === true),
      10_000,
      50,
    );

    // The authenticationFailed → recycle defense replaces the stale Y.Doc with a fresh
    // provider on restart (previously the disconnect-debounce window absorbed the restart
    // and kept the stale Y.Doc, so the provider identity was unchanged). The behavior
    // assertion below (no duplicated markers on disk) is the real gate; the clientID
    // mechanism checks are informational.

    // Capture post-restart clientID sets.
    const postRestartClientIdSets = ctx.pools.map((p) => {
      const entry = p.getActive();
      if (!entry) throw new Error('pool has no active entry post-restart');
      return clientIdsInDoc(entry.provider.document);
    });
    const postRestartSummary = postRestartClientIdSets.map((s) => [...s]);

    console.log('[T2] clientID sets', {
      preRestart: preRestartSummary,
      postRestart: postRestartSummary,
      growth: postRestartClientIdSets.map((s, i) => s.size - preRestartClientIdSets[i].size),
    });

    // Behavior: disk content matches baseline exactly once, after persistence settles.
    const afterRestart = await pollDiskContentStable(
      join(server.contentDir, `${docName}.md`),
      (c) => c.includes('Section A') && c.includes('Section B'),
      { timeoutMs: 8000, settleMs: 400 },
    );
    const afterSectionA = (afterRestart.match(/## Section A/g) ?? []).length;
    const afterSectionB = (afterRestart.match(/## Section B/g) ?? []).length;
    const afterSibling = (afterRestart.match(/\[\[sibling-page\]\]/g) ?? []).length;

    console.log('[T2] marker counts', {
      baseline: {
        sectionA: baselineSectionA,
        sectionB: baselineSectionB,
        sibling: baselineSibling,
      },
      after: { sectionA: afterSectionA, sectionB: afterSectionB, sibling: afterSibling },
      diskBytes: afterRestart.length,
    });

    // Expect NO duplication on any marker.
    expect(afterSectionA).toBe(baselineSectionA);
    expect(afterSectionB).toBe(baselineSectionB);
    expect(afterSibling).toBe(baselineSibling);

    // Mechanism: both clients' clientID sets match server's clientID set.
    const serverDoc = server.instance.hocuspocus.documents.get(docName);
    if (!serverDoc) throw new Error('server doc missing post-restart');
    for (let i = 0; i < ctx.pools.length; i++) {
      const entry = ctx.pools[i].getActive();
      if (!entry) throw new Error(`pool[${i}] has no active entry during post-restart assertion`);
      const doc = entry.provider.document;
      assertNoClientIdDrift(
        {
          docName,
          doc,
          ytext: doc.getText('source'),
          fragment: doc.getXmlFragment('default'),
          provider: entry.provider,
          pauseSync: () => {
            throw new Error('unused');
          },
          resumeSync: () => {
            throw new Error('unused');
          },
          cleanup: async () => {
            /* pool owns */
          },
        },
        serverDoc,
        `client ${i}`,
      );
    }
  }, 30_000);
});
