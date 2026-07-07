/**
 * Regression: conflict-marker disk events should leave the CRDT and document
 * lifecycle in a coherent state after the conflict resolves.
 *
 * Bugs this guards:
 *   - Bug 4 (lifecycle.status stays 'conflict' forever): the `case 'update'`
 *     reconcile handler never clears the status set by `case 'conflict'`, so
 *     UI surfaces gating on `lifecycle.status === 'conflict'` remain in
 *     conflict-mode after the underlying Y.Text has been resolved.
 *   - Bug 2 (persistence-during-conflict overwrites markers): persistence is
 *     not gated on `lifecycle.status === 'conflict'`, so a Y.Text edit during
 *     the conflict window flushes through and overwrites the merge stages on
 *     disk — silently breaking any subsequent `git checkout --theirs/--ours`
 *     and the conflict-resolver UI's three-pane diff.
 *
 * Topology:
 *   - W4 (file watcher disk -> CRDT) is exercised end-to-end via direct
 *     writeFileSync calls — simulating what `git merge` then
 *     `git checkout --theirs` would produce on disk.
 *   - Persistence's debounce window is bounded by `maxDebounce: 500` so the
 *     test can wait deterministically.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { createTestClient, createTestServer, pollUntil, type TestServer } from './test-harness';

const BASE_CONTENT = '# Base\n\nBase paragraph.\n';
const THEIRS_CONTENT = '# Theirs\n\nTeam version.\n';
const CONFLICT_MARKERS =
  '<<<<<<< HEAD\n# Mine\n\nLocal version.\n=======\n# Theirs\n\nTeam version.\n>>>>>>> origin/main\n';

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.();
  }
}, 30_000);

async function setupServerWithDoc(docName: string, initial: string): Promise<TestServer> {
  const server = await createTestServer({ debounce: 100, maxDebounce: 500 });
  cleanups.push(() => server.cleanup());
  writeFileSync(join(server.contentDir, `${docName}.md`), initial, 'utf-8');
  await pollUntil(async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/documents`).catch(() => null);
    if (!res?.ok) return false;
    const data = (await res.json()) as { documents?: Array<{ docName: string }> };
    return data.documents?.some((d) => d.docName === docName) ?? false;
  });
  return server;
}

describe('case "conflict" disk event -> CRDT lifecycle', () => {
  test('clears lifecycle.status after conflict resolves to theirs', async () => {
    const docName = `conflict-clear-${crypto.randomUUID()}`;
    const server = await setupServerWithDoc(docName, BASE_CONTENT);
    const client = await createTestClient(server.port, docName);
    cleanups.push(() => client.cleanup());

    // Wait until the client observes the base content so reconciledBase is
    // aligned across server + client.
    await pollUntil(() => client.ytext.toString().includes('Base paragraph'));

    const lifecycle = client.doc.getMap('lifecycle');
    const filePath = join(server.contentDir, `${docName}.md`);

    // 1. Simulate `git merge` writing conflict markers to disk.
    writeFileSync(filePath, CONFLICT_MARKERS, 'utf-8');

    // 2. File watcher emits kind:'conflict'; server-factory.ts case 'conflict'
    //    sets lifecycle.status='conflict'. Wait for that to propagate to the
    //    connected client via the shared Y.Doc.
    await pollUntil(() => lifecycle.get('status') === 'conflict', 10_000);

    // 3. Simulate `git checkout --theirs` writing the resolved bytes.
    writeFileSync(filePath, THEIRS_CONTENT, 'utf-8');

    // 4. Wait for the file watcher to emit kind:'update' and reconcile to
    //    propagate. Y.Text should converge to the theirs content.
    await pollUntil(() => client.ytext.toString().includes('Team version'), 10_000);

    expect(client.ytext.toString()).toContain('Team version');
    expect(client.ytext.toString()).not.toContain('Base paragraph');

    // after the resolved-bytes update reconciles, the
    // lifecycle status set in step 2 should be cleared. Without this, UI
    // surfaces gating on lifecycle.status === 'conflict' (banner, read-only
    // mode, save-block) stay stuck even though the data has converged.
    await pollUntil(() => lifecycle.get('status') === undefined, 5000);
    expect(lifecycle.get('reason')).toBeUndefined();
  }, 30_000);

  test('clears lifecycle.status on noop reconcile (keep-mine path)', async () => {
    const docName = `conflict-noop-${crypto.randomUUID()}`;
    const server = await setupServerWithDoc(docName, BASE_CONTENT);
    const client = await createTestClient(server.port, docName);
    cleanups.push(() => client.cleanup());

    await pollUntil(() => client.ytext.toString().includes('Base paragraph'));

    const lifecycle = client.doc.getMap('lifecycle');
    const filePath = join(server.contentDir, `${docName}.md`);

    // 1. Conflict markers appear on disk.
    writeFileSync(filePath, CONFLICT_MARKERS, 'utf-8');
    await pollUntil(() => lifecycle.get('status') === 'conflict', 10_000);

    // 2. "Keep my version" simulation: git checkout --ours restores the
    //    pre-merge HEAD bytes (which were BASE_CONTENT). Disk == BASE_CONTENT
    //    == Y.Text, so reconcile returns 'noop'.
    writeFileSync(filePath, BASE_CONTENT, 'utf-8');

    // the noop branch must also clear the
    // lifecycle conflict status. Pre-fix this branch was unconditionally
    // skipped, leaving the UI banner stuck after the user's chosen
    // resolution converged on the data layer.
    await pollUntil(() => lifecycle.get('status') === undefined, 5000);
    expect(lifecycle.get('reason')).toBeUndefined();
    expect(client.ytext.toString()).toContain('Base paragraph');
  }, 30_000);

  test('persistence does not overwrite conflict markers on disk during conflict', async () => {
    const docName = `conflict-persist-${crypto.randomUUID()}`;
    const server = await setupServerWithDoc(docName, BASE_CONTENT);
    const client = await createTestClient(server.port, docName);
    cleanups.push(() => client.cleanup());

    await pollUntil(() => client.ytext.toString().includes('Base paragraph'));

    const lifecycle = client.doc.getMap('lifecycle');
    const filePath = join(server.contentDir, `${docName}.md`);

    // 1. Conflict markers appear on disk.
    writeFileSync(filePath, CONFLICT_MARKERS, 'utf-8');
    await pollUntil(() => lifecycle.get('status') === 'conflict', 10_000);

    // 2. Confirm disk currently has the markers (sanity).
    expect(readFileSync(filePath, 'utf-8')).toContain('<<<<<<<');

    // 3. User makes an edit while the doc is in conflict state. Persistence
    //    SHOULD NOT flush this — flushing would overwrite the merge stages
    //    on disk and break any subsequent `git checkout --theirs/--ours`.
    client.doc.transact(() => {
      client.ytext.insert(client.ytext.length, '\n\nEdit during conflict.\n');
    });

    // 4. Confirm the edit reached the server's Y.Doc before relying on the
    //    debounce-window assertion. Without this gate, slow WebSocket
    //    delivery under heavy CI load could let `wait(1500)` complete
    //    before the edit ever triggered a persistence attempt — the disk
    //    assertion would then pass vacuously (markers preserved because
    //    no flush was attempted, not because the conflict gate fired).
    await pollUntil(() => {
      const serverDoc = server.instance.hocuspocus.documents.get(docName);
      return serverDoc?.getText('source').toString().includes('Edit during conflict') ?? false;
    }, 5000);

    // 5. Wait well past the persistence debounce window.
    await wait(1500);

    // disk still has conflict markers. Pre-fix this failed
    // because persistence.ts only gated on 'deleted-upstream' | 'renamed',
    // not 'conflict' — so Y.Text got flushed and the markers were lost.
    const diskNow = readFileSync(filePath, 'utf-8');
    expect(diskNow).toContain('<<<<<<<');
    expect(diskNow).toContain('=======');
    expect(diskNow).toContain('>>>>>>>');
    expect(diskNow).not.toContain('Edit during conflict');
  }, 30_000);
});

describe('case "conflicts" reconcile branch -> CRDT lifecycle', () => {
  /**
   * Reconciliation conflicts (block-level 3-way merge failure where ours and
   * theirs both modified divergent blocks) must set `lifecycle.status='conflict'`
   * so the UI swap and the mutating-handler refusal gate fire symmetrically
   * with the disk-marker path. Pre-fix this branch applied marker-laden content
   * silently — UI editor stayed live; mutating MCP handlers accepted writes.
   *
   * The reason field carries 'merged-with-markers' (vs 'conflict-markers' for
   * the disk-detected path) so observers can distinguish provenance.
   *
   */
  test('case "conflicts" sets lifecycle.status="conflict" with reason "merged-with-markers"', async () => {
    const docName = `reconcile-conflicts-${crypto.randomUUID()}`;
    const baseContent = '# Heading\n\nFirst paragraph.\n\nSecond paragraph.\n';
    // Use a very long persistence debounce so the Y.Text edit below NEVER
    // flushes during the test window — reconciledBase keeps its initial BASE
    // value when reconcile fires for our writeFileSync(THEIRS).
    const server = await createTestServer({ debounce: 60_000, maxDebounce: 60_000 });
    cleanups.push(() => server.cleanup());
    writeFileSync(join(server.contentDir, `${docName}.md`), baseContent, 'utf-8');
    await pollUntil(async () => {
      const res = await fetch(`http://127.0.0.1:${server.port}/api/documents`).catch(() => null);
      if (!res?.ok) return false;
      const data = (await res.json()) as { documents?: Array<{ docName: string }> };
      return data.documents?.some((d) => d.docName === docName) ?? false;
    });

    const client = await createTestClient(server.port, docName);
    cleanups.push(() => client.cleanup());

    // Wait until the client observes base content so reconciledBase is aligned.
    await pollUntil(() => client.ytext.toString().includes('First paragraph'));

    const lifecycle = client.doc.getMap('lifecycle');
    const filePath = join(server.contentDir, `${docName}.md`);

    // 1. Modify the "First paragraph." block in place via Y.Text. With the
    //    60s persistence debounce this never flushes → reconciledBase stays
    //    BASE; server Y.Text holds OURS.
    const baseOffset = client.ytext.toString().indexOf('First paragraph.');
    const baseLen = 'First paragraph.'.length;
    client.doc.transact(() => {
      client.ytext.delete(baseOffset, baseLen);
      client.ytext.insert(baseOffset, 'Our version of first paragraph.');
    });

    // 2. Confirm the edit reached the server.
    await pollUntil(() => {
      const serverDoc = server.instance.hocuspocus.documents.get(docName);
      return serverDoc?.getText('source').toString().includes('Our version') ?? false;
    }, 5000);

    // 3. Write THEIRS to disk — same block, different edit. Reconcile sees
    //    ours and theirs both modified the "First paragraph." block to
    //    divergent content → kind:'conflicts'.
    const theirsContent = '# Heading\n\nTheir version of first paragraph.\n\nSecond paragraph.\n';
    writeFileSync(filePath, theirsContent, 'utf-8');

    // 4. Wait for lifecycle.status to propagate via Y.Map sync.
    await pollUntil(() => lifecycle.get('status') === 'conflict', 10_000);

    // reason distinguishes block-level reconcile (this
    // branch) from disk-marker detection (case 'conflict' →
    // 'conflict-markers').
    expect(lifecycle.get('status')).toBe('conflict');
    expect(lifecycle.get('reason')).toBe('merged-with-markers');
  }, 30_000);
});

describe('FR7 + FR9: mutating handlers refuse with RFC 9457 slim 409 during conflict', () => {
  /**
   * Each mutating handler must surface `DocInConflictError` as the slim
   * RFC 9457 409 envelope — flat extensions (`file`, `resolutionOptions`),
   * no `base`/`ours`/`theirs` embedded. The gate is static on
   * `lifecycle.status === 'conflict'`; content irrelevant.
   *
   */
  async function seedConflictedDoc(): Promise<{ docName: string; server: TestServer }> {
    const docName = `gate-${crypto.randomUUID()}`;
    const server = await setupServerWithDoc(docName, BASE_CONTENT);
    const client = await createTestClient(server.port, docName);
    cleanups.push(() => client.cleanup());
    await pollUntil(() => client.ytext.toString().includes('Base paragraph'));

    const filePath = join(server.contentDir, `${docName}.md`);
    writeFileSync(filePath, CONFLICT_MARKERS, 'utf-8');
    const lifecycle = client.doc.getMap('lifecycle');
    await pollUntil(() => lifecycle.get('status') === 'conflict', 10_000);
    return { docName, server };
  }

  async function expectDocInConflict409(
    res: Response,
    expectedFile: string,
  ): Promise<Record<string, unknown>> {
    expect(res.status).toBe(409);
    expect(res.headers.get('content-type')).toContain('application/problem+json');
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.type).toBe('urn:ok:error:doc-in-conflict');
    expect(body.title).toBe('Document is in conflict.');
    expect(body.status).toBe(409);
    expect(body.file).toBe(expectedFile);
    expect(body.resolutionOptions).toEqual(['mine', 'theirs', 'content', 'delete']);
    // Slim envelope — no merge stages embedded.
    expect(body.base).toBeUndefined();
    expect(body.ours).toBeUndefined();
    expect(body.theirs).toBeUndefined();
    return body;
  }

  test('POST /api/agent-write returns 409 doc-in-conflict', async () => {
    const { docName, server } = await seedConflictedDoc();
    const res = await fetch(`http://127.0.0.1:${server.port}/api/agent-write`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        docName,
        content: 'new content',
        agentId: 'a',
        agentName: 'A',
      }),
    });
    await expectDocInConflict409(res, `${docName}.md`);
  }, 30_000);

  test('POST /api/agent-write-md returns 409 doc-in-conflict', async () => {
    const { docName, server } = await seedConflictedDoc();
    const res = await fetch(`http://127.0.0.1:${server.port}/api/agent-write-md`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        docName,
        markdown: '# Replacement\n',
        position: 'replace',
        agentId: 'a',
        agentName: 'A',
      }),
    });
    await expectDocInConflict409(res, `${docName}.md`);
  }, 30_000);

  test('POST /api/agent-patch returns 409 doc-in-conflict', async () => {
    const { docName, server } = await seedConflictedDoc();
    // The find string must be present in Y.Text — `case 'conflict'`
    // updates reconciledBase + lifecycle but leaves Y.Text holding the
    // pre-conflict content. Pick a substring of BASE_CONTENT so the
    // handler's pre-spine `find` lookup succeeds and the patch reaches
    // the `applyAgentMarkdownWrite` gate at the spine boundary.
    const res = await fetch(`http://127.0.0.1:${server.port}/api/agent-patch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        docName,
        find: 'Base paragraph.',
        replace: 'Patched paragraph.',
        agentId: 'a',
        agentName: 'A',
      }),
    });
    await expectDocInConflict409(res, `${docName}.md`);
  }, 30_000);

  test('POST /api/agent-undo returns 409 doc-in-conflict', async () => {
    const { docName, server } = await seedConflictedDoc();
    // We need an existing session for agent-undo to reach the spine
    // gate; the handler short-circuits with 404 if no session exists.
    // Open a session by issuing an initial write BEFORE the conflict —
    // but the test setup already seeded the conflict, so route through
    // the server's sessionManager directly to register a session.
    await server.instance.sessionManager.getSession(docName, 'agent-undo-gate', {
      displayName: 'Undo Gate',
      colorSeed: 'u',
    });

    const res = await fetch(`http://127.0.0.1:${server.port}/api/agent-undo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        docName,
        connectionId: 'agent-undo-gate',
        agentId: 'agent-undo-gate',
        agentName: 'Undo Gate',
        scope: 'last',
      }),
    });
    await expectDocInConflict409(res, `${docName}.md`);
  }, 30_000);

  test('POST /api/rollback returns 409 doc-in-conflict', async () => {
    const { docName, server } = await seedConflictedDoc();
    const res = await fetch(`http://127.0.0.1:${server.port}/api/rollback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        docName,
        commitSha: '0123456789abcdef0123456789abcdef01234567',
      }),
    });
    await expectDocInConflict409(res, `${docName}.md`);
  }, 30_000);

  test('POST /api/rename-path returns 409 doc-in-conflict when source is conflicted', async () => {
    const { docName, server } = await seedConflictedDoc();
    const res = await fetch(`http://127.0.0.1:${server.port}/api/rename-path`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        kind: 'file',
        fromPath: `${docName}.md`,
        toPath: `renamed-${docName}.md`,
      }),
    });
    await expectDocInConflict409(res, `${docName}.md`);
  }, 30_000);

  test('POST /api/delete-path returns 409 doc-in-conflict when target is conflicted', async () => {
    const { docName, server } = await seedConflictedDoc();
    const res = await fetch(`http://127.0.0.1:${server.port}/api/delete-path`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        kind: 'file',
        path: `${docName}.md`,
      }),
    });
    await expectDocInConflict409(res, `${docName}.md`);
  }, 30_000);

  /**
   * Seed a doc at `<folder>/<docName>.md` and drive its lifecycle to
   * conflict via disk markers. Returns the absolute folder name and the
   * relative child doc path so callers can issue folder-scoped rename /
   * delete requests against the parent path.
   */
  async function seedConflictedDocInFolder(): Promise<{
    folder: string;
    childDocName: string;
    server: TestServer;
  }> {
    const folder = `folder-${crypto.randomUUID()}`;
    const childBase = `child-${crypto.randomUUID()}`;
    const childDocName = `${folder}/${childBase}`;
    // Pre-seed the folder + file ON DISK BEFORE starting the server, so the
    // file-watcher's initial seed walk discovers it deterministically. The
    // previous post-startup `mkdirSync + writeFileSync` racy pattern works
    // on macOS but consistently times out on CI's Linux parcel-watcher —
    // recursive watching doesn't reliably pick up a brand-new subdirectory's
    // first file create event until the next polling cycle.
    const contentDir = realpathSync(mkdtempSync(join(tmpdir(), 'ok-test-folderconflict-')));
    mkdirSync(join(contentDir, folder), { recursive: true });
    writeFileSync(join(contentDir, folder, `${childBase}.md`), BASE_CONTENT, 'utf-8');
    const server = await createTestServer({
      contentDir,
      keepContentDir: false,
      debounce: 100,
      maxDebounce: 500,
    });
    cleanups.push(() => server.cleanup());
    // Doc should already be in the index via the initial seed walk; poll
    // briefly to absorb any harness async between createTestServer resolving
    // and `/api/documents` being callable.
    await pollUntil(async () => {
      const res = await fetch(`http://127.0.0.1:${server.port}/api/documents`).catch(() => null);
      if (!res?.ok) return false;
      const data = (await res.json()) as { documents?: Array<{ docName: string }> };
      return data.documents?.some((d) => d.docName === childDocName) ?? false;
    }, 15_000);

    const client = await createTestClient(server.port, childDocName);
    cleanups.push(() => client.cleanup());
    await pollUntil(() => client.ytext.toString().includes('Base paragraph'));

    writeFileSync(join(server.contentDir, folder, `${childBase}.md`), CONFLICT_MARKERS, 'utf-8');
    const lifecycle = client.doc.getMap('lifecycle');
    await pollUntil(() => lifecycle.get('status') === 'conflict', 10_000);
    return { folder, childDocName, server };
  }

  /**
   * Folder-rename gate. A folder rename whose subtree contains a conflicted
   * doc must refuse with 409 — the per-doc rewrite spine
   * (`applyManagedRenameMapToLoadedDocument` → `composeAndWriteRawBody`)
   * does NOT route through `applyAgentMarkdownWrite`, so without an
   * explicit gate at the rename-path handler the folder branch silently
   * rewrites the conflicted child's Y.Text. The `file` reported on the
   * 409 envelope is the conflicted child's path (with `.md`), not the
   * folder path — matching what `respondDocInConflict` extracts via the
   * doc index lookup.
   *
   */
  test('POST /api/rename-path (folder) returns 409 when subtree contains a conflicted doc', async () => {
    const { folder, childDocName, server } = await seedConflictedDocInFolder();
    const res = await fetch(`http://127.0.0.1:${server.port}/api/rename-path`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        kind: 'folder',
        fromPath: folder,
        toPath: `${folder}-renamed`,
      }),
    });
    await expectDocInConflict409(res, `${childDocName}.md`);
  }, 30_000);
});

describe('GET /api/sync/conflict-content?source=ytext', () => {
  /**
   * The DiffView mounted in the editor area fetches conflict content with
   * `?source=ytext`. During a live session `case 'conflict'` does NOT
   * seed marker bytes into Y.Text — the bridge leaves the pre-conflict
   * Y.Text intact and skips persistence so Y.Text holds the
   * editable "ours" baseline plus any post-flush edits the user typed
   * before the conflict was detected. The server must return `ours` from
   * that snapshot — NOT `git show :2:` — so the DiffView reflects what
   * the user actually has.
   *
   * Default (no `?source=ytext`): backward-compatible — `ours = git show :2:`.
   *
   */
  test('returns Y.Text snapshot when source=ytext and snapshot is marker-free', async () => {
    const docName = `fr3-source-ytext-${crypto.randomUUID()}`;
    const server = await setupServerWithDoc(docName, BASE_CONTENT);
    const client = await createTestClient(server.port, docName);
    cleanups.push(() => client.cleanup());

    await pollUntil(() => client.ytext.toString().includes('Base paragraph'));

    const lifecycle = client.doc.getMap('lifecycle');
    const filePath = join(server.contentDir, `${docName}.md`);

    // 1. Write disk markers — `case 'conflict'` fires, sets
    //    lifecycle.status='conflict', snapshots reconciledBase, and
    //    skips persistence so subsequent Y.Text edits do NOT flush to disk.
    writeFileSync(filePath, CONFLICT_MARKERS, 'utf-8');
    await pollUntil(() => lifecycle.get('status') === 'conflict', 10_000);

    // 2. Mid-conflict Y.Text edit. With persistence skipped, these bytes
    //    live ONLY in Y.Text — they are not present in `git show :2:`.
    const midConflictMarker = '## Mid-conflict authored content\n';
    client.doc.transact(() => {
      client.ytext.insert(client.ytext.toString().length, midConflictMarker);
    });

    // 3. Wait for the server's Y.Text to reflect the client edit.
    await pollUntil(() => {
      const serverDoc = server.instance.hocuspocus.documents.get(docName);
      return serverDoc?.getText('source').toString().includes(midConflictMarker) ?? false;
    }, 5000);

    // 4. Fetch with `?source=ytext` — `ours` should carry the live
    //    Y.Text bytes, including the mid-conflict edit, since Y.Text
    //    is marker-free (the bridge's case 'conflict' did NOT write
    //    conflict markers into Y.Text).
    const ytextRes = await fetch(
      `http://127.0.0.1:${server.port}/api/sync/conflict-content?file=${docName}.md&source=ytext`,
    );
    expect(ytextRes.ok).toBe(true);
    const ytextBody = (await ytextRes.json()) as {
      file: string;
      base: string;
      ours: string;
      theirs: string;
      lifecycleStatus: string | null;
    };
    expect(ytextBody.file).toBe(`${docName}.md`);
    expect(ytextBody.ours).toContain(midConflictMarker);
    expect(ytextBody.lifecycleStatus).toBe('conflict');

    // 5. Fetch without `?source=ytext` — backward-compat path returns
    //    git-index bytes (no mid-conflict edit; the disk has the raw
    //    marker payload that case 'conflict' wrote). The `ours` here
    //    deliberately differs from the Y.Text variant — the contract is
    //    that the param flips the source.
    const defaultRes = await fetch(
      `http://127.0.0.1:${server.port}/api/sync/conflict-content?file=${docName}.md`,
    );
    expect(defaultRes.ok).toBe(true);
    const defaultBody = (await defaultRes.json()) as { ours: string };
    expect(defaultBody.ours).not.toContain(midConflictMarker);
  }, 30_000);

  /**
   * Reopen scenario: when the app boots with a conflicted file on disk,
   * the file watcher's seed loads the raw marker bytes into Y.Text — the
   * case 'conflict' guard that prevents this during a live session
   * doesn't apply at cold-load. The server must detect markers in the
   * Y.Text snapshot and fall back to `git show :2:` for `ours`,
   * otherwise the DiffView would surface `<<<<<<< HEAD` / `=======` /
   * `>>>>>>>` as content and produce nonsense hunks.
   *
   * We simulate the reopen seed by directly inserting marker text into
   * Y.Text on the server (no real file watcher seed in the test
   * harness, but the marker-detection codepath is identical regardless
   * of how the bytes got into Y.Text).
   *
   */
  test('falls back to git-index ours when Y.Text snapshot contains conflict markers', async () => {
    const docName = `fr3-marker-fallback-${crypto.randomUUID()}`;
    const server = await setupServerWithDoc(docName, BASE_CONTENT);
    const client = await createTestClient(server.port, docName);
    cleanups.push(() => client.cleanup());

    await pollUntil(() => client.ytext.toString().includes('Base paragraph'));

    const lifecycle = client.doc.getMap('lifecycle');
    const filePath = join(server.contentDir, `${docName}.md`);

    writeFileSync(filePath, CONFLICT_MARKERS, 'utf-8');
    await pollUntil(() => lifecycle.get('status') === 'conflict', 10_000);

    // Simulate the reopen seed: client writes the marker payload into
    // Y.Text. (Real reopen does this from the file watcher's initial
    // walk; the test harness has a live server, so we inject directly
    // — the server-side marker detection runs against whatever bytes
    // are in Y.Text regardless of how they got there.)
    client.doc.transact(() => {
      client.ytext.delete(0, client.ytext.toString().length);
      client.ytext.insert(0, CONFLICT_MARKERS);
    });
    await pollUntil(() => {
      const serverDoc = server.instance.hocuspocus.documents.get(docName);
      return serverDoc?.getText('source').toString().includes('<<<<<<<') ?? false;
    }, 5000);

    const ytextRes = await fetch(
      `http://127.0.0.1:${server.port}/api/sync/conflict-content?file=${docName}.md&source=ytext`,
    );
    expect(ytextRes.ok).toBe(true);
    const ytextBody = (await ytextRes.json()) as { ours: string; lifecycleStatus: string | null };
    expect(ytextBody.ours).not.toContain('<<<<<<<');
    expect(ytextBody.ours).not.toContain('=======');
    expect(ytextBody.ours).not.toContain('>>>>>>>');
    expect(ytextBody.lifecycleStatus).toBe('conflict');
  }, 30_000);
});
