/**
 * The awaited-flush + failure-surfacing pattern
 * established for `agent-write-md` extended to the other debounced-store
 * mutating MCP handlers. A handler whose disk-persistence step fails must
 * surface a storage error, not a false success.
 *
 * `OK_TEST_STORE_FAULT=<docName>` forces the atomic store for that doc to throw
 * a synthetic ENOSPC, exercising the real persistence → forced-flush →
 * surfacing path through the production server boot. Sibling of
 * `persistence-failure-surfacing.test.ts` (which covers agent-write-md).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import {
  agentPatch,
  agentWriteMd,
  awaitWipCommits,
  createTestServer,
  type TestServer,
} from './test-harness.ts';

let server: TestServer | undefined;

afterEach(async () => {
  delete process.env.OK_TEST_STORE_FAULT;
  if (server) {
    await server.cleanup();
    server = undefined;
  }
});

describe('disk-persistence failure surfacing — edit_document (/api/agent-patch)', () => {
  test('reports a storage error instead of a false success when the store fails', async () => {
    server = await createTestServer();
    const docName = `patch-fault-${randomUUID()}`;
    // Seed with the fault unset so the doc exists on disk before we edit it.
    await agentWriteMd(server.port, '# Doc\n\nFINDME here\n', { docName, position: 'replace' });

    process.env.OK_TEST_STORE_FAULT = docName;
    // Raw fetch (not the agentPatch helper, which discards body.type) so we can
    // pin the RFC 9457 problem type alongside the status, like the siblings.
    const res = await fetch(`http://127.0.0.1:${server.port}/api/agent-patch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ find: 'FINDME', replace: 'REPLACED', docName }),
    });

    expect(res.status).toBe(507); // ENOSPC → storage-full
    const body = (await res.json()) as { type?: string };
    expect(body.type).toBe('urn:ok:error:storage-full');
  });

  test('still reports success when the store reaches disk', async () => {
    server = await createTestServer();
    const docName = `patch-ok-${randomUUID()}`;
    await agentWriteMd(server.port, '# Doc\n\nFINDME here\n', { docName, position: 'replace' });

    const result = await agentPatch(server.port, 'FINDME', 'REPLACED', docName);

    expect(result.ok).toBe(true);
  });
});

async function frontmatterPatch(port: number, docName: string, patch: Record<string, unknown>) {
  return fetch(`http://127.0.0.1:${port}/api/frontmatter-patch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ docName, patch }),
  });
}

describe('disk-persistence failure surfacing — edit_frontmatter (/api/frontmatter-patch)', () => {
  test('reports a storage error instead of a false success when the store fails', async () => {
    server = await createTestServer();
    const docName = `fm-fault-${randomUUID()}`;
    await agentWriteMd(server.port, '# Doc\n\nbody\n', { docName, position: 'replace' });

    process.env.OK_TEST_STORE_FAULT = docName;
    const res = await frontmatterPatch(server.port, docName, { title: 'New Title' });

    expect(res.status).toBe(507);
    // Pin the RFC 9457 problem type, not just the status — a refactor mapping the
    // errno to a different urn:ok:error:* would keep 507 but break MCP classification.
    const body = (await res.json()) as { type?: string };
    expect(body.type).toBe('urn:ok:error:storage-full');
  });

  test('still reports success when the store reaches disk', async () => {
    server = await createTestServer();
    const docName = `fm-ok-${randomUUID()}`;
    await agentWriteMd(server.port, '# Doc\n\nbody\n', { docName, position: 'replace' });

    const res = await frontmatterPatch(server.port, docName, { title: 'New Title' });

    expect(res.status).toBe(200);
  });
});

describe('disk-persistence failure surfacing — version rollback (/api/rollback)', () => {
  test('reports a storage error instead of a false success when the rollback store fails', async () => {
    server = await createTestServer({ gitEnabled: true, commitDebounceMs: 100 });
    const docName = `rb-fault-${randomUUID()}`;

    // Seed two prior versions to roll back to. The agent-write handler commits to
    // the shadow repo FIRE-AND-FORGET, so `awaitWipCommits` drains the L2 commit
    // pipeline (via /api/test-flush-git) and AWAITS each commit rather than racing
    // it against a wall-clock budget — the prior bare `pollUntil(…, 12000)` seeding
    // flaked under merge-queue contention and ejected unrelated PRs.
    await agentWriteMd(server.port, '# V1\n\nbody one\n', { docName, position: 'replace' });
    await awaitWipCommits(server, docName, 1);
    await agentWriteMd(server.port, '# V2\n\nbody two\n', { docName, position: 'replace' });
    const shas = await awaitWipCommits(server, docName, 2);

    const priorSha = shas[shas.length - 1]; // oldest WIP commit = V1
    expect(priorSha).toMatch(/^[0-9a-f]{40}$/i);

    process.env.OK_TEST_STORE_FAULT = docName;
    const res = await fetch(`http://127.0.0.1:${server.port}/api/rollback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ docName, commitSha: priorSha }),
    });

    expect(res.status).toBe(507);
    const body = (await res.json()) as { type?: string };
    expect(body.type).toBe('urn:ok:error:storage-full');
  });
});

// NOTE: `rename` is intentionally NOT covered here. The managed-rename spine
// unloads affected docs and writes them synchronously (`tracedWriteFileSync` +
// `registerWrite`), so a rename never schedules a debounced `onStoreDocument`
// store — it has no crash-before-flush window and is already durable (like
// create / delete). Its handler-level `flushDocToGit` is an L1 no-op (L2 git
// only). Confirmed empirically: faulting a renamed/relinked doc does not
// surface a store failure because no faultable store runs.
