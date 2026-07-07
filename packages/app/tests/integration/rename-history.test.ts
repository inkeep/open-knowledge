/**
 * End-to-end integration coverage for the timeline rename-history mitigation.
 *
 * Drives the full vertical slice through real Hocuspocus + shadow-git via HTTP:
 *   - file rename round-trip with /api/history + /api/rollback;
 *   - folder rename of N docs → N jsonl entries with shared groupId;
 *   - chained A→B→C: timeline of c spans all three name epochs;
 *   - name-reuse contamination: cycle bound rejects post-R checkpoints;
 *   - lazy-population window: empty `commitSha` → chain truncates → drain
 *     backfills → full chain visible;
 *   - 1000-doc folder rename throughput envelope.
 *
 * The two crash-injection windows (`OK_TEST_RENAME_FAULT` =
 * `pre-append` | `pre-journal-clear`) live next to the rewrite spine in
 * `packages/server/src/api-rename-crash-injection.test.ts` — they exercise
 * the exact ordering invariant + boot recovery + sweepLazyPopOrphans path.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveShadowDir } from '@inkeep/open-knowledge-core/shadow-repo-layout';
import {
  loadRenameLogIndex,
  type RenameLogEntry,
  renameLogPath,
  resetRenameLogIndexCache,
} from '../../../server/src/rename-log';
import {
  agentWriteMd,
  createRestartableServer,
  pollUntil,
  type RestartableServer,
  wait,
} from './test-harness';

interface TimelineResponse {
  entries: Array<{
    sha: string;
    type: 'wip' | 'checkpoint' | 'upstream' | 'rollback';
    message: string;
    authorEmail?: string;
    authorDate?: string;
  }>;
  total: number;
  hasMore: boolean;
}

interface RollbackResponse {
  type?: string;
  title?: string;
}

interface RenameResponse {
  renamed?: Array<{ fromDocName: string; toDocName: string }>;
  type?: string;
  title?: string;
}

interface DocumentListEntry {
  kind?: 'document' | 'asset' | 'folder';
  docName?: string;
}

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  resetRenameLogIndexCache();
  while (cleanups.length > 0) {
    await cleanups.pop()?.();
  }
});

async function bootServer(): Promise<RestartableServer> {
  const server = await createRestartableServer({
    gitEnabled: true,
    commitDebounceMs: 50,
  });
  cleanups.push(() => server.shutdown());
  return server;
}

async function getHistory(
  port: number,
  docName: string,
  opts?: { branch?: string; limit?: number },
): Promise<TimelineResponse> {
  const params = new URLSearchParams({ docName });
  if (opts?.branch) params.set('branch', opts.branch);
  if (opts?.limit !== undefined) params.set('limit', String(opts.limit));
  const res = await fetch(`http://127.0.0.1:${port}/api/history?${params}`);
  return (await res.json()) as TimelineResponse;
}

async function getHistoryVersion(
  port: number,
  docName: string,
  sha: string,
): Promise<{
  status: number;
  body: { ok: boolean; sha?: string; content?: string; error?: string };
}> {
  const params = new URLSearchParams({ docName });
  const res = await fetch(`http://127.0.0.1:${port}/api/history/${sha}?${params}`);
  return {
    status: res.status,
    body: (await res.json()) as { ok: boolean; sha?: string; content?: string; error?: string },
  };
}

async function rollback(
  port: number,
  body: { docName: string; commitSha: string; agentId?: string; agentName?: string },
): Promise<{ status: number; body: RollbackResponse }> {
  const res = await fetch(`http://127.0.0.1:${port}/api/rollback`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as RollbackResponse;
  return { status: res.status, body: json };
}

async function renamePath(
  port: number,
  body: {
    kind: 'file' | 'folder';
    fromPath: string;
    toPath: string;
    agentId?: string;
    agentName?: string;
    summary?: string;
  },
): Promise<{ status: number; body: RenameResponse }> {
  const res = await fetch(`http://127.0.0.1:${port}/api/rename-path`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as RenameResponse;
  return { status: res.status, body: json };
}

async function deletePath(
  port: number,
  body: { kind: 'file' | 'folder'; path: string; agentId?: string; agentName?: string },
): Promise<{ status: number }> {
  const res = await fetch(`http://127.0.0.1:${port}/api/delete-path`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status };
}

async function saveVersion(
  port: number,
  opts?: { agentId?: string; agentName?: string; message?: string },
): Promise<void> {
  const res = await fetch(`http://127.0.0.1:${port}/api/save-version`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      agentId: opts?.agentId,
      agentName: opts?.agentName,
      message: opts?.message,
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`save-version failed: ${res.status} ${text}`);
  }
}

async function getWipShas(server: RestartableServer, docName: string): Promise<Set<string>> {
  const history = await getHistory(server.port, docName);
  return new Set(history.entries.filter((e) => e.type === 'wip').map((e) => e.sha));
}

function readRenameLogEntries(server: RestartableServer): RenameLogEntry[] {
  const shadow = resolveShadowDir(server.contentDir);
  const path = renameLogPath(shadow);
  if (!existsSync(path)) return [];
  const index = loadRenameLogIndex(shadow);
  return [...index.byTo.values()];
}

function isDocumentListDoc(entry: DocumentListEntry): entry is DocumentListEntry & {
  docName: string;
} {
  return entry.kind === 'document' && typeof entry.docName === 'string';
}

async function pollForBackfill(
  server: RestartableServer,
  expectedFromTo: Array<{ from: string; to: string }>,
  timeoutMs = 10_000,
): Promise<RenameLogEntry[]> {
  await pollUntil(
    () => {
      const entries = readRenameLogEntries(server);
      const filledForExpected = expectedFromTo.every((e) =>
        entries.some(
          (le) => le.from === e.from && le.to === e.to && /^[0-9a-f]{40}$/.test(le.commitSha),
        ),
      );
      return filledForExpected;
    },
    timeoutMs,
    50,
  );
  return readRenameLogEntries(server);
}

/**
 * Poll the timeline of `docName` until a NEW 'wip'-typed entry appears —
 * the persistence debouncer's L2 commit has landed for the agent that
 * just wrote. Without this, a follow-on `saveVersion` racing the
 * fire-and-forget `flushDocToGit` produces a checkpoint with no WIP
 * parents, masking the per-cycle WIP from later timeline queries.
 *
 * Snapshots the existing wip-shas before waiting and only returns when
 * a NEW wip sha appears. The previous "any wip exists" semantic was a
 * race: prior cycles' wip commits remain reachable via earlier checkpoints,
 * so a stale wip would let `awaitWipCommit` return before the latest
 * agentWriteMd's debounced commit landed. Under CI's slower I/O, this
 * caused the next rewrite-spine call (e.g. renamePath) to anchor on a
 * stale tree, breaking the predecessor walk's reachability assumption.
 *
 * Timeout default raised to 20s to absorb CI debounce variability while
 * leaving headroom for tests with multiple awaitWipCommit calls inside a
 * 60s outer test budget. The prior 10s budget was too tight for Linux CI
 * runners under load; 30s pushed
 * tests with several wip-cycles past their outer timeout in CI.
 */
async function awaitWipCommit(
  server: RestartableServer,
  docName: string,
  beforeShas: Set<string>,
  timeoutMs = 20_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  // Growing poll intervals (mirrors Playwright's expect.poll default
  // [100,250,500,1000], last value repeating). Each getHistory() spawns
  // several git subprocesses (git log -- <path>, for-each-ref, cat-file,
  // rev-list); the old flat 50ms cadence fired ~20 of those per second, and
  // under merge-queue CPU contention that self-inflicted git load starved the
  // very commitWip being awaited — so the WIP missed the 20s budget. Backing
  // off relieves that contention while still catching the
  // happy-path commit in ~100ms. Budget stays 20s on purpose: the file's
  // 60s-outer / 3-wip-cycle tests can't afford a larger per-call wait.
  const intervals = [100, 250, 500, 1000];
  let attempt = 0;
  while (Date.now() < deadline) {
    // Drain the L2 pipeline BEFORE checking: /api/test-flush-git awaits the
    // pending commit-debounce timer and any in-flight commitToWipRef, so the
    // check below observes a settled shadow repo instead of racing the
    // fire-and-forget flushDocToGit chain against this budget. Under CI
    // load the flush simply takes as long as the git work takes — the
    // budget is a generous ceiling again, not the thing being raced.
    // Flush each iteration: the first call can land before the
    // fire-and-forget chain has even scheduled L2.
    const flushRes = await fetch(`http://127.0.0.1:${server.port}/api/test-flush-git`, {
      method: 'POST',
    });
    if (!flushRes.ok) {
      // A failing flush silently degrades this loop back to the wall-clock
      // race it exists to remove — make that visible in CI output. The loop
      // keeps polling: early no-op flushes are expected, and getHistory may
      // still observe a commit that landed before the flush started failing.
      console.warn(`[awaitWipCommit] test-flush-git returned ${flushRes.status} — continuing poll`);
    }
    const h = await getHistory(server.port, docName);
    const newWip = h.entries.find((e) => e.type === 'wip' && !beforeShas.has(e.sha));
    if (newWip !== undefined) return newWip.sha;
    await wait(intervals[Math.min(attempt++, intervals.length - 1)]);
  }
  throw new Error(`awaitWipCommit: no NEW WIP commit for ${docName} within ${timeoutMs}ms`);
}

async function agentWriteMdAndAwaitWip(
  server: RestartableServer,
  markdown: string,
  opts: NonNullable<Parameters<typeof agentWriteMd>[2]> & { docName: string },
): Promise<string> {
  const beforeShas = await getWipShas(server, opts.docName);
  await agentWriteMd(server.port, markdown, opts);
  return await awaitWipCommit(server, opts.docName, beforeShas);
}

/**
 * `git for-each-ref --format=%(creatordate:iso8601-strict)` is second-precision,
 * so a checkpoint K and a later rename's anchoring commit C created within
 * the same wall-clock second compare equal under buildSeeds's strict
 * less-than. Tests that need K to fall into `seeds(C)` must
 * cross a second boundary between the saveVersion and the operations whose
 * eventual L2 drain produces C.
 */
async function crossSecondBoundary(): Promise<void> {
  await wait(1100);
}

const AGENT = { agentId: 'claude-1', agentName: 'Claude' };

describe('Timeline rename-history mitigation — integration', () => {
  test('file rename round-trip: history spans rename; rollback to pre-rename SHA reverts content; name unchanged', async () => {
    const server = await bootServer();
    const aDoc = 'rename-roundtrip-a';
    const bDoc = 'rename-roundtrip-b';

    // Cycle 1: write content at the source doc, save version.
    await agentWriteMdAndAwaitWip(server, '# A v1\n\nfirst body\n', {
      docName: aDoc,
      position: 'replace',
      ...AGENT,
    });
    await saveVersion(server.port, AGENT);

    // Cycle 2: more WIP at the source doc.
    await agentWriteMdAndAwaitWip(server, '\nmore body line\n', {
      docName: aDoc,
      position: 'append',
      ...AGENT,
    });
    await saveVersion(server.port, AGENT);
    const preRename = await getHistory(server.port, aDoc);
    const preRenameSha = preRename.entries.find((e) => e.type === 'checkpoint')?.sha;
    expect(preRenameSha).toBeDefined();
    if (!preRenameSha) throw new Error('preRenameSha unset');
    await crossSecondBoundary();

    // Rename source → destination.
    const renameRes = await renamePath(server.port, {
      kind: 'file',
      fromPath: `${aDoc}.md`,
      toPath: `${bDoc}.md`,
      ...AGENT,
    });
    expect(renameRes.status).toBe(200);

    // Cycle 3: more WIP at the destination doc.
    await agentWriteMdAndAwaitWip(server, '\npost-rename body\n', {
      docName: bDoc,
      position: 'append',
      ...AGENT,
    });
    await saveVersion(server.port, AGENT);

    // Wait for backfill — the rename-log entry's commitSha should be filled
    // by the post-rename agent-write's drain.
    const entries = await pollForBackfill(server, [{ from: aDoc, to: bDoc }]);
    const renameEntry = entries.find((e) => e.from === aDoc && e.to === bDoc);
    expect(renameEntry).toBeDefined();
    expect(renameEntry?.kind).toBe('file');

    // Wait for the timeline-walker to surface the rename chain end-to-end.
    // pollForBackfill confirms the rename-log JSONL has commitSha filled,
    // but the walker also runs its own git-log/rev-list pipeline, which can
    // take several seconds to materialize the rename commit under CI Linux
    // load (empirically observed: 20s+ under full-suite concurrency). Poll
    // the assertion's positive condition so the test
    // is deterministic; if the walker truly never converges, the pollUntil
    // times out with a clear diagnostic instead of an opaque toContain
    // mismatch below. Happy-path is sub-second; nominal worst-case across
    // six waits stays within the 120s outer budget.
    await pollUntil(
      async () => {
        if (renameEntry?.commitSha === undefined) {
          return false;
        }
        const h = await getHistory(server.port, bDoc);
        const shaSet = new Set(h.entries.map((e) => e.sha));
        return shaSet.has(preRenameSha) && shaSet.has(renameEntry.commitSha);
      },
      45_000,
      50,
    );

    // Timeline of the destination doc spans the rename.
    const postRename = await getHistory(server.port, bDoc);
    expect(postRename.entries).toBeDefined();
    const shas = postRename.entries.map((e) => e.sha);
    expect(shas).toContain(preRenameSha);
    expect(shas).toContain(renameEntry?.commitSha);

    // Rollback to a pre-rename checkpoint SHA → 200, content of `b` reverts
    const rb = await rollback(server.port, {
      docName: bDoc,
      commitSha: preRenameSha,
      ...AGENT,
    });
    expect(rb.status).toBe(200);
    // Status already asserted above; RFC 9457 success bodies have no `ok` field.

    // Wait for the rollback's debounced disk write to land before sampling
    // disk state. handleRollback returns 200 the moment the Y.Doc transact
    // commits; onStoreDocument's L1 debounce (and any reconciliation pass
    // racing the parcel watcher under load) needs a beat to settle. Poll
    // a positive condition (b.md exists) so this is bounded by completion,
    // not a fixed sleep.
    await pollUntil(() => existsSync(join(server.contentDir, `${bDoc}.md`)), 5_000, 25);

    // Filename unchanged: destination still exists, source does not.
    expect(existsSync(join(server.contentDir, `${bDoc}.md`))).toBe(true);
    expect(existsSync(join(server.contentDir, `${aDoc}.md`))).toBe(false);
  }, 180_000);

  test('folder rename of 3 docs → 3 jsonl entries with shared groupId, shared commitSha after backfill', async () => {
    const server = await bootServer();

    // Seed: articles/{auth, sso, oauth} via agent writes so each doc gets
    // a Y.Doc on the server (rename-time `applyManagedRenameMapToLoadedDocument`
    // exercises the loaded-doc path, matching the production hot path).
    //
    // Each write is followed by its own awaitWipCommit so the persistence
    // pipeline settles per-doc before the next write. Without this serialization
    // the third doc's WIP can either land before its awaitWipCommit captures
    // beforeShas (race → false-positive timeout) or genuinely lag past 20s
    // under CI Linux load.
    mkdirSync(join(server.contentDir, 'articles'), { recursive: true });
    await agentWriteMdAndAwaitWip(server, '# auth\n', {
      docName: 'articles/auth',
      position: 'replace',
      ...AGENT,
    });
    await agentWriteMdAndAwaitWip(server, '# sso\n', {
      docName: 'articles/sso',
      position: 'replace',
      ...AGENT,
    });
    await agentWriteMdAndAwaitWip(server, '# oauth\n', {
      docName: 'articles/oauth',
      position: 'replace',
      ...AGENT,
    });
    await saveVersion(server.port, AGENT);

    // Folder rename
    const renameRes = await renamePath(server.port, {
      kind: 'folder',
      fromPath: 'articles',
      toPath: 'essays',
      ...AGENT,
    });
    expect(renameRes.status).toBe(200);
    expect(renameRes.body.renamed?.map((r) => r.toDocName).sort()).toEqual([
      'essays/auth',
      'essays/oauth',
      'essays/sso',
    ]);

    // Trigger drain via a follow-up write so backfill closes the lazy-pop
    // window. Targeting any one of the renamed docs fans out the contributor
    // map to a single agent-claude-1 commit that backfills all three entries.
    await agentWriteMdAndAwaitWip(server, '\nbackfill trigger\n', {
      docName: 'essays/auth',
      position: 'append',
      ...AGENT,
    });

    const expectedPairs = [
      { from: 'articles/auth', to: 'essays/auth' },
      { from: 'articles/sso', to: 'essays/sso' },
      { from: 'articles/oauth', to: 'essays/oauth' },
    ];
    const entries = await pollForBackfill(server, expectedPairs);
    const folderEntries = entries.filter((e) => e.kind === 'folder');
    expect(folderEntries).toHaveLength(3);

    const groupIds = new Set(folderEntries.map((e) => e.groupId));
    expect(groupIds.size).toBe(1);
    const commitShas = new Set(folderEntries.map((e) => e.commitSha));
    expect(commitShas.size).toBe(1);
  }, 60_000);

  test('chained A→B→C: timeline of `c` spans all three name epochs', async () => {
    const server = await bootServer();

    // Cycle: a, save
    await agentWriteMdAndAwaitWip(server, '# A\n', {
      docName: 'a',
      position: 'replace',
      ...AGENT,
    });
    await saveVersion(server.port, AGENT);
    const aHistory = await getHistory(server.port, 'a');
    const aWipSha = aHistory.entries.find((e) => e.type === 'wip')?.sha;
    expect(aWipSha).toBeDefined();
    await crossSecondBoundary();

    // Rename a → b, more writes at b, save
    expect(
      (await renamePath(server.port, { kind: 'file', fromPath: 'a.md', toPath: 'b.md', ...AGENT }))
        .status,
    ).toBe(200);
    await agentWriteMdAndAwaitWip(server, '\nmore at b\n', {
      docName: 'b',
      position: 'append',
      ...AGENT,
    });
    await saveVersion(server.port, AGENT);
    await crossSecondBoundary();

    // Rename b → c, more writes at c
    expect(
      (await renamePath(server.port, { kind: 'file', fromPath: 'b.md', toPath: 'c.md', ...AGENT }))
        .status,
    ).toBe(200);
    await agentWriteMdAndAwaitWip(server, '\nmore at c\n', {
      docName: 'c',
      position: 'append',
      ...AGENT,
    });
    await saveVersion(server.port, AGENT);

    await pollForBackfill(server, [
      { from: 'a', to: 'b' },
      { from: 'b', to: 'c' },
    ]);

    const cHistory = await getHistory(server.port, 'c');
    expect(cHistory.entries).toBeDefined();
    const shas = cHistory.entries.map((e) => e.sha);
    expect(shas).toContain(aWipSha);
    // Both rename SHAs are reachable as well
    const renameAB = readRenameLogEntries(server).find((e) => e.from === 'a' && e.to === 'b');
    const renameBC = readRenameLogEntries(server).find((e) => e.from === 'b' && e.to === 'c');
    expect(shas).toContain(renameAB?.commitSha);
    expect(shas).toContain(renameBC?.commitSha);
  }, 90_000);

  test('name-reuse contamination: timeline of `b` excludes the later same-name draft', async () => {
    const server = await bootServer();

    // Cycle 1: write old-a, save
    await agentWriteMdAndAwaitWip(server, '# A old\n', {
      docName: 'a',
      position: 'replace',
      ...AGENT,
    });
    await saveVersion(server.port, AGENT);
    await crossSecondBoundary();

    // Cycle 2: rename a → b, save
    expect(
      (await renamePath(server.port, { kind: 'file', fromPath: 'a.md', toPath: 'b.md', ...AGENT }))
        .status,
    ).toBe(200);
    await agentWriteMdAndAwaitWip(server, '\nB body\n', {
      docName: 'b',
      position: 'append',
      ...AGENT,
    });
    await pollForBackfill(server, [{ from: 'a', to: 'b' }]);
    await saveVersion(server.port, AGENT);

    // Delete b before cycle 3 so the new-`a` cycle's tree contains a.md
    // ONLY — without this, the new-`a` WIP commit's tree carries b.md too
    // and the unbounded current-name walk for `b` picks it up.
    expect((await deletePath(server.port, { kind: 'file', path: 'b.md', ...AGENT })).status).toBe(
      200,
    );
    await crossSecondBoundary();

    // Cycle 3: NEW a (unrelated draft) — different content, separate doc identity
    await agentWriteMdAndAwaitWip(server, '# A NEW (unrelated)\n', {
      docName: 'a',
      position: 'replace',
      ...AGENT,
    });
    await saveVersion(server.port, AGENT);

    const newAHistory = await getHistory(server.port, 'a');
    const newAWipSha = newAHistory.entries.find((e) => e.type === 'wip')?.sha;
    expect(newAWipSha).toBeDefined();

    // Querying b → must NOT include new-a commits. The cycle bound rejects
    // K3 (created post-`R`) from `seeds(R)` for predecessor walks; with b.md
    // off the new-cycle's tree, the unbounded current-name walk for b also
    // skips them.
    const bHistory = await getHistory(server.port, 'b');
    expect(bHistory.entries.map((e) => e.sha)).not.toContain(newAWipSha);
  }, 90_000);

  test('rename → full chain visible immediately on /api/history (spine drains contributors before response)', async () => {
    // The window still EXISTS as a code path — the api-rename-crash-injection
    // test injects it via the `pre-journal-clear` fault — but spine-driven
    // renames now `await flushContributors()` before returning so the window
    // is closed by the time the API responds. Otherwise a pure rename (no
    // backlinks, doc not loaded as Y.Doc) would never trigger a drain at all
    // and the next-boot orphan sweep would silently delete the rename log
    // entry.
    const server = await bootServer();

    await agentWriteMdAndAwaitWip(server, '# A v1\n', {
      docName: 'a',
      position: 'replace',
      ...AGENT,
    });
    await saveVersion(server.port, AGENT);
    const preRename = await getHistory(server.port, 'a');
    const preWipSha = preRename.entries.find((e) => e.type === 'wip')?.sha;
    expect(preWipSha).toBeDefined();
    await crossSecondBoundary();

    expect(
      (await renamePath(server.port, { kind: 'file', fromPath: 'a.md', toPath: 'b.md', ...AGENT }))
        .status,
    ).toBe(200);

    // jsonl entry is fully populated — commitSha is a 40-char hex by the
    // time the API responds; no transient empty-commitSha state visible
    // to API consumers.
    const entries = readRenameLogEntries(server);
    const entry = entries.find((e) => e.from === 'a' && e.to === 'b');
    expect(entry).toBeDefined();
    expect(entry?.commitSha).toMatch(/^[0-9a-f]{40}$/);

    // Chain materializes on the very next /api/history call. NO subsequent
    // agent write needed.
    const fullQuery = await getHistory(server.port, 'b');
    expect(fullQuery.entries.map((e) => e.sha)).toContain(preWipSha);
  }, 60_000);

  test('timeline filters out backlink-rewrite topological noise from sibling renames', async () => {
    // Real-world regression: when sibling docs get renamed, the rewrite
    // spine's `applyRenameMap` rewrites links inside backlink sources —
    // so `git log -- <docPath>` returns those sibling-rename commits
    // because the source's BLOB changed even though the source wasn't the
    // rename target. The OkActorEntry post-filter drops them via
    // `docs[]` + `previous_paths[]` membership check.
    const server = await bootServer();
    mkdirSync(join(server.contentDir, 'parent'), { recursive: true });
    // Three siblings; getting-started has links to overview and faq. Each
    // write is followed by its own awaitWipCommit.
    await agentWriteMdAndAwaitWip(server, '# overview\n\nbody\n', {
      docName: 'parent/overview',
      position: 'replace',
      ...AGENT,
    });
    await agentWriteMdAndAwaitWip(server, '# faq\n\nbody\n', {
      docName: 'parent/faq',
      position: 'replace',
      ...AGENT,
    });
    await agentWriteMdAndAwaitWip(
      server,
      '# getting-started\n\nSee [[parent/overview]] and [[parent/faq]].\n',
      {
        docName: 'parent/getting-started',
        position: 'replace',
        ...AGENT,
      },
    );

    // Sequentially rename the siblings — each rewrites links inside
    // getting-started's body so `git log -- parent/getting-started.md`
    // returns these sibling rename commits.
    await renamePath(server.port, {
      kind: 'file',
      fromPath: 'parent/faq.md',
      toPath: 'parent/faq-renamed.md',
      ...AGENT,
    });
    await renamePath(server.port, {
      kind: 'file',
      fromPath: 'parent/overview.md',
      toPath: 'parent/overview-renamed.md',
      ...AGENT,
    });
    // Now rename getting-started ITSELF — the legitimate event.
    await renamePath(server.port, {
      kind: 'file',
      fromPath: 'parent/getting-started.md',
      toPath: 'parent/getting-started-renamed.md',
      ...AGENT,
    });

    // Query timeline of the renamed doc. The filter must:
    //   - INCLUDE getting-started's own rename commit
    //   - EXCLUDE the faq + overview rename commits (sibling renames)
    const hist = await getHistory(server.port, 'parent/getting-started-renamed');
    expect(hist.entries).toBeDefined();

    const subjects = hist.entries.map((e) => e.message);
    // The current doc's rename commit is included.
    expect(
      subjects.some((s) => s.includes('parent/getting-started') && s.includes('renamed')),
    ).toBe(true);
    // Sibling rename commits are NOT included.
    expect(subjects.some((s) => s.includes('parent/faq -> parent/faq-renamed'))).toBe(false);
    expect(subjects.some((s) => s.includes('parent/overview -> parent/overview-renamed'))).toBe(
      false,
    );
  }, 60_000);

  test('timeline filters out multi-writer-fan-out topological noise', async () => {
    // Real-world regression: each writer's WIP ref is its own DAG (precedent
    // #25). When writer B writes anything, `buildWipTree` builds the tree
    // from the entire `contentRoot` including files added by writer A —
    // making writer A's added files appear as ADDED in writer B's commit
    // even though the blobs are identical. `git log -- <path>` then returns
    // writer B's commit as a "modification."
    const server = await bootServer();
    mkdirSync(join(server.contentDir, 'multi'), { recursive: true });
    // Writer A (claude-1) creates a doc.
    await agentWriteMdAndAwaitWip(server, '# alpha\n', {
      docName: 'multi/alpha',
      position: 'replace',
      ...AGENT,
    });

    // Writer A renames their doc.
    await renamePath(server.port, {
      kind: 'file',
      fromPath: 'multi/alpha.md',
      toPath: 'multi/alpha-renamed.md',
      ...AGENT,
    });

    // Writer B (different agent — different writerId so it gets its own
    // WIP ref) writes to an UNRELATED doc.
    const OTHER_AGENT = { agentId: 'claude-other', agentName: 'Other' };
    await agentWriteMdAndAwaitWip(server, '# beta\n', {
      docName: 'multi/beta',
      position: 'replace',
      ...OTHER_AGENT,
    });

    // Query timeline of the renamed doc. Writer B's commit (touching
    // `multi/beta`) MUST NOT appear — its docs[] doesn't include
    // `multi/alpha-renamed` or any predecessor.
    const hist = await getHistory(server.port, 'multi/alpha-renamed');
    const writerIds = new Set<string>();
    for (const entry of hist.entries) {
      for (const c of entry.contributors) writerIds.add(c.id);
    }
    // Only writer A's writerId should appear; writer B's commits must not
    // pollute writer A's renamed doc's timeline.
    expect([...writerIds].every((id) => id.startsWith('agent-claude-1'))).toBe(true);

    // Spot check: the OTHER_AGENT's docs (multi/beta) should not appear
    // in any contributor's docs list across the timeline.
    for (const entry of hist.entries) {
      for (const c of entry.contributors) {
        expect(c.docs).not.toContain('multi/beta');
      }
    }
  }, 60_000);

  test('folder rename — user-supplied summary appears exactly once in OkActorEntry.summaries (no per-doc duplication)', async () => {
    // Real-world regression: handleRenamePath looped over result.renamed
    // and called recordContributor with fields.stored EVERY iteration.
    // For a folder rename of N docs, this pushed the same summary string
    // onto the writer's summaries[] array N times — the timeline UI
    // rendered "Renamed docs-test → docs-rename" three times in one
    // commit. The summary describes the rewrite-spine call as a whole,
    // not each affected doc, so it should land exactly once.
    const server = await bootServer();
    // Seed via agent writes (Y.Doc + watcher path matches the existing
    // folder-rename test). Direct disk writes lag the file watcher under
    // CI load and produce empty `result.renamed` arrays.
    // Each write is followed by its own awaitWipCommit.
    mkdirSync(join(server.contentDir, 'src-folder'), { recursive: true });
    await agentWriteMdAndAwaitWip(server, '# a\n', {
      docName: 'src-folder/a',
      position: 'replace',
      ...AGENT,
    });
    await agentWriteMdAndAwaitWip(server, '# b\n', {
      docName: 'src-folder/b',
      position: 'replace',
      ...AGENT,
    });
    await agentWriteMdAndAwaitWip(server, '# c\n', {
      docName: 'src-folder/c',
      position: 'replace',
      ...AGENT,
    });

    const renameRes = await renamePath(server.port, {
      kind: 'folder',
      fromPath: 'src-folder',
      toPath: 'dst-folder',
      summary: 'Renamed src-folder → dst-folder',
      ...AGENT,
    });
    expect(renameRes.status).toBe(200);
    expect(renameRes.body.renamed).toHaveLength(3);

    const entries = readRenameLogEntries(server);
    const folderEntries = entries.filter(
      (e) => e.from.startsWith('src-folder/') && e.to.startsWith('dst-folder/'),
    );
    expect(folderEntries).toHaveLength(3);
    // All three jsonl entries share the same commitSha (folder rename =
    // one drain = one commit).
    const renameSha = folderEntries[0].commitSha;
    expect(renameSha).toMatch(/^[0-9a-f]{40}$/);
    for (const e of folderEntries) expect(e.commitSha).toBe(renameSha);

    const { execSync } = await import('node:child_process');
    const shadow = resolveShadowDir(server.contentDir);
    const body = execSync(`git --git-dir=${shadow} show -s --format=%B ${renameSha}`, {
      encoding: 'utf-8',
    });
    const okActorLine = body.split('\n').find((l) => l.startsWith('ok-actor:')) ?? '';
    const okActor = JSON.parse(okActorLine.slice('ok-actor: '.length)) as {
      summaries?: string[];
      previous_paths?: Array<{ from: string; to: string }>;
    };
    // Summary lands EXACTLY ONCE despite N affected docs.
    expect(okActor.summaries).toEqual(['Renamed src-folder → dst-folder']);
    // All three doc renames are present in previous_paths.
    expect(okActor.previous_paths).toHaveLength(3);
  }, 60_000);

  test('user-supplied summary lands on the same commit as the rename event (no leak across drains)', async () => {
    // Real-world regression: the rewrite spine's `recordContributor`
    // (carrying `previousPaths`) and the handler's per-doc
    // `recordContributor` (carrying the user-supplied summary) both
    // accumulate into the same ContributorEntry. If the post-rename
    // drain fires between them, the summary leaks onto a later
    // unrelated commit while the rename commit lands without summary.
    // The drain MUST run AFTER both `recordContributor` sites have
    // fired — which means at the handler level, not inside the spine.
    const server = await bootServer();
    writeFileSync(join(server.contentDir, 'summary-a.md'), '# A\n', 'utf-8');
    await pollUntil(async () => {
      const res = await fetch(`http://127.0.0.1:${server.port}/api/documents`);
      if (!res.ok) return false;
      const data = (await res.json()) as { documents?: DocumentListEntry[] };
      return (data.documents ?? []).some((d) => isDocumentListDoc(d) && d.docName === 'summary-a');
    }, 10_000);

    const renameRes = await renamePath(server.port, {
      kind: 'file',
      fromPath: 'summary-a.md',
      toPath: 'summary-b.md',
      summary: 'Renamed summary-a → summary-b',
      ...AGENT,
    });
    expect(renameRes.status).toBe(200);

    // The rename commit's body MUST contain the summary in its OkActorEntry
    // line. Resolve via the rename log's anchor commit.
    const entries = readRenameLogEntries(server);
    const entry = entries.find((e) => e.from === 'summary-a' && e.to === 'summary-b');
    expect(entry?.commitSha).toMatch(/^[0-9a-f]{40}$/);
    const renameSha = entry?.commitSha ?? '';

    const { execSync } = await import('node:child_process');
    const shadow = resolveShadowDir(server.contentDir);
    const body = execSync(`git --git-dir=${shadow} show -s --format=%B ${renameSha}`, {
      encoding: 'utf-8',
    });
    // Summary appears in the commit subject (composeCommitSubject inlines
    // a single summary) AND/OR in the ok-actor JSON's `summaries` field.
    const okActorLine = body.split('\n').find((l) => l.startsWith('ok-actor:')) ?? '';
    const okActorBody = okActorLine.slice('ok-actor: '.length);
    const okActor = JSON.parse(okActorBody) as { summaries?: string[]; previous_paths?: unknown };
    expect(okActor.summaries).toBeDefined();
    expect(okActor.summaries).toContain('Renamed summary-a → summary-b');
    // And the previous_paths mapping is on the SAME ok-actor entry.
    expect(okActor.previous_paths).toBeDefined();

    // Trigger another drain via an unrelated agent-write and confirm the
    // next commit does NOT carry the rename's summary (no leakage).
    await agentWriteMdAndAwaitWip(server, '# Unrelated\n', {
      docName: 'unrelated-doc',
      position: 'replace',
      ...AGENT,
    });
    const unrelatedHist = await getHistory(server.port, 'unrelated-doc');
    const latestSha = unrelatedHist.entries[0]?.sha ?? '';
    expect(latestSha).not.toBe(renameSha);
    const latestBody = execSync(`git --git-dir=${shadow} show -s --format=%B ${latestSha}`, {
      encoding: 'utf-8',
    });
    expect(latestBody).not.toContain('summary-a → summary-b');
  }, 60_000);

  test('GET /api/history/:sha for a pre-rename commit returns historical content (rename-chain walk)', async () => {
    // Regression for the post-merge bug surfaced from a real test session:
    // the timeline correctly showed pre-rename entries under the new name,
    // but clicking one returned "Diff unavailable" because
    // GET /api/history/:sha did not walk the rename chain — same class of
    // bug as (handleDiff) on a different endpoint. This test asserts
    // that a pre-rename SHA's content is fetchable under the new docName.
    const server = await bootServer();
    await agentWriteMdAndAwaitWip(server, '# Haiku v1\n\noriginal body\n', {
      docName: 'haiku',
      position: 'replace',
      ...AGENT,
    });
    const preRename = await getHistory(server.port, 'haiku');
    const wipAtHaiku = preRename.entries.find((e) => e.type === 'wip');
    expect(wipAtHaiku).toBeDefined();
    const preRenameSha = wipAtHaiku?.sha ?? '';

    await crossSecondBoundary();
    expect(
      (
        await renamePath(server.port, {
          kind: 'file',
          fromPath: 'haiku.md',
          toPath: 'writing-haiku.md',
          ...AGENT,
        })
      ).status,
    ).toBe(200);

    // Fetch historical content via the post-rename name. The handler must
    // resolve the historical path (`haiku.md`) through the rename chain.
    const versionRes = await getHistoryVersion(server.port, 'writing-haiku', preRenameSha);
    expect(versionRes.status).toBe(200);
    // Status already asserted above; RFC 9457 success bodies have no `ok` field.
    expect(versionRes.body.content).toContain('Haiku v1');
    expect(versionRes.body.content).toContain('original body');
  }, 60_000);

  test('pure rename without subsequent edit → commitSha backfilled before /api/rename-path response returns', async () => {
    // Regression for the post-merge production bug surfaced from a real test
    // session: a rename that doesn't trigger any subsequent Y.Doc mutation
    // (no backlinks, doc not loaded as a Y.Doc) used to leave the rename log
    // entry at `commitSha: ''` indefinitely — the debounced
    // `scheduleGitCommit` path never fired because no Y.Doc transact
    // happened, and the next-boot `sweepLazyPopOrphans` would drop the
    // empty-`commitSha` entry as "crash residue", losing the rename history
    // permanently. The rewrite spine now `await`s `flushContributors()`
    // before the response returns, so the entry is anchored to its commit
    // by the time the API responds.
    const server = await bootServer();
    writeFileSync(join(server.contentDir, 'pure-a.md'), '# Pure A\n', 'utf-8');
    // Wait for the file watcher to index the seeded file. Skip the
    // agent-write to keep the rename "pure" — no Y.Doc loaded, no backlinks.
    await pollUntil(async () => {
      const res = await fetch(`http://127.0.0.1:${server.port}/api/documents`);
      if (!res.ok) return false;
      const data = (await res.json()) as { documents?: DocumentListEntry[] };
      return (data.documents ?? []).some((d) => isDocumentListDoc(d) && d.docName === 'pure-a');
    }, 10_000);

    const renameRes = await renamePath(server.port, {
      kind: 'file',
      fromPath: 'pure-a.md',
      toPath: 'pure-b.md',
      ...AGENT,
    });
    expect(renameRes.status).toBe(200);

    // The instant the API response returns, the rename log entry must have
    // its commitSha populated. NO polling, NO subsequent edit.
    const jsonlPath = renameLogPath(resolveShadowDir(server.contentDir));
    const raw = readFileSync(jsonlPath, 'utf-8');
    const lines = raw.split('\n').filter((l) => l.length > 0);
    const matching = lines
      .map((l) => JSON.parse(l) as RenameLogEntry)
      .filter((e) => e.from === 'pure-a' && e.to === 'pure-b');
    expect(matching).toHaveLength(1);
    expect(matching[0].commitSha).toMatch(/^[0-9a-f]{40}$/);
  }, 60_000);

  test('1000-doc folder rename completes within budget; jsonl size stays under hard cap', async () => {
    const server = await bootServer();

    const COUNT = 1000;
    mkdirSync(join(server.contentDir, 'big'), { recursive: true });
    // Seed via direct disk writes — agent-write per doc would dominate the
    // setup time and isn't what this test measures. The rename API enumerates
    // affected docs from the file index, which the file watcher populates
    // from disk.
    for (let i = 0; i < COUNT; i++) {
      writeFileSync(join(server.contentDir, 'big', `doc-${i}.md`), `# doc-${i}\n`, 'utf-8');
    }

    // Populate the file index deterministically before the rename. The
    // rename API enumerates affected docs from the in-memory file index
    // (`listAffectedDocNames`), which the file watcher fills from inotify
    // events — and parcel-watcher drops `IN_CREATE` events for files written
    // rapidly into a freshly-created subdirectory under Linux CI load (one
    // dropped event → a partial index → a partial rename). Polling the
    // watcher only deferred the flake: a CI run indexed 999/1000 within 90s.
    // `POST /api/test-rescan-files` runs a synchronous disk walk
    // (`WatcherHandle.rescanFromDisk`) that has completed by the time the
    // response returns, with no dependency on the inotify event stream.
    const rescanRes = await fetch(`http://127.0.0.1:${server.port}/api/test-rescan-files`, {
      method: 'POST',
    });
    expect(rescanRes.status).toBe(200);

    const docsRes = await fetch(`http://127.0.0.1:${server.port}/api/documents`);
    expect(docsRes.status).toBe(200);
    const docsData = (await docsRes.json()) as { documents?: DocumentListEntry[] };
    const indexedCount = (docsData.documents ?? []).filter(
      (d) => isDocumentListDoc(d) && d.docName.startsWith('big/doc-'),
    ).length;
    if (indexedCount !== COUNT) {
      throw new Error(`file index has ${indexedCount}/${COUNT} 'big/doc-' docs after rescan`);
    }

    const t0 = performance.now();
    const renameRes = await renamePath(server.port, {
      kind: 'folder',
      fromPath: 'big',
      toPath: 'huge',
      ...AGENT,
    });
    const elapsed = performance.now() - t0;
    expect(renameRes.status).toBe(200);
    expect(renameRes.body.renamed).toHaveLength(COUNT);

    const entries = readRenameLogEntries(server);
    const folderEntries = entries.filter(
      (e) => e.from.startsWith('big/doc-') && e.to.startsWith('huge/doc-'),
    );
    expect(folderEntries).toHaveLength(COUNT);

    // Performance envelope: 5ms budget per doc. Allow a
    // generous CI multiplier — budget targets local dev hardware.
    // The structural assertion is bounded throughput, not a microbenchmark:
    // 90s stays proportional to slow CI runners while still catching genuine
    // 30×+ regressions (typical local elapsed ~1s for 1000 docs).
    expect(elapsed).toBeLessThan(90_000);

    // jsonl size remains well under the 5 MB hard cap (typical entry ~250B).
    const jsonlPath = renameLogPath(resolveShadowDir(server.contentDir));
    const stat = readFileSync(jsonlPath);
    expect(stat.byteLength).toBeLessThan(1_000_000);
  }, 180_000);
});
