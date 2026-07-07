/**
 * Multi-client content replace (rollback-class structural test).
 *
 * The /api/rollback endpoint requires a shadow-repo commit SHA to revert to,
 * which depends on the full save-version + commit-tree flow. Rather than
 * replicate that ceremony, this test exercises the STRUCTURALLY EQUIVALENT
 * mechanism that rollback uses internally: `applyAgentMarkdownWrite` in
 * `position: 'replace'` mode, which calls `updateYFragment` on the live server
 * Y.Doc under a paired-write origin — identical to ROLLBACK_ORIGIN's behavior
 * as far as Items + Observer A/B interaction is concerned.
 *
 * If the branch-switch path is exempt from the bug class because
 * `updateYFragment` + paired-write-origin preserves Y.Doc identity, the same
 * should hold here. This test confirms that empirically.
 *
 * Expected: PASS. Marker counts are 1× on both clients after replace.
 * If this test FAILS, the hypothesis that structural-diff paths are safe is
 * wrong, and the fix scope expands to cover ROLLBACK_ORIGIN + MANAGED_RENAME_ORIGIN.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import {
  agentWriteMd,
  clientIdsInDoc,
  createMultiClientContext,
  createRestartableServer,
  pollDiskContentStable,
  pollUntil,
} from './test-harness';

const CONTENT_A = `# Content A

This is the pre-replace content.

[[a-sibling]]
`;

const CONTENT_B = `# Content B

This is the post-replace content.

[[b-sibling]]
`;

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.();
  }
});

describe('T7: Multi-client content replace (rollback-class structural test)', () => {
  test('2 clients synced to content-A, agent replaces with content-B → both settle to B exactly once', async () => {
    const server = await createRestartableServer();
    cleanups.push(() => server.shutdown());

    // Seed content-A on disk so initial sync loads content-A.
    const docName = 'replace-doc';
    writeFileSync(join(server.contentDir, `${docName}.md`), CONTENT_A, 'utf-8');

    const ctx = await createMultiClientContext({
      server,
      docName,
      clientCount: 2,
    });
    cleanups.push(() => ctx.cleanup());

    // Pre-replace: both clients see content-A.
    await pollUntil(
      () =>
        ctx.pools.every((p) =>
          p.getActive()?.provider.document.getText('source').toString().includes('a-sibling'),
        ),
      10_000,
      50,
    );

    const preReplaceClientIdSets = ctx.pools.map((p) => {
      const entry = p.getActive();
      if (!entry) throw new Error('pool has no active entry pre-replace');
      return clientIdsInDoc(entry.provider.document);
    });

    // Agent replaces doc content with content-B.
    await agentWriteMd(server.port, CONTENT_B, {
      docName,
      position: 'replace',
      agentId: 't7-agent',
      agentName: 'T7-Agent',
    });

    // Wait for both clients to see content-B.
    await pollUntil(
      () =>
        ctx.pools.every((p) =>
          p.getActive()?.provider.document.getText('source').toString().includes('b-sibling'),
        ),
      10_000,
      50,
    );

    await wait(300); // let persistence settle

    const postReplaceClientIdSets = ctx.pools.map((p) => {
      const entry = p.getActive();
      if (!entry) throw new Error('pool has no active entry post-replace');
      return clientIdsInDoc(entry.provider.document);
    });

    console.log('[T7] clientID sets', {
      pre: preReplaceClientIdSets.map((s) => [...s]),
      post: postReplaceClientIdSets.map((s) => [...s]),
    });

    // Behavior: both clients settle to content-B exactly once, no content-A bleed.
    for (let i = 0; i < ctx.pools.length; i++) {
      const entry = ctx.pools[i].getActive();
      if (!entry) throw new Error(`pool[${i}] has no active entry during assertion`);
      const text = entry.provider.document.getText('source').toString();
      const bSiblings = (text.match(/\[\[b-sibling\]\]/g) ?? []).length;
      const aSiblings = (text.match(/\[\[a-sibling\]\]/g) ?? []).length;
      const bHeading = (text.match(/# Content B/g) ?? []).length;
      const aHeading = (text.match(/# Content A/g) ?? []).length;
      console.log(`[T7] client ${i} markers`, { aSiblings, bSiblings, aHeading, bHeading });
      expect(bSiblings).toBe(1);
      expect(aSiblings).toBe(0);
      expect(bHeading).toBe(1);
      expect(aHeading).toBe(0);
    }

    // Disk reflects content-B exactly once.
    const disk = await pollDiskContentStable(
      join(server.contentDir, `${docName}.md`),
      (c) => c.includes('b-sibling'),
      { timeoutMs: 5000, settleMs: 300 },
    );
    expect((disk.match(/\[\[b-sibling\]\]/g) ?? []).length).toBe(1);
    expect((disk.match(/\[\[a-sibling\]\]/g) ?? []).length).toBe(0);
  }, 30_000);
});
