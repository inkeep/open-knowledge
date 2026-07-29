/**
 * Restore attempts against a checkpoint whose ref has been garbage-collected.
 *
 * The timeline hides a GC'd row, but a client holding a stale sha — a diff pane
 * left open across a retention sweep, a copied permalink — can still POST it.
 * Every other malformed-restore shape has an envelope test; this one does not,
 * so the failure mode it guards (a partial restore, or a 500 where a 404
 * belongs) is unobserved. The doc must come out byte-identical.
 *
 */

import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import {
  DEFAULT_CHECKPOINT_RETENTION,
  gcCheckpointRefs,
  initShadowRepo,
  saveInMemoryCheckpoint,
} from '@inkeep/open-knowledge-server';
import { afterEach, describe, expect, test } from 'vitest';
import {
  agentWriteMd,
  awaitWipCommits,
  createTestServer,
  pollDiskContentStable,
  readTestDoc,
  type TestServer,
} from './test-harness';

let server: TestServer | undefined;
afterEach(async () => {
  await server?.cleanup();
  server = undefined;
});

const LIVE = '# Live\n\nlive body anchor\n';

describe('restore after checkpoint GC', () => {
  test('an evicted sha stays readable until the objects are pruned, then fails loudly and leaves the document byte-identical', async () => {
    server = await createTestServer({ gitEnabled: true, commitDebounceMs: 100 });
    const docName = `qa045-${randomUUID().slice(0, 8)}`;

    await agentWriteMd(server.port, LIVE, { docName, position: 'replace' });
    await awaitWipCommits(server, docName, 1);
    const before = await pollDiskContentStable(
      join(server.contentDir, `${docName}.md`),
      (c) => c.includes('live body anchor'),
      { timeoutMs: 5000, settleMs: 200 },
    );

    // Two checkpoints of one kind, so keep-1 evicts exactly one of them. The
    // explicit dates put them a second apart: git stores commit dates at
    // one-second granularity, so writing both in the same second would leave
    // the sweep no way to tell which is newer and it would then keep both.
    const shadow = await initShadowRepo(server.contentDir);
    const firstSha = await saveInMemoryCheckpoint(shadow, '', {
      kind: 'defer-exhaustion-loss',
      docName,
      contents: '# Older\n\nolder recovered body\n',
      branch: 'main',
      label: 'older recovery',
      metadata: { deferCount: 9 },
      date: '2026-01-02T03:04:05Z',
    });
    const secondSha = await saveInMemoryCheckpoint(shadow, '', {
      kind: 'defer-exhaustion-loss',
      docName,
      contents: '# Newer\n\nnewer recovered body\n',
      branch: 'main',
      label: 'newer recovery',
      metadata: { deferCount: 9 },
      date: '2026-01-02T03:04:06Z',
    });

    // Sanity: both shas resolve BEFORE the sweep, so a 404 after it is the
    // GC's doing and not a bad sha.
    for (const sha of [firstSha, secondSha]) {
      const preRead = await fetch(
        `http://127.0.0.1:${server.port}/api/history/${sha}?docName=${encodeURIComponent(docName)}`,
      );
      expect(preRead.status).toBe(200);
    }

    const checkpointRefShas = (): Set<string> =>
      new Set(
        execFileSync('git', ['for-each-ref', '--format=%(objectname)', 'refs/checkpoints/main/'], {
          cwd: shadow.workTree,
          encoding: 'utf-8',
          env: { ...process.env, GIT_DIR: shadow.gitDir, GIT_WORK_TREE: shadow.workTree },
        })
          .split('\n')
          .map((l) => l.trim())
          .filter(Boolean),
      );
    const refsBefore = checkpointRefShas();

    const gc = await gcCheckpointRefs(shadow, 'main', {
      ...DEFAULT_CHECKPOINT_RETENTION,
      maxDeferExhaustionLoss: 1,
      ttlMs: 0,
    });
    expect(gc.deletedDeferExhaustionLoss).toBe(1);

    // Recency is unambiguous here, so the survivor's identity is pinned: a
    // sweep that keeps the most recent N must drop the older checkpoint and
    // keep the newer rescue, never the other way round.
    const refsAfter = checkpointRefShas();
    const evicted = [...refsBefore].filter((sha) => !refsAfter.has(sha));
    expect(evicted).toEqual([firstSha]);
    expect(refsAfter.has(secondSha)).toBe(true);
    const evictedSha = firstSha;

    // The row is gone from the timeline...
    const histRes = await fetch(
      `http://127.0.0.1:${server.port}/api/history?docName=${encodeURIComponent(docName)}&limit=100`,
    );
    const hist = (await histRes.json()) as { entries: Array<{ sha: string }> };
    expect(hist.entries.some((e) => e.sha === evictedSha)).toBe(false);

    // Dropping the ref does not destroy the object — git keeps unreferenced
    // commits until they are pruned — so the blob is still readable by sha in
    // the window between the retention sweep and the next prune. Pin that
    // characterization explicitly rather than assuming the row's disappearance
    // implies a 404.
    const readBeforePrune = await fetch(
      `http://127.0.0.1:${server.port}/api/history/${evictedSha}?docName=${encodeURIComponent(docName)}`,
    );
    expect(readBeforePrune.status).toBe(200);

    // After a real prune the object is genuinely gone — this is the state a
    // stale diff pane eventually POSTs against.
    const gitEnv = { ...process.env, GIT_DIR: shadow.gitDir, GIT_WORK_TREE: shadow.workTree };
    execFileSync('git', ['reflog', 'expire', '--expire=now', '--expire-unreachable=now', '--all'], {
      cwd: shadow.workTree,
      env: gitEnv,
    });
    execFileSync('git', ['gc', '--prune=now', '--quiet'], { cwd: shadow.workTree, env: gitEnv });

    const readRes = await fetch(
      `http://127.0.0.1:${server.port}/api/history/${evictedSha}?docName=${encodeURIComponent(docName)}`,
    );
    expect(readRes.status).toBe(404);

    const rbRes = await fetch(`http://127.0.0.1:${server.port}/api/rollback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ docName, commitSha: evictedSha }),
    });
    // Loud and safe: a client-visible 4xx, never a 5xx and never a partial write.
    expect(rbRes.status).toBeGreaterThanOrEqual(400);
    expect(rbRes.status).toBeLessThan(500);
    const problem = (await rbRes.json()) as { type?: string };
    expect(typeof problem.type).toBe('string');
    expect(problem.type?.startsWith('urn:ok:error:')).toBe(true);

    // No mutation: not a partial restore, not a resurrection of the evicted blob.
    const after = readTestDoc(server.contentDir, docName);
    expect(after).toBe(before);
    expect(after).not.toContain('older recovered body');
  }, 60_000);
});
