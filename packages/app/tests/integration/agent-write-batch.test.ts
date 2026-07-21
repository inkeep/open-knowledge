/**
 * `POST /api/agent-write-batch` behavior suite.
 *
 * Pins the batch contract end-to-end against a real server:
 *   1. Mixed create/update batches land per-entry (array order, duplicate
 *      docNames compose like sequential writes) with every write attributed
 *      to the batch agent, and the batch never forces a shadow commit of its
 *      own — the L2 debounce coalesces the whole batch (plus adjacent
 *      single-call writes) into ONE commit, drained by `/api/history`.
 *   2. Reserved (system/config) doc names reject per entry; siblings land.
 *   3. Broken-link validation sees sibling batch docs regardless of entry
 *      order (intra-batch links resolve) and still reports genuinely dead
 *      links.
 *   4. Per-entry summaries echo (with the shared truncation shape).
 *   5. Undo after a batch write flows through the normal per-session path.
 *   6. The request-id envelope conventions hold for the new route.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AgentWriteBatchSuccessSchema } from '@inkeep/open-knowledge-core';
import { resolveShadowDir } from '@inkeep/open-knowledge-core/shadow-repo-layout';
import { afterEach, describe, expect, test } from 'vitest';
import { createTestServer, getServerState, type TestServer } from './test-harness';

interface BatchResponseBody {
  timestamp: string;
  results: Array<{
    status: 'written' | 'error';
    docName: string;
    summary?: { value: string; truncatedFrom?: number };
    brokenLinks?: Array<{ href: string; resolvedTo: string | null; reason: string }>;
    error?: { type: string; title: string; detail?: string };
  }>;
  written: number;
  failed: number;
}

interface TimelineResponse {
  entries: Array<{
    sha: string;
    type: string;
    message: string;
    contributors: Array<{ id: string; name?: string; docs?: string[] }>;
  }>;
}

let server: TestServer | undefined;

afterEach(async () => {
  await server?.cleanup();
  server = undefined;
});

async function postBatch(
  port: number,
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/api/agent-write-batch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

function listWipRefs(contentDir: string): string[] {
  const shadowDir = resolveShadowDir(contentDir);
  const raw = execFileSync('git', ['for-each-ref', '--format=%(refname)', 'refs/wip/'], {
    env: { ...process.env, GIT_DIR: shadowDir },
    encoding: 'utf-8',
  });
  return raw.trim().split('\n').filter(Boolean);
}

function countCommits(contentDir: string, ref: string): number {
  const shadowDir = resolveShadowDir(contentDir);
  const raw = execFileSync('git', ['rev-list', '--count', ref], {
    env: { ...process.env, GIT_DIR: shadowDir },
    encoding: 'utf-8',
  });
  return Number(raw.trim());
}

describe('agent-write-batch', () => {
  test('mixed create/update batch lands per entry, attributed, with one coalesced shadow commit', async () => {
    server = await createTestServer({ gitEnabled: true, commitDebounceMs: 600_000 });
    const agentId = 'batch-writer';

    const res = await postBatch(server.port, {
      agentId,
      agentName: 'Batch Writer',
      docs: [
        { docName: 'batch/alpha', markdown: '# Alpha\n', position: 'replace' },
        { docName: 'batch/beta', markdown: '# Beta\n', position: 'replace' },
        // Duplicate docName: applies after the first alpha entry, in order.
        { docName: 'batch/alpha', markdown: 'Second paragraph.\n', position: 'append' },
      ],
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as BatchResponseBody;
    expect(AgentWriteBatchSuccessSchema.safeParse(body).success).toBe(true);
    expect(body.written).toBe(3);
    expect(body.failed).toBe(0);
    expect(body.results.map((r) => r.status)).toEqual(['written', 'written', 'written']);
    expect(body.results.map((r) => r.docName)).toEqual([
      'batch/alpha',
      'batch/beta',
      'batch/alpha',
    ]);

    // Per-doc L1 stores were awaited before the response: disk truth now.
    const alpha = readFileSync(join(server.contentDir, 'batch/alpha.md'), 'utf-8');
    expect(alpha).toContain('# Alpha');
    expect(alpha).toContain('Second paragraph.');
    expect(readFileSync(join(server.contentDir, 'batch/beta.md'), 'utf-8')).toContain('# Beta');

    // The batch armed the L2 debounce but never forced a commit of its own.
    expect(listWipRefs(server.contentDir)).toEqual([]);

    // /api/history drains the pending commit; the whole batch coalesced into
    // ONE shadow commit on the batch writer's wip ref, attributed to it.
    const hist = (await (
      await fetch(`${server.baseUrl}/api/history?docName=${encodeURIComponent('batch/alpha')}`)
    ).json()) as TimelineResponse;
    expect(hist.entries.length).toBeGreaterThanOrEqual(1);
    const contributorIds = new Set(hist.entries.flatMap((e) => e.contributors.map((c) => c.id)));
    expect([...contributorIds]).toEqual([`agent-${agentId}`]);
    const batchContributor = hist.entries[0].contributors.find((c) => c.id === `agent-${agentId}`);
    expect(batchContributor?.docs).toContain('batch/alpha');
    expect(batchContributor?.docs).toContain('batch/beta');

    const refs = listWipRefs(server.contentDir);
    expect(refs.length).toBe(1);
    expect(countCommits(server.contentDir, refs[0])).toBe(1);
  }, 30_000);

  test('system/config docs reject per entry; siblings land unaffected', async () => {
    server = await createTestServer();

    const res = await postBatch(server.port, {
      agentId: 'batch-gate',
      docs: [
        { docName: 'batch-gate/ok-doc', markdown: '# Fine\n', position: 'replace' },
        { docName: '__system__', markdown: '# Nope\n', position: 'replace' },
        { docName: '__config__/project', markdown: '# Nope\n', position: 'replace' },
        { docName: 'batch-gate/also-ok', markdown: '# Also fine\n', position: 'replace' },
      ],
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as BatchResponseBody;
    expect(body.written).toBe(2);
    expect(body.failed).toBe(2);
    expect(body.results[0].status).toBe('written');
    expect(body.results[1].status).toBe('error');
    expect(body.results[1].error?.type).toBe('urn:ok:error:reserved-doc-name');
    expect(body.results[2].status).toBe('error');
    expect(body.results[2].error?.type).toBe('urn:ok:error:reserved-doc-name');
    expect(body.results[3].status).toBe('written');

    expect(readFileSync(join(server.contentDir, 'batch-gate/ok-doc.md'), 'utf-8')).toContain(
      '# Fine',
    );
    expect(readFileSync(join(server.contentDir, 'batch-gate/also-ok.md'), 'utf-8')).toContain(
      '# Also fine',
    );
  }, 30_000);

  test('broken-link validation admits sibling batch docs and reports dead links', async () => {
    server = await createTestServer();

    const res = await postBatch(server.port, {
      agentId: 'batch-links',
      docs: [
        // Links to a sibling written LATER in the same batch — must resolve.
        {
          docName: 'batch-links/a',
          markdown: '# A\n\n[to b](./b.md)\n',
          position: 'replace',
        },
        { docName: 'batch-links/b', markdown: '# B\n', position: 'replace' },
        {
          docName: 'batch-links/c',
          markdown: '# C\n\n[dead](./no-such-doc.md)\n',
          position: 'replace',
        },
      ],
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as BatchResponseBody;
    expect(body.results[0].status).toBe('written');
    expect(body.results[0].brokenLinks).toEqual([]);
    expect(body.results[1].brokenLinks).toEqual([]);
    expect(body.results[2].status).toBe('written');
    expect(body.results[2].brokenLinks?.length).toBe(1);
    expect(body.results[2].brokenLinks?.[0].reason).toBe('no-such-doc');
  }, 30_000);

  test('per-entry summaries echo with the shared truncation shape', async () => {
    server = await createTestServer();

    const longSummary = 'x'.repeat(120);
    const res = await postBatch(server.port, {
      agentId: 'batch-summaries',
      docs: [
        {
          docName: 'batch-summaries/one',
          markdown: '# One\n',
          position: 'replace',
          summary: 'Wrote one',
        },
        {
          docName: 'batch-summaries/two',
          markdown: '# Two\n',
          position: 'replace',
          summary: longSummary,
        },
        { docName: 'batch-summaries/three', markdown: '# Three\n', position: 'replace' },
      ],
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as BatchResponseBody;
    expect(body.results[0].summary?.value).toBe('Wrote one');
    expect(body.results[1].summary?.value).toBe(`${'x'.repeat(79)}…`);
    expect(body.results[1].summary?.truncatedFrom).toBe(120);
    expect(body.results[2].summary).toBeUndefined();
  }, 30_000);

  test('undo after a batch write flows through the normal per-session path', async () => {
    server = await createTestServer();
    const agentId = 'batch-undo';
    const docName = 'batch-undo/target';

    const writeRes = await postBatch(server.port, {
      agentId,
      docs: [{ docName, markdown: '# Undo target\n', position: 'replace' }],
    });
    expect(writeRes.status).toBe(200);
    expect(getServerState(server, docName)?.ytext.toString()).toContain('# Undo target');

    const undoRes = await fetch(`${server.baseUrl}/api/agent-undo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ docName, connectionId: `agent-${agentId}`, scope: 'session' }),
    });
    expect(undoRes.status).toBe(200);
    const undoBody = (await undoRes.json()) as { undone: boolean };
    expect(undoBody.undone).toBe(true);
    expect(getServerState(server, docName)?.ytext.toString()).not.toContain('# Undo target');
  }, 30_000);

  test('response echoes a well-formed incoming x-request-id', async () => {
    server = await createTestServer();

    const res = await postBatch(
      server.port,
      {
        agentId: 'batch-reqid',
        docs: [{ docName: 'batch-reqid/doc', markdown: '# Hi\n', position: 'replace' }],
      },
      { 'x-request-id': 'batch-req-1' },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('x-request-id')).toBe('batch-req-1');
  }, 30_000);
});
