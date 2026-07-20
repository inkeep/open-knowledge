/**
 * Agent writes ride the L2 commit debounce instead of forcing a shadow commit
 * per write, and `/api/history` drains any pending commit before reading so
 * the debounce never costs read-your-writes.
 *
 * Pins the two halves of the contract:
 *   1. Coalescing — successive agent writes inside one debounce window produce
 *      NO shadow commit on their own (the per-write forced flush is gone).
 *   2. Read-your-writes — a `/api/history` read issued right after a write
 *      lists that write, because the handler flushes the pending commit first.
 *
 * Uses a deliberately huge `commitDebounceMs` so the debounce timer cannot
 * fire during the test — any commit observed before the history read would be
 * a regression back to per-write flushing.
 */

import { execFileSync } from 'node:child_process';
import { resolveShadowDir } from '@inkeep/open-knowledge-core/shadow-repo-layout';
import { afterEach, describe, expect, test } from 'vitest';
import { agentWriteMd, createTestServer, type TestServer } from './test-harness';

interface TimelineResponse {
  entries: Array<{ sha: string; type: string; message: string }>;
}

let server: TestServer | undefined;

afterEach(async () => {
  await server?.cleanup();
  server = undefined;
});

function listWipRefs(contentDir: string): string[] {
  const shadowDir = resolveShadowDir(contentDir);
  const raw = execFileSync('git', ['for-each-ref', '--format=%(refname)', 'refs/wip/'], {
    env: { ...process.env, GIT_DIR: shadowDir },
    encoding: 'utf-8',
  });
  return raw.trim().split('\n').filter(Boolean);
}

describe('agent-write L2 commit coalescing', () => {
  test('writes coalesce on the debounce; /api/history flushes before reading', async () => {
    server = await createTestServer({ gitEnabled: true, commitDebounceMs: 600_000 });

    await agentWriteMd(server.port, '# Doc A\n', {
      docName: 'coalesce-a',
      position: 'replace',
      agentId: 'coalesce-writer',
      agentName: 'Coalesce Writer',
    });
    await agentWriteMd(server.port, '# Doc B\n', {
      docName: 'coalesce-b',
      position: 'replace',
      agentId: 'coalesce-writer',
      agentName: 'Coalesce Writer',
    });

    // Both writes are on disk (the handler awaits the L1 store), but neither
    // forced an L2 shadow commit: the wip namespace is still empty.
    expect(listWipRefs(server.contentDir)).toEqual([]);

    // A history read right after the writes must still list them — the
    // handler drains the pending commit before querying.
    const res = await fetch(
      `${server.baseUrl}/api/history?docName=${encodeURIComponent('coalesce-a')}`,
    );
    expect(res.ok).toBe(true);
    const body = (await res.json()) as TimelineResponse;
    expect(body.entries.length).toBeGreaterThanOrEqual(1);
    expect(body.entries.some((e) => e.type === 'wip')).toBe(true);

    // The read's flush drained BOTH pending writes into one coalesced drain:
    // the second doc is queryable without any further write or flush, and the
    // writer advanced a single wip ref.
    const resB = await fetch(
      `${server.baseUrl}/api/history?docName=${encodeURIComponent('coalesce-b')}`,
    );
    expect(resB.ok).toBe(true);
    const bodyB = (await resB.json()) as TimelineResponse;
    expect(bodyB.entries.some((e) => e.type === 'wip')).toBe(true);

    const refs = listWipRefs(server.contentDir);
    expect(refs.length).toBe(1);
  }, 30_000);
});
