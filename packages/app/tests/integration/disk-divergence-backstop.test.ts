/**
 * L3 store-time divergence backstop. The residual TOCTOU
 * after L1: disk diverges between L1's reconcile and the agent's store. The
 * store-time guard detects it, aborts the overwrite (disk wins), and the handler
 * returns `urn:ok:error:disk-divergence` — the agent edit is NOT applied, and a
 * retry re-applies exactly once (no double-apply).
 *
 * A real native edit can't be timed deterministically here — the file-watcher
 * races it and can flip `lastTransactionOrigin` to file-watcher (gating L3 out).
 * So the divergence is injected inside the store, in the exact residual-TOCTOU
 * window, via the NODE_ENV-gated, per-doc `OK_TEST_STORE_DIVERGENCE` seam.
 *
 * The agent-vs-human L3 gate (`agentTriggeredStore`) is exercised here from both
 * directions: agent-triggered stores fire L3 (the agent-write-md and the undo
 * cases below — undo's only disk-authority guard, since it has no L1); an
 * unmarked human/client store does NOT (the gate-exclusion case). The marker is
 * only ever set inside `flushDiskAndDetectOutcome` (api-extension.ts), which no
 * client/browser store path reaches — so the exclusion is structural, and the
 * exclusion test pins it behaviorally.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import {
  agentWriteMd,
  awaitDocQuiescence,
  createTestClient,
  createTestServer,
  pollUntil,
  readTestDoc,
  type TestServer,
} from './test-harness.ts';

// Must match the content the OK_TEST_STORE_DIVERGENCE seam writes.
const INJECTED_MARKER = 'native-divergence-injected';

let server: TestServer | undefined;

afterEach(async () => {
  delete process.env.OK_TEST_STORE_DIVERGENCE;
  if (server) {
    await server.cleanup();
    server = undefined;
  }
});

async function writeMd(
  port: number,
  markdown: string,
  opts: { docName: string; position: 'append' | 'prepend' | 'replace' },
) {
  return fetch(`http://127.0.0.1:${port}/api/agent-write-md`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ markdown, ...opts }),
  });
}

// Raw POST to /api/agent-undo returning the Response. The harness `agentUndo`
// throws on non-200, but the L3 path under test expects a 409.
async function agentUndoRaw(
  port: number,
  opts: { docName: string; connectionId: string; scope?: 'last' | 'session' },
) {
  return fetch(`http://127.0.0.1:${port}/api/agent-undo`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      docName: opts.docName,
      connectionId: opts.connectionId,
      scope: opts.scope ?? 'last',
    }),
  });
}

describe('PRD-6832 β L3: store-time divergence backstop', () => {
  test('reverts on TOCTOU divergence (409); disk wins; retry re-applies exactly once', async () => {
    server = await createTestServer({ debounce: 50, maxDebounce: 200 });
    const { port, contentDir } = server;
    const docName = `l3-content-${randomUUID()}`;

    const seed = await writeMd(port, '# V1\n\nbody-v1\n', { docName, position: 'replace' });
    expect(seed.status).toBe(200);
    await pollUntil(() => readTestDoc(contentDir, docName).includes('body-v1'));

    // Arm the in-store divergence injection for THIS doc: the next store writes
    // a divergent doc to disk just before the L3 check (the residual TOCTOU).
    process.env.OK_TEST_STORE_DIVERGENCE = docName;

    // Agent append → store fires → injected disk diverges from base → L3 reverts.
    const attempt1 = await writeMd(port, 'AGENT-APPEND-XYZ\n', {
      docName,
      position: 'append',
    });
    expect(attempt1.status).toBe(409);
    const body1 = (await attempt1.json()) as { type?: string };
    expect(body1.type).toBe('urn:ok:error:disk-divergence');

    // Disk wins (the injected/native content survives); agent edit NOT applied.
    const afterRevert = readTestDoc(contentDir, docName);
    expect(afterRevert).toContain(INJECTED_MARKER);
    expect(afterRevert).not.toContain('AGENT-APPEND-XYZ');

    // Retry with the injection disarmed → L1 sees disk == base (L3 already
    // realigned the CRDT to disk) → append lands on the divergent content.
    delete process.env.OK_TEST_STORE_DIVERGENCE;
    const attempt2 = await writeMd(port, 'AGENT-APPEND-XYZ\n', {
      docName,
      position: 'append',
    });
    expect(attempt2.status).toBe(200);

    const afterRetry = readTestDoc(contentDir, docName);
    expect(afterRetry).toContain(INJECTED_MARKER);
    expect(afterRetry).toContain('AGENT-APPEND-XYZ');
    // Exactly once — the reverted attempt did not also land.
    expect(afterRetry.split('AGENT-APPEND-XYZ').length - 1).toBe(1);
  });

  test('undo: L3 reverts on TOCTOU divergence (409); native survives; undo NOT applied', async () => {
    server = await createTestServer({ debounce: 50, maxDebounce: 200 });
    const { port, contentDir } = server;
    const docName = `l3-undo-${randomUUID()}`;

    // Establish the doc + a per-session UM frame, then a second non-trivial edit
    // as the same session so `um.undo()` removes real bytes and schedules a
    // store — otherwise the store isn't debounced, the flush is skipped, and L3
    // never runs. connectionId is `agent-<agentId>` (extractAgentIdentity).
    await agentWriteMd(port, '# Base\n\nbase-body\n', {
      docName,
      position: 'replace',
      agentId: 'u1',
    });
    await pollUntil(() => readTestDoc(contentDir, docName).includes('base-body'));
    // > UM captureTimeout (500ms) so the append lands as its own undo frame.
    await new Promise((r) => setTimeout(r, 700));
    await agentWriteMd(port, 'UNDO-ME-LINE\n', { docName, position: 'append', agentId: 'u1' });
    await pollUntil(() => readTestDoc(contentDir, docName).includes('UNDO-ME-LINE'));

    // Arm the in-store divergence injection for the undo's store.
    process.env.OK_TEST_STORE_DIVERGENCE = docName;

    // Undo is an agent-triggered store (marked via flushDiskAndDetectOutcome), so
    // the injected disk divergence trips L3 — undo's ONLY disk-authority guard
    // (no L1, since reconcile-rewrite would invalidate the UndoManager stack).
    const undoRes = await agentUndoRaw(port, { docName, connectionId: 'agent-u1', scope: 'last' });
    expect(undoRes.status).toBe(409);
    const body = (await undoRes.json()) as { type?: string };
    expect(body.type).toBe('urn:ok:error:disk-divergence');

    // Disk wins: the injected/native content survives; the undo's in-memory
    // result (base-body without the appended line) did NOT overwrite disk.
    const afterRevert = readTestDoc(contentDir, docName);
    expect(afterRevert).toContain(INJECTED_MARKER);
    expect(afterRevert).not.toContain('base-body');

    // Recovery is a well-defined FORWARD write (not a retry-undo: undo's UM-stack
    // semantics after an L3 revert are intentionally out of scope). With the
    // injection disarmed, L1 sees disk == base (L3 realigned the CRDT to disk),
    // so the append lands on the divergent content.
    delete process.env.OK_TEST_STORE_DIVERGENCE;
    await agentWriteMd(port, 'RECOVERY-LINE\n', { docName, position: 'append', agentId: 'u1' });
    await pollUntil(() => readTestDoc(contentDir, docName).includes('RECOVERY-LINE'));
    const afterRecovery = readTestDoc(contentDir, docName);
    expect(afterRecovery).toContain(INJECTED_MARKER);
    expect(afterRecovery).toContain('RECOVERY-LINE');
  });

  test('gate: an unmarked human/client store is NEVER reverted by L3', async () => {
    server = await createTestServer({ debounce: 50, maxDebounce: 200 });
    const { port, contentDir } = server;
    const docName = `l3-gate-human-${randomUUID()}`;

    // Seed via an agent write so the doc exists on disk with a reconciledBase.
    const seed = await writeMd(port, '# V1\n\nseed-body\n', { docName, position: 'replace' });
    expect(seed.status).toBe(200);
    await pollUntil(() => readTestDoc(contentDir, docName).includes('seed-body'));

    // A connected client = a browser editor. Its edits route through the natural
    // store debounce, NOT a handler's force-flush, so they are never marked.
    const client = await createTestClient(port, docName);
    try {
      await pollUntil(() => client.ytext.toString().includes('seed-body'), 5000);

      // Arm the in-store divergence. The seam fires on EVERY store of this doc,
      // including the human store below — so if L3 wrongly fired for the unmarked
      // store it would keep reverting to the injected content and the human mark
      // would never stabilize on disk.
      process.env.OK_TEST_STORE_DIVERGENCE = docName;

      // Human source-mode edit: mutate Y.Text('source') directly under the
      // default null origin (no agent handler → agentTriggeredStore === false →
      // L3 must NOT fire).
      const HUMAN_MARK = 'HUMAN-EDIT-NOT-REVERTED';
      client.doc.transact(() => {
        client.ytext.insert(client.ytext.length, `\n${HUMAN_MARK}\n`);
      });
      await awaitDocQuiescence(client.doc, { timeoutMs: 3000 });

      // Presence assertion (not a point-in-time "not the marker" check, which
      // would race the seam's write→rename window): the human edit reaching disk
      // despite divergence armed is provable ONLY if L3 skipped the unmarked
      // store. If L3 had fired, this would time out.
      await pollUntil(() => readTestDoc(contentDir, docName).includes(HUMAN_MARK), 8000);
    } finally {
      delete process.env.OK_TEST_STORE_DIVERGENCE;
      await client.cleanup();
    }
  });
});
