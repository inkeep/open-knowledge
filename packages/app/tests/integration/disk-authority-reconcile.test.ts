/**
 * L1 reconcile-before-apply. Inverts the live clobber scenario: a doc loaded in
 * the server holds
 * stale in-memory state, a native out-of-band edit makes disk newer, and an
 * agent then edits via MCP. Before the fix the agent's store silently clobbered
 * the newer disk edit (4/4 deterministic). After L1, the agent write ingests
 * the divergent disk edit first (via the sanctioned `applyExternalChange` path)
 * and applies its edit on top — both the out-of-band edit and the agent edit
 * survive on disk.
 *
 * Covers the three `reconcileDiskBeforeAgentWrite`-wired content handlers
 * (write_document append, edit_document find/replace, edit_frontmatter) plus the
 * rename spine, and asserts the `disk-edit-reconciled` success warning.
 * Also covers the concurrent-un-flushed-CRDT-edit case (disk edit racing CRDT
 * edits persistence has not yet flushed): the L1 reconcile routes through the
 * same three-way `reconcile()` the file-watcher uses, so the un-flushed CRDT
 * edit survives alongside the ingested disk edit in BOTH arrival orders
 * (agent-write-first and watcher-first), and overlapping-block conflicts /
 * conflict-marker disk content refuse the agent write (409 doc-in-conflict)
 * instead of silently dropping either side.
 *
 * These exercise the real server wiring (production persistence extension +
 * file-watcher + the agent-write store), matching the reproduction harness.
 * The file-watcher loses the reconcile race deterministically in this timing,
 * so L1 — not the watcher — is what preserves both edits.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  agentPatch,
  agentWriteMd,
  createTestClients,
  createTestServer,
  pollUntil,
  readTestDoc,
  type TestClient,
  type TestServer,
} from './test-harness.ts';

let server: TestServer | undefined;

afterEach(async () => {
  if (server) {
    await server.cleanup();
    server = undefined;
  }
});

async function frontmatterPatch(port: number, docName: string, patch: Record<string, unknown>) {
  return fetch(`http://127.0.0.1:${port}/api/frontmatter-patch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ docName, patch }),
  });
}

async function renamePath(port: number, fromPath: string, toPath: string) {
  return fetch(`http://127.0.0.1:${port}/api/rename-path`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind: 'file', fromPath, toPath }),
  });
}

describe('PRD-6832 β L1: agent write reconciles a newer out-of-band disk edit', () => {
  test('write_document append: the native edit is NOT clobbered + FR3 warning fires', async () => {
    server = await createTestServer({ debounce: 50, maxDebounce: 200 });
    const { port, contentDir } = server;
    const docName = `reconcile-append-${randomUUID()}`;
    const filePath = join(contentDir, `${docName}.md`);

    await agentWriteMd(port, '# V1 from agent\n\nbody-v1\n', { docName, position: 'replace' });
    await pollUntil(() => readTestDoc(contentDir, docName).includes('body-v1'));

    // Native out-of-band edit: write V2 directly to disk, bypassing OK. Do NOT
    // wait for the file-watcher — the agent write below must reconcile it (L1).
    writeFileSync(filePath, '# V2 NATIVE OUT-OF-BAND EDIT\n\nbody-v2-native\n', 'utf-8');

    // Agent appends against its stale V1 view (it never saw V2). Raw fetch so we
    // can assert the success warning alongside the no-clobber outcome.
    const res = await fetch(`http://127.0.0.1:${port}/api/agent-write-md`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        docName,
        markdown: 'appended-by-agent-still-on-v1\n',
        position: 'append',
      }),
    });
    expect(res.status).toBe(200);
    // The success response carries the disk-edit-reconciled warning so the
    // agent knows an out-of-band edit was folded in and re-reads.
    const body = (await res.json()) as {
      warning?: { kind?: string };
      warnings?: Array<{ kind?: string }>;
    };
    expect(body.warning?.kind).toBe('disk-edit-reconciled');
    // The unified advisory channel emits in parallel with the deprecated slot.
    expect(body.warnings?.map((w) => w.kind)).toEqual(['disk-edit-reconciled']);

    const after = readTestDoc(contentDir, docName);
    expect(after).toContain('body-v2-native'); // out-of-band edit preserved (no clobber)
    expect(after).toContain('appended-by-agent-still-on-v1'); // agent edit applied on top
  });

  test('edit_document find/replace: runs against the live (disk-reflecting) content', async () => {
    server = await createTestServer({ debounce: 50, maxDebounce: 200 });
    const { port, contentDir } = server;
    const docName = `reconcile-patch-${randomUUID()}`;
    const filePath = join(contentDir, `${docName}.md`);

    await agentWriteMd(port, '# Doc\n\nBANANA here\n', { docName, position: 'replace' });
    await pollUntil(() => readTestDoc(contentDir, docName).includes('BANANA'));

    // Native edit adds a line but keeps the find target intact.
    writeFileSync(filePath, '# Doc\n\nBANANA here\n\nnative-extra-line\n', 'utf-8');

    await agentPatch(port, 'BANANA', 'CHERRY', docName);

    const after = readTestDoc(contentDir, docName);
    expect(after).toContain('CHERRY'); // patch applied against the reconciled content
    expect(after).not.toContain('BANANA'); // the find target was replaced
    expect(after).toContain('native-extra-line'); // out-of-band edit preserved
  });

  test('edit_frontmatter: the native body edit is preserved while the FM patch applies', async () => {
    server = await createTestServer({ debounce: 50, maxDebounce: 200 });
    const { port, contentDir } = server;
    const docName = `reconcile-fm-${randomUUID()}`;
    const filePath = join(contentDir, `${docName}.md`);

    await agentWriteMd(port, '# Doc\n\nbody-original\n', { docName, position: 'replace' });
    await pollUntil(() => readTestDoc(contentDir, docName).includes('body-original'));

    // Native edit adds a body line out-of-band.
    writeFileSync(filePath, '# Doc\n\nbody-original\n\nnative-body-line\n', 'utf-8');

    const res = await frontmatterPatch(port, docName, { title: 'New Title' });
    expect(res.status).toBe(200);

    const after = readTestDoc(contentDir, docName);
    expect(after).toContain('New Title'); // FM patch applied
    expect(after).toContain('native-body-line'); // out-of-band body edit preserved
  });

  test('concurrent un-flushed CRDT edit survives: L1 three-way merges disk + CRDT, agent edit lands on top (agent write first)', async () => {
    // The genuine TOCTOU shape the L1 guard defends: an out-of-band process
    // edits the file while the loaded CRDT carries edits persistence has NOT
    // yet flushed (the window is bounded by the store debounce in
    // production). The sibling tests above all flush the CRDT to disk before
    // the out-of-band edit, so base === ours there and the ingest is a clean
    // accept-theirs. Here both sides changed non-overlapping blocks, so the
    // L1 reconcile must produce a merge that preserves BOTH — same semantics
    // as the file-watcher 'update' path.
    server = await createTestServer({ debounce: 300_000, maxDebounce: 600_000 });
    const { port, contentDir } = server;
    const docName = `reconcile-concurrent-${randomUUID()}`;
    const filePath = join(contentDir, `${docName}.md`);

    // Seed disk BEFORE the doc loads so onLoadDocument sets reconciledBase
    // to the seed bytes (no store flush needed under the long debounce).
    writeFileSync(filePath, '# Doc\n\nseed-body\n', 'utf-8');

    let clients: TestClient[] = [];
    try {
      clients = await createTestClients(port, { count: 1, docName });
      const client = clients[0];
      if (!client) throw new Error('client setup failed');
      await pollUntil(() => client.ytext.toString().includes('seed-body'));

      // Un-flushed concurrent CRDT edit: lands in the server doc but the
      // 300s store debounce keeps it off disk for the whole test.
      client.doc.transact(() => {
        client.ytext.insert(client.ytext.length, '\ncrdt-unflushed-line\n');
      });
      const serverYtext = () =>
        server?.instance.hocuspocus.documents.get(docName)?.getText('source').toString() ?? '';
      await pollUntil(() => serverYtext().includes('crdt-unflushed-line'));
      expect(readTestDoc(contentDir, docName)).not.toContain('crdt-unflushed-line');

      // Real out-of-band disk edit racing the un-flushed CRDT edit.
      writeFileSync(filePath, '# Doc\n\nseed-body\n\ndisk-oob-line\n', 'utf-8');

      // Agent write lands in the TOCTOU window → L1 reconcile fires.
      const res = await fetch(`http://127.0.0.1:${port}/api/agent-write-md`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ docName, markdown: 'agent-line\n', position: 'append' }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        warning?: { kind?: string; mergeOutcome?: string };
      };
      expect(body.warning?.kind).toBe('disk-edit-reconciled');
      // The warning discriminates a three-way merge from a clean
      // accept-theirs so the agent knows concurrent edits were folded in.
      expect(body.warning?.mergeOutcome).toBe('merged');

      // All three writers survive: the out-of-band disk edit, the un-flushed
      // CRDT edit, and the agent edit.
      await pollUntil(() => serverYtext().includes('agent-line'));
      expect(serverYtext()).toContain('disk-oob-line');
      expect(serverYtext()).toContain('crdt-unflushed-line');

      // The handler's forced flush persists the combined content — disk is
      // not left behind holding only the out-of-band version.
      await pollUntil(() => {
        const d = readTestDoc(contentDir, docName);
        return (
          d.includes('agent-line') &&
          d.includes('crdt-unflushed-line') &&
          d.includes('disk-oob-line')
        );
      });
    } finally {
      for (const c of clients) {
        await c.cleanup();
      }
    }
  });

  test('arrival-order independence: file-watcher merges first, agent write does not re-ingest and revert it', async () => {
    // Same scenario, opposite race outcome: the watcher's 'update' event
    // three-way merges the out-of-band disk edit BEFORE the agent write
    // arrives. The reconciled base must track the DISK bytes (not the merged
    // content that exists only in memory), otherwise the agent write's L1
    // compare misreads disk as newly-divergent and a clean accept-theirs
    // reverts the merged-in CRDT line — and the L3 store backstop would
    // likewise abort the agent's flush as a phantom divergence.
    server = await createTestServer({ debounce: 300_000, maxDebounce: 600_000 });
    const { port, contentDir } = server;
    const docName = `reconcile-watcher-first-${randomUUID()}`;
    const filePath = join(contentDir, `${docName}.md`);

    writeFileSync(filePath, '# Doc\n\nseed-body\n', 'utf-8');

    let clients: TestClient[] = [];
    try {
      clients = await createTestClients(port, { count: 1, docName });
      const client = clients[0];
      if (!client) throw new Error('client setup failed');
      await pollUntil(() => client.ytext.toString().includes('seed-body'));

      client.doc.transact(() => {
        client.ytext.insert(client.ytext.length, '\ncrdt-unflushed-line\n');
      });
      const serverYtext = () =>
        server?.instance.hocuspocus.documents.get(docName)?.getText('source').toString() ?? '';
      await pollUntil(() => serverYtext().includes('crdt-unflushed-line'));

      // Out-of-band disk edit; this time WAIT for the watcher to reconcile it
      // into the live doc (three-way merge preserves the CRDT line).
      writeFileSync(filePath, '# Doc\n\nseed-body\n\ndisk-oob-line\n', 'utf-8');
      await pollUntil(() => serverYtext().includes('disk-oob-line'), 10_000);
      expect(serverYtext()).toContain('crdt-unflushed-line');

      // Agent write AFTER the watcher merge: disk holds exactly the bytes the
      // merge already consumed, so L1 must see no divergence (no warning) and
      // must not revert the merge.
      const res = await fetch(`http://127.0.0.1:${port}/api/agent-write-md`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ docName, markdown: 'agent-line\n', position: 'append' }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { warning?: { kind?: string } };
      expect(body.warning).toBeUndefined();

      await pollUntil(() => serverYtext().includes('agent-line'));
      expect(serverYtext()).toContain('disk-oob-line');
      expect(serverYtext()).toContain('crdt-unflushed-line');

      // The forced flush lands the combined content on disk.
      await pollUntil(() => {
        const d = readTestDoc(contentDir, docName);
        return (
          d.includes('agent-line') &&
          d.includes('crdt-unflushed-line') &&
          d.includes('disk-oob-line')
        );
      });
    } finally {
      for (const c of clients) {
        await c.cleanup();
      }
    }
  });

  test('overlapping-block conflict: agent write is refused 409 doc-in-conflict, neither side is silently dropped', async () => {
    // The CRDT and the out-of-band disk edit modified the SAME block in
    // different ways — reconcile() reports conflicts. The L1 guard must not
    // pick a winner: the agent write is refused through the uniform
    // doc-in-conflict gate, the un-flushed CRDT edit stays in the live doc,
    // and the out-of-band disk version stays on disk for the conflict
    // resolution flow.
    server = await createTestServer({ debounce: 300_000, maxDebounce: 600_000 });
    const { port, contentDir } = server;
    const docName = `reconcile-conflict-${randomUUID()}`;
    const filePath = join(contentDir, `${docName}.md`);

    writeFileSync(filePath, '# Doc\n\nshared-line\n', 'utf-8');

    let clients: TestClient[] = [];
    try {
      clients = await createTestClients(port, { count: 1, docName });
      const client = clients[0];
      if (!client) throw new Error('client setup failed');
      await pollUntil(() => client.ytext.toString().includes('shared-line'));

      // CRDT edits the shared block (un-flushed under the long debounce).
      client.doc.transact(() => {
        const text = client.ytext.toString();
        const at = text.indexOf('shared-line') + 'shared-line'.length;
        client.ytext.insert(at, ' crdt-version');
      });
      const serverYtext = () =>
        server?.instance.hocuspocus.documents.get(docName)?.getText('source').toString() ?? '';
      await pollUntil(() => serverYtext().includes('crdt-version'));

      // Out-of-band disk edit to the SAME block.
      writeFileSync(filePath, '# Doc\n\nshared-line disk-version\n', 'utf-8');

      const res = await fetch(`http://127.0.0.1:${port}/api/agent-write-md`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ docName, markdown: 'agent-line\n', position: 'append' }),
      });
      expect(res.status).toBe(409);
      const body = (await res.json()) as { type?: string };
      expect(body.type).toBe('urn:ok:error:doc-in-conflict');

      // Neither concurrent edit was destroyed by the refused agent write.
      expect(serverYtext()).toContain('crdt-version');
      expect(serverYtext()).not.toContain('agent-line');
      expect(readTestDoc(contentDir, docName)).toContain('disk-version');
    } finally {
      for (const c of clients) {
        await c.cleanup();
      }
    }
  });

  test('conflict markers on disk: L1 refuses to ingest them and the agent write is refused 409', async () => {
    // An out-of-band process left git conflict markers in the file.
    // reconcile() refuses marker-laden theirs; the L1 guard must NOT pull the
    // markers into the live CRDT (the previous wholesale ingest did), and the
    // agent write is refused through the doc-in-conflict gate.
    server = await createTestServer({ debounce: 300_000, maxDebounce: 600_000 });
    const { port, contentDir } = server;
    const docName = `reconcile-markers-${randomUUID()}`;
    const filePath = join(contentDir, `${docName}.md`);

    writeFileSync(filePath, '# Doc\n\nseed-body\n', 'utf-8');

    let clients: TestClient[] = [];
    try {
      clients = await createTestClients(port, { count: 1, docName });
      const client = clients[0];
      if (!client) throw new Error('client setup failed');
      await pollUntil(() => client.ytext.toString().includes('seed-body'));

      client.doc.transact(() => {
        client.ytext.insert(client.ytext.length, '\ncrdt-unflushed-line\n');
      });
      const serverYtext = () =>
        server?.instance.hocuspocus.documents.get(docName)?.getText('source').toString() ?? '';
      await pollUntil(() => serverYtext().includes('crdt-unflushed-line'));

      writeFileSync(
        filePath,
        '# Doc\n\n<<<<<<< HEAD\nseed-body\n=======\nother-side\n>>>>>>> theirs\n',
        'utf-8',
      );

      const res = await fetch(`http://127.0.0.1:${port}/api/agent-write-md`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ docName, markdown: 'agent-line\n', position: 'append' }),
      });
      expect(res.status).toBe(409);
      const body = (await res.json()) as { type?: string };
      expect(body.type).toBe('urn:ok:error:doc-in-conflict');

      // Marker bytes never entered the CRDT; the un-flushed edit survived.
      expect(serverYtext()).not.toContain('<<<<<<<');
      expect(serverYtext()).toContain('crdt-unflushed-line');
      expect(serverYtext()).not.toContain('agent-line');
    } finally {
      for (const c of clients) {
        await c.cleanup();
      }
    }
  });

  test('rename: the renamed doc carries the newer out-of-band disk content', async () => {
    // Rename serializes the loaded CRDT to the new path AND bypasses
    // storeDocumentNow (tracedWriteFileSync), so L3 can't backstop it — the
    // reconcile inside the rename spine is the only guard. A stale loaded CRDT
    // would otherwise overwrite the disk move with the pre-edit content.
    server = await createTestServer({ debounce: 50, maxDebounce: 200 });
    const { port, contentDir } = server;
    const fromDoc = `reconcile-rename-from-${randomUUID()}`;
    const toDoc = `reconcile-rename-to-${randomUUID()}`;
    const fromPath = join(contentDir, `${fromDoc}.md`);

    await agentWriteMd(port, '# V1\n\nbody-v1\n', { docName: fromDoc, position: 'replace' });
    await pollUntil(() => readTestDoc(contentDir, fromDoc).includes('body-v1'));

    // Native out-of-band edit to the source before the rename.
    writeFileSync(fromPath, '# V2 NATIVE OUT-OF-BAND EDIT\n\nbody-v2-native\n', 'utf-8');

    const res = await renamePath(port, `${fromDoc}.md`, `${toDoc}.md`);
    expect(res.status).toBe(200);

    const after = readTestDoc(contentDir, toDoc);
    expect(after).toContain('body-v2-native'); // the newer disk edit moved with the rename
  });
});
