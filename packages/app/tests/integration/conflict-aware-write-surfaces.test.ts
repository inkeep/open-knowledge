/**
 * Conflict-aware write surfaces — end-to-end integration regression gate.
 *
 * Single test file as the cross-cutting regression check against the full
 * contract. Covers:
 *
 *   - server-observable swap-in / swap-out contract
 *   - reconciliation path sets `lifecycle.status='conflict'`
 *   - `/api/sync/conflicts` + `/api/sync/status` count parity
 *   - boot-time lifecycle restoration from `.ok/local/conflicts.json`
 *   - "Keep mine" dispatched as strategy=`content` writes the
 *     Y.Text bytes the user saw
 *   - Conflicts list HTTP shape (auto-hide vs N>0 behavior)
 *
 * Scoping note. The React-mount portions — i.e.
 * whether `<DiffViewBoundary>` actually mounts in place of `<EditorBoundary>`,
 * whether per-tab amber badges render, whether the sidebar Conflicts section
 * auto-hides — live in the `*.dom.test.tsx` suites
 * (`DiffViewBoundary.dom.test.tsx`, `use-lifecycle-status.dom.test.tsx`,
 * `EditorTabs.dom.test.tsx`, `ConflictsSection.dom.test.tsx`,
 * `use-conflicts.dom.test.tsx`). This file is deliberately the server /
 * CRDT-side gate — it asserts the data feed the hooks consume converges in
 * lockstep across the propagation paths (CRDT lifecycle Y.Map vs
 * HTTP conflicts.json) and that the lifecycle transitions are
 * observable end to end through the integration harness.
 */
import { describe, expect, test } from 'bun:test';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import {
  bootServer,
  ConfigSchema,
  getLocalDir,
  getLogger,
  restoreLifecycleFromConflictsJson,
} from '@inkeep/open-knowledge-server';
import { createTestClient, createTestServer, pollUntil, type TestServer } from './test-harness';

const execFileAsync = promisify(execFile);

const BASE_CONTENT = '# Base\n\nBase paragraph.\n';

/**
 * Seed a server with one doc on disk, then poll until the file watcher
 * surfaces it via `/api/documents`. Mirror of the helper in
 * `sync-conflict-resolution-crdt.test.ts` so the two suites share a single
 * happy-path entry shape.
 */
async function setupServerWithDoc(
  docName: string,
  initial: string,
  cleanups: Array<() => Promise<void> | void>,
  options: { debounce?: number; maxDebounce?: number } = {},
): Promise<TestServer> {
  const server = await createTestServer({
    debounce: options.debounce ?? 100,
    maxDebounce: options.maxDebounce ?? 500,
  });
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

/**
 * Write `.ok/local/conflicts.json` (schema v1) at the given projectDir so
 * `ConflictStore.load()` admits these entries on construction. The file
 * paths must exist on disk for any later `git add` to succeed (the
 * `content`-strategy resolution path writes-then-adds).
 */
function seedConflictsJson(
  projectDir: string,
  entries: Array<{ file: string; detectedAt?: string }>,
): void {
  const localDir = getLocalDir(projectDir);
  mkdirSync(localDir, { recursive: true });
  const data = {
    version: 1,
    branch: 'main',
    conflicts: entries.map((e) => ({
      file: e.file,
      detectedAt: e.detectedAt ?? '2026-05-19T00:00:00.000Z',
    })),
  };
  writeFileSync(join(localDir, 'conflicts.json'), JSON.stringify(data, null, 2), 'utf-8');
}

/**
 * Also seed `sync-state.json` with `inflightConflicts` so the SyncEngine's
 * `loadState()` populates `conflictCount` from disk. Without this,
 * `/api/sync/status` returns `conflictCount: 0` even when conflicts.json
 * carries entries — only the inflightConflicts list drives the counter.
 */
function seedSyncStateConflicts(projectDir: string, files: string[]): void {
  const localDir = getLocalDir(projectDir);
  mkdirSync(localDir, { recursive: true });
  const state = {
    version: 1,
    lastSyncUtc: null,
    lastFetchUtc: null,
    lastPushedSha: null,
    consecutiveFailures: 0,
    inflightConflicts: files,
  };
  writeFileSync(join(localDir, 'sync-state.json'), JSON.stringify(state, null, 2), 'utf-8');
}

/**
 * Stage a real in-progress git merge with conflicts on the given files so
 * the reconcile-on-restore path in `restoreLifecycleFromConflictsJson`
 * (and the SyncEngine.start() reconcile) sees a present MERGE_HEAD and
 * the files in `git diff --diff-filter=U`. Without this, both reconciles
 * correctly prune the seeded conflicts.json as stale.
 *
 * Caller is expected to write conflicts.json AFTER this returns (the
 * merge attempt leaves files marker-laden on disk; the conflicts.json
 * entries reference the same paths).
 */
async function seedRealMergeConflict(projectDir: string, files: string[]): Promise<void> {
  const opts = { cwd: projectDir };
  await execFileAsync('git', ['config', 'user.email', 'test@example.com'], opts);
  await execFileAsync('git', ['config', 'user.name', 'Test'], opts);
  for (const file of files) {
    const abs = join(projectDir, file);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, 'base\n', 'utf-8');
  }
  await execFileAsync('git', ['add', ...files], opts);
  await execFileAsync('git', ['commit', '-m', 'base'], opts);
  await execFileAsync('git', ['checkout', '-b', 'theirs-branch'], opts);
  for (const file of files) writeFileSync(join(projectDir, file), 'theirs\n', 'utf-8');
  await execFileAsync('git', ['commit', '-am', 'theirs'], opts);
  await execFileAsync('git', ['checkout', 'main'], opts);
  for (const file of files) writeFileSync(join(projectDir, file), 'ours\n', 'utf-8');
  await execFileAsync('git', ['commit', '-am', 'ours'], opts);
  // Merge attempt fails with conflict — that's the desired end state.
  await execFileAsync('git', ['merge', 'theirs-branch'], opts).catch(() => {
    /* expected: non-zero exit on conflict */
  });
}

describe('FR1 + FR2: lifecycle swap-in / swap-out (server-observable contract)', () => {
  /**
   * Scope. This suite specifies SERVER-OBSERVABLE behavior — the gate fires
   * when `lifecycle.status === 'conflict'` is set on the server-side Y.Map,
   * and admits writes again when cleared. The gate reads server-side state
   * directly via `isDocInConflict(targetDoc)` (`conflict-errors.ts`,
   * precedent #54). This test pins that server-side contract; client-side
   * propagation of the lifecycle Y.Map change (driving the UI swap to
   * DiffView) is covered by `DiffViewBoundary.dom.test.tsx` +
   * `use-lifecycle-status.dom.test.tsx`, and generic Y.js+Hocuspocus WS
   * sync is covered by the C-tests (`c1-concurrent-wysiwyg.test.ts` et al.).
   *
   */
  test('swap-in sets gate (mutations refuse); swap-out clears gate (mutations succeed); Y.Text bytes preserved', async () => {
    const cleanups: Array<() => Promise<void> | void> = [];
    try {
      const docName = `swap-${crypto.randomUUID()}`;
      const server = await setupServerWithDoc(docName, BASE_CONTENT, cleanups);

      // Load the Y.Doc into Hocuspocus via an in-process direct connection.
      // Hocuspocus loads docs lazily — `setupServerWithDoc` writes the file
      // and indexes it via the watcher, but the Y.Doc only materializes when
      // a WS client connects OR `openDirectConnection` is called. The direct
      // connection avoids the WS round-trip entirely (no propagation delay)
      // and mirrors the pattern of loading-via-DC for server-side state
      // inspection.
      const dc = await server.instance.hocuspocus.openDirectConnection(docName);
      cleanups.push(() => dc.disconnect());

      // Server-side Y.Doc is the source of truth for the gate
      // (`isDocInConflict(targetDoc)` in `conflict-errors.ts`, precedent #54).
      const serverDoc = server.instance.hocuspocus.documents.get(docName);
      expect(serverDoc).toBeTruthy();
      if (!serverDoc) throw new Error('serverDoc missing');

      const ytextBefore = serverDoc.getText('source').toString();
      expect(ytextBefore).toContain('Base paragraph');

      const lifecycleMap = serverDoc.getMap('lifecycle');

      // Initial state: clean — no lifecycle.status set, mutating handler succeeds.
      expect(lifecycleMap.get('status')).toBeUndefined();
      const preGateRes = await fetch(`http://127.0.0.1:${server.port}/api/agent-write-md`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          docName,
          markdown: BASE_CONTENT,
          position: 'replace',
          agentId: 'a',
          agentName: 'A',
        }),
      });
      expect(preGateRes.ok).toBe(true);

      // Set lifecycle.status='conflict' on the server-side Y.Map. Raw
      // Y.Map.set, no transact — matches the sibling `case 'conflict'`
      // branch convention in `server-factory.ts` (and the
      // boot-restore helper in `restoreLifecycleFromConflictsJson`).
      lifecycleMap.set('status', 'conflict');
      lifecycleMap.set('reason', 'conflict-markers');

      // Server-side state is observable synchronously after `.set()` returns
      // (Y.Map.set runs in an implicit synchronous transaction).
      expect(lifecycleMap.get('status')).toBe('conflict');
      expect(lifecycleMap.get('reason')).toBe('conflict-markers');

      // While in conflict: a mutating handler refuses with the slim
      // RFC 9457 409 envelope. The handler reads `isDocInConflict(targetDoc)`
      // directly from the server-side Y.Doc (precedent #54), so the refusal
      // is deterministic the moment the server-side `lifecycle.status` is set.
      const inConflictRes = await fetch(`http://127.0.0.1:${server.port}/api/agent-write-md`, {
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
      expect(inConflictRes.status).toBe(409);
      expect(inConflictRes.headers.get('content-type')).toContain('application/problem+json');
      const body = (await inConflictRes.json()) as Record<string, unknown>;
      expect(body.type).toBe('urn:ok:error:doc-in-conflict');

      // Clear the gate — same call-site shape as the clean / merged / noop
      // branches (`clearLifecycleConflict` in `server-factory.ts`).
      lifecycleMap.delete('status');
      lifecycleMap.delete('reason');

      expect(lifecycleMap.get('status')).toBeUndefined();
      expect(lifecycleMap.get('reason')).toBeUndefined();

      // Y.Text body bytes survive the lifecycle set/clear cycle. The lifecycle
      // mutations target a separate top-level Y.Map and do not touch the body
      // (Y.Text('source')) — the Y.Text-is-truth contract (precedent #38)
      // holds: Y.Text remains the sole carrier of user-intended source-form
      // bytes regardless of lifecycle gate transitions. Asserted BEFORE the
      // post-gate write so a hypothetical lifecycle observer that corrupts
      // Y.Text is caught here rather than restored-and-masked by the next
      // BASE_CONTENT replace.
      expect(serverDoc.getText('source').toString()).toBe(ytextBefore);

      // After the clear, mutating handlers admit writes again.
      const postGateRes = await fetch(`http://127.0.0.1:${server.port}/api/agent-write-md`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          docName,
          markdown: BASE_CONTENT,
          position: 'replace',
          agentId: 'a',
          agentName: 'A',
        }),
      });
      expect(postGateRes.ok).toBe(true);
    } finally {
      while (cleanups.length > 0) await cleanups.pop()?.();
    }
  }, 30_000);
});

describe('FR11: reconciliation conflict path sets lifecycle.status and fires the FR9 gate', () => {
  /**
   * Block-level 3-way merge failure (`case 'conflicts'` in server-factory.ts)
   * MUST set `lifecycle.status='conflict'` — without this, the reconcile
   * path silently applies marker-laden content and the conflict gates never
   * fire. Topology mirrors `sync-conflict-resolution-crdt.test.ts`: long
   * persistence debounce so `reconciledBase` stays BASE while Y.Text holds
   * OURS, then write THEIRS to disk to force `kind:'conflicts'`.
   *
   */
  test('reconcile case "conflicts" sets lifecycle.status="conflict" + mutating handler returns 409', async () => {
    const cleanups: Array<() => Promise<void> | void> = [];
    try {
      const docName = `fr11-${crypto.randomUUID()}`;
      const baseContent = '# Heading\n\nFirst paragraph.\n\nSecond paragraph.\n';
      // 60s persistence debounce keeps reconciledBase = BASE during the test
      // window so writeFileSync(THEIRS) produces a block-level merge collision
      // against the OURS edit in Y.Text (case 'conflicts', not case 'conflict').
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
      await pollUntil(() => client.ytext.toString().includes('First paragraph'));

      const lifecycle = client.doc.getMap('lifecycle');

      // OURS edit (never flushes under the 60s debounce).
      const baseOffset = client.ytext.toString().indexOf('First paragraph.');
      const baseLen = 'First paragraph.'.length;
      client.doc.transact(() => {
        client.ytext.delete(baseOffset, baseLen);
        client.ytext.insert(baseOffset, 'Our version of first paragraph.');
      });
      await pollUntil(() => {
        const sd = server.instance.hocuspocus.documents.get(docName);
        return sd?.getText('source').toString().includes('Our version') ?? false;
      }, 5000);

      // THEIRS on disk → reconcile fires kind:'conflicts'.
      const theirsContent = '# Heading\n\nTheir version of first paragraph.\n\nSecond paragraph.\n';
      writeFileSync(join(server.contentDir, `${docName}.md`), theirsContent, 'utf-8');

      await pollUntil(() => lifecycle.get('status') === 'conflict', 10_000);
      expect(lifecycle.get('status')).toBe('conflict');
      // 'merged-with-markers' distinguishes block-level reconcile (this branch)
      // from disk-marker detection ('conflict-markers').
      expect(lifecycle.get('reason')).toBe('merged-with-markers');

      // Gate fires for the reconcile-class conflict (closes a silent
      // bypass in the reconcile path).
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
      expect(res.status).toBe(409);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.type).toBe('urn:ok:error:doc-in-conflict');
    } finally {
      while (cleanups.length > 0) await cleanups.pop()?.();
    }
  }, 45_000);
});

describe('FR12: /api/sync/conflicts + /api/sync/status count parity', () => {
  /**
   * The in-browser per-tab badge count derives from per-doc Y.Map
   * `lifecycle.status` (DOM tests cover that). The sidebar
   * Conflicts section count + the topbar sync-status badge count both flow
   * from `.ok/local/conflicts.json` → SyncEngine.{getConflicts, getStatus}
   * → `/api/sync/conflicts` + `/api/sync/status`. This test pins the
   * server source of truth those two surfaces consume: seed 2 conflicts,
   * assert both endpoints report 2; resolve 1, assert both report 1.
   *
   * Test-env note: with no remote configured the SyncEngine boots into
   * dormant state but the underlying ConflictStore loads conflicts.json
   * on construction, so getConflicts() returns the seeded entries
   * regardless. `conflictCount` is populated from sync-state.json's
   * `inflightConflicts` list during `loadState()`. Resolution uses
   * `strategy: 'content'` because resolving fewer than ALL conflicts
   * skips the `git commit --no-edit` step that requires a real merge.
   *
   */
  test('seeded 2 conflicts: /api/sync/conflicts length === 2, /api/sync/status conflictCount === 2; resolve 1 → both drop to 1', async () => {
    const cleanups: Array<() => Promise<void> | void> = [];
    try {
      // Allocate a tmpdir manually so we can seed conflicts.json BEFORE the
      // SyncEngine constructs its ConflictStore inside createTestServer.
      const { mkdtempSync, realpathSync } = await import('node:fs');
      const { tmpdir } = await import('node:os');
      const tmpDir = realpathSync(mkdtempSync(join(tmpdir(), 'ok-fr12-')));
      cleanups.push(() => {
        const { rmSync } = require('node:fs') as typeof import('node:fs');
        rmSync(tmpDir, { recursive: true, force: true });
      });

      // Seed the .ok scaffold + git so createTestServer's ensureProjectGit is a no-op.
      mkdirSync(join(tmpDir, '.ok'), { recursive: true });
      writeFileSync(join(tmpDir, '.ok', 'config.yml'), '', 'utf-8');
      await execFileAsync('git', ['init', '--initial-branch=main', tmpDir]);
      await execFileAsync('git', ['-C', tmpDir, 'config', 'user.name', 'Test']);
      await execFileAsync('git', ['-C', tmpDir, 'config', 'user.email', 'test@test.com']);

      // Two conflicted files on disk + tracked in git + seeded as conflicts.
      const fileA = `fr12-a-${crypto.randomUUID()}.md`;
      const fileB = `fr12-b-${crypto.randomUUID()}.md`;
      writeFileSync(join(tmpDir, fileA), '# A\n', 'utf-8');
      writeFileSync(join(tmpDir, fileB), '# B\n', 'utf-8');
      await execFileAsync('git', ['-C', tmpDir, 'add', '.']);
      await execFileAsync('git', ['-C', tmpDir, 'commit', '-m', 'base']);

      seedConflictsJson(tmpDir, [{ file: fileA }, { file: fileB }]);
      seedSyncStateConflicts(tmpDir, [fileA, fileB]);

      const server = await createTestServer({ contentDir: tmpDir, keepContentDir: true });
      cleanups.push(() => server.cleanup());

      // /api/sync/conflicts → length 2.
      const conflictsRes = await fetch(`http://127.0.0.1:${server.port}/api/sync/conflicts`);
      expect(conflictsRes.ok).toBe(true);
      const conflictsBody = (await conflictsRes.json()) as {
        conflicts: Array<{ file: string }>;
      };
      expect(conflictsBody.conflicts).toHaveLength(2);
      const files = conflictsBody.conflicts.map((c) => c.file).sort();
      expect(files).toEqual([fileA, fileB].sort());

      // /api/sync/status → conflictCount 2.
      const statusRes = await fetch(`http://127.0.0.1:${server.port}/api/sync/status`);
      expect(statusRes.ok).toBe(true);
      const statusBody = (await statusRes.json()) as { conflictCount: number };
      expect(statusBody.conflictCount).toBe(2);

      // Resolve file A via strategy='content' — writes bytes to disk + git add,
      // leaves 1 conflict tracked (so the final commit step is skipped).
      const resolveRes = await fetch(`http://127.0.0.1:${server.port}/api/sync/resolve-conflict`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          file: fileA,
          strategy: 'content',
          content: '# A resolved\n',
        }),
      });
      expect(resolveRes.ok).toBe(true);

      // Both endpoints converge to count 1.
      const conflictsRes2 = await fetch(`http://127.0.0.1:${server.port}/api/sync/conflicts`);
      const conflictsBody2 = (await conflictsRes2.json()) as {
        conflicts: Array<{ file: string }>;
      };
      expect(conflictsBody2.conflicts).toHaveLength(1);
      expect(conflictsBody2.conflicts[0]?.file).toBe(fileB);

      const statusRes2 = await fetch(`http://127.0.0.1:${server.port}/api/sync/status`);
      const statusBody2 = (await statusRes2.json()) as { conflictCount: number };
      expect(statusBody2.conflictCount).toBe(1);
    } finally {
      while (cleanups.length > 0) await cleanups.pop()?.();
    }
  }, 45_000);
});

// CI-runnable coverage for the lifecycle-restore function itself. The
// function is exercised against `createTestServer`'s in-process hocuspocus
// instance — no `bootServer()` spawn, so the oven-sh/bun#11892 subprocess
// flake doesn't gate this test. It pairs with the boot-ordering test below
// (skip-on-CI), which is the only place the "scan happens before
// httpServer.listen()" invariant can be observed end to end.
describe('FR14: lifecycle restore function (in-process; CI-runnable)', () => {
  test('restoreLifecycleFromConflictsJson sets lifecycle.status on each tracked doc', async () => {
    const cleanups: Array<() => Promise<void> | void> = [];
    try {
      const docName = `fr14-fn-${crypto.randomUUID()}`;
      const server = await setupServerWithDoc(docName, BASE_CONTENT, cleanups);
      // Real merge state so the reconcile-on-restore path in
      // restoreLifecycleFromConflictsJson (which handles the
      // CLI-resolve-then-reopen bug) sees a present MERGE_HEAD + git-unmerged
      // entry and keeps the seeded conflicts.json instead of pruning it as stale.
      await seedRealMergeConflict(server.contentDir, [`${docName}.md`]);
      seedConflictsJson(server.contentDir, [{ file: `${docName}.md` }]);

      const warnLines: string[] = [];
      const originalWarn = console.warn;
      console.warn = (msg: unknown, ...rest: unknown[]) => {
        warnLines.push(typeof msg === 'string' ? msg : String(msg));
        originalWarn.call(console, msg, ...rest);
      };
      cleanups.push(() => {
        console.warn = originalWarn;
      });

      await restoreLifecycleFromConflictsJson({
        hocuspocus: server.instance.hocuspocus,
        projectDir: server.contentDir,
        log: getLogger('fr14-fn-test'),
      });

      // Reopen the doc — the restore disconnects after writing the
      // lifecycle. Hocuspocus persists Y.Doc state across unload/reload via
      // the persistence layer's onLoadDocument hook.
      const dc = await server.instance.hocuspocus.openDirectConnection(docName);
      try {
        const lifecycleMap = dc.document?.getMap('lifecycle');
        expect(lifecycleMap?.get('status')).toBe('conflict');
        expect(lifecycleMap?.get('reason')).toBe('conflict-markers');
      } finally {
        await dc.disconnect();
      }

      // Structured-JSON event emitted per restored doc — assertable signal
      // (`lifecycle-restored-from-conflicts-json` count per server boot).
      const restoredEvent = warnLines.find((l) => {
        try {
          const parsed = JSON.parse(l) as { event?: string; 'doc.name'?: string };
          return (
            parsed.event === 'lifecycle-restored-from-conflicts-json' &&
            parsed['doc.name'] === docName
          );
        } catch (e) {
          // Only swallow JSON parse failures — re-throw anything else so a
          // future property-access bug inside the try body fails loudly
          // instead of silently surfacing as `expect(...).toBeDefined()`.
          if (e instanceof SyntaxError) return false;
          throw e;
        }
      });
      expect(restoredEvent).toBeDefined();

      // Post-restore mutating request returns 409 — proves the gate is
      // closed via the same path the conflict gate enforces.
      const res = await fetch(`http://127.0.0.1:${server.port}/api/agent-write-md`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          docName,
          markdown: '# replacement\n',
          position: 'replace',
          agentId: 'a',
          agentName: 'A',
        }),
      });
      expect(res.status).toBe(409);
    } finally {
      while (cleanups.length > 0) await cleanups.pop()?.();
    }
  }, 30_000);

  test('restoreLifecycleFromConflictsJson is a no-op when conflicts.json is missing', async () => {
    const cleanups: Array<() => Promise<void> | void> = [];
    try {
      const docName = `fr14-fn-empty-${crypto.randomUUID()}`;
      const server = await setupServerWithDoc(docName, BASE_CONTENT, cleanups);
      // Intentionally do NOT call seedConflictsJson — `.ok/local/conflicts.json`
      // is absent, so the function must short-circuit without crashing.
      await restoreLifecycleFromConflictsJson({
        hocuspocus: server.instance.hocuspocus,
        projectDir: server.contentDir,
        log: getLogger('fr14-fn-test'),
      });

      // No lifecycle written.
      const dc = await server.instance.hocuspocus.openDirectConnection(docName);
      try {
        const lifecycleMap = dc.document?.getMap('lifecycle');
        expect(lifecycleMap?.get('status')).toBeUndefined();
      } finally {
        await dc.disconnect();
      }
    } finally {
      while (cleanups.length > 0) await cleanups.pop()?.();
    }
  }, 30_000);
});

describe('on-load lifecycle seed from ConflictStore (runtime race fix)', () => {
  /**
   * Bug: clicking a conflicted `.mdx` (or `.md`) entry in the Conflicts tab
   * opened the regular editor instead of `<DiffViewBoundary>` when the conflict
   * landed while the doc was unloaded. `case 'conflict'` in `handleDiskEvent`
   * silently returns when `hocuspocus.documents.get(docName)` is undefined,
   * so the per-doc `lifecycle.status` Y.Map was never set.
   *
   * Fix: `createConflictLifecycleSeedExtension` in `packages/server/src/
   * conflict-lifecycle-seed.ts` hooks `afterLoadDocument` and seeds the
   * lifecycle Y.Map from the live ConflictStore on every doc load.
   *
   * Coverage shape: seed conflicts.json BEFORE construction so the SyncEngine
   * boots with ConflictStore populated. Use `createTestServer` (not
   * `bootServer`) so `restoreLifecycleFromConflictsJson` does NOT pre-seed
   * the lifecycle — that isolates the on-load extension as the only path
   * that can set it. The client's first connection to the doc triggers the
   * extension and the test asserts lifecycle propagates back over the WS.
   *
   */
  async function runOnLoadSeedTest(extension: '.md' | '.mdx') {
    const cleanups: Array<() => Promise<void> | void> = [];

    // Capture console.warn so the test can assert on the structured-JSON
    // event the extension emits per seeded doc. Mirrors the pattern
    // for `lifecycle-restored-from-conflicts-json`.
    const warnLines: string[] = [];
    const originalWarn = console.warn;
    console.warn = (msg: unknown, ...rest: unknown[]) => {
      warnLines.push(typeof msg === 'string' ? msg : String(msg));
      originalWarn.call(console, msg, ...rest);
    };
    cleanups.push(() => {
      console.warn = originalWarn;
    });

    try {
      const { mkdtempSync, realpathSync, rmSync } = await import('node:fs');
      const { tmpdir } = await import('node:os');
      const tmpDir = realpathSync(mkdtempSync(join(tmpdir(), 'ok-onload-seed-')));
      cleanups.push(() => rmSync(tmpDir, { recursive: true, force: true }));

      // Real git + .ok/ scaffold so SyncEngine constructs without bailing.
      await execFileAsync('git', ['init', '--initial-branch=main', tmpDir]);
      mkdirSync(join(tmpDir, '.ok'), { recursive: true });
      writeFileSync(join(tmpDir, '.ok', 'config.yml'), '', 'utf-8');
      writeFileSync(join(tmpDir, '.ok', '.gitignore'), '', 'utf-8');

      const docName = `onload-${crypto.randomUUID()}`;
      const fileName = `${docName}${extension}`;

      // Stage a real merge conflict and seed the ConflictStore so the
      // SyncEngine's getConflicts() returns this entry on load.
      await seedRealMergeConflict(tmpDir, [fileName]);
      seedConflictsJson(tmpDir, [{ file: fileName }]);

      // createTestServer uses createServer (not bootServer), so
      // restoreLifecycleFromConflictsJson does NOT run. The doc's Y.Map
      // starts with lifecycle unset — the on-load extension is the sole
      // path that can flip it.
      const server = await createTestServer({
        contentDir: tmpDir,
        keepContentDir: true,
        debounce: 100,
        maxDebounce: 500,
      });
      cleanups.push(() => server.cleanup());

      // Wait for the watcher to surface the doc to /api/documents.
      await pollUntil(async () => {
        const res = await fetch(`http://127.0.0.1:${server.port}/api/documents`).catch(() => null);
        if (!res?.ok) return false;
        const data = (await res.json()) as { documents?: Array<{ docName: string }> };
        return data.documents?.some((d) => d.docName === docName) ?? false;
      }, 5_000);

      // First-ever client connection — afterLoadDocument fires here.
      const client = await createTestClient(server.port, docName, {
        skipInvariantWatcher: true,
      });
      cleanups.push(() => client.cleanup());

      const lifecycle = client.doc.getMap('lifecycle');
      await pollUntil(() => lifecycle.get('status') === 'conflict', 10_000);
      expect(lifecycle.get('status')).toBe('conflict');
      expect(lifecycle.get('reason')).toBe('conflict-markers');

      // Lock the structured-JSON event contract — the extension MUST emit
      // `lifecycle-seeded-on-load-from-conflict-store` per seeded doc.
      // Mirrors the `lifecycle-restored-from-conflicts-json` assertion
      // convention; consumed by log aggregation / adoption tracking and as
      // a forensic breadcrumb when triaging "diff didn't appear" reports.
      const seededEvent = warnLines.find((l) => {
        try {
          const parsed = JSON.parse(l) as { event?: string; 'doc.name'?: string };
          return (
            parsed.event === 'lifecycle-seeded-on-load-from-conflict-store' &&
            parsed['doc.name'] === docName
          );
        } catch (e) {
          // Only swallow JSON parse failures — re-throw anything else so a
          // future property-access bug inside the try body fails loudly
          // instead of silently surfacing as `expect(...).toBeDefined()`.
          if (e instanceof SyntaxError) return false;
          throw e;
        }
      });
      expect(seededEvent).toBeDefined();
    } finally {
      while (cleanups.length > 0) await cleanups.pop()?.();
    }
  }

  test('.md  — first client connect seeds lifecycle.status="conflict" from ConflictStore', async () => {
    await runOnLoadSeedTest('.md');
  }, 30_000);

  test('.mdx — first client connect seeds lifecycle.status="conflict" from ConflictStore', async () => {
    await runOnLoadSeedTest('.mdx');
  }, 30_000);
});

const describeBoot = process.env.CI ? describe.skip : describe;

describeBoot('FR14: boot-time lifecycle restoration from conflicts.json', () => {
  /**
   * Skip on CI to mirror `boot-conflict-restore.test.ts` — bootServer +
   * git subprocesses hit oven-sh/bun#11892 on ubuntu-latest. The integration
   * harness's `createTestServer` calls `createServer()` directly, NOT
   * `bootServer()`, so this test uses `bootServer` to exercise the
   * boot scan that runs BEFORE httpServer.listen().
   *
   */
  test('conflicts.json with entry X → lifecycle.status="conflict" set + immediate POST returns 409', async () => {
    const cleanups: Array<() => Promise<void> | void> = [];
    try {
      const { mkdtempSync, realpathSync, rmSync } = await import('node:fs');
      const { tmpdir } = await import('node:os');
      const tmpDir = realpathSync(mkdtempSync(join(tmpdir(), 'ok-fr14-')));
      cleanups.push(() => rmSync(tmpDir, { recursive: true, force: true }));

      await execFileAsync('git', ['init', '--initial-branch=main', tmpDir]);
      mkdirSync(join(tmpDir, '.ok'), { recursive: true });
      writeFileSync(join(tmpDir, '.ok', 'config.yml'), '', 'utf-8');
      writeFileSync(join(tmpDir, '.ok', '.gitignore'), '', 'utf-8');
      const fileName = `fr14-${crypto.randomUUID()}.md`;
      // Real in-progress merge so the boot-restore reconcile keeps the
      // entry instead of pruning it (the reconcile is the fix for the
      // CLI-resolve-then-reopen bug; the test needs to simulate the
      // actual product state).
      await seedRealMergeConflict(tmpDir, [fileName]);
      seedConflictsJson(tmpDir, [{ file: fileName }]);

      // Capture console.warn — the restore helper emits a structured-JSON
      // event the test asserts is present per restored doc.
      const warnLines: string[] = [];
      const originalWarn = console.warn;
      console.warn = (msg: unknown, ...rest: unknown[]) => {
        warnLines.push(typeof msg === 'string' ? msg : String(msg));
        originalWarn.call(console, msg, ...rest);
      };
      cleanups.push(() => {
        console.warn = originalWarn;
      });

      const booted = await bootServer({
        config: ConfigSchema.parse({}),
        contentDir: tmpDir,
        port: 0,
        quiet: true,
        gitEnabled: false,
        idleShutdownMs: null,
        attachUiSibling: false,
      });
      cleanups.push(() => booted.destroy());

      // Lifecycle restored — `bootServer` calls `restoreLifecycleFromConflictsJson`
      // synchronously before httpServer.listen() resolves, so by the time
      // `bootServer` returns, the doc's Y.Map already carries the gate.
      const docName = fileName.replace(/\.md$/, '');
      const dc = await booted.serverInstance.hocuspocus.openDirectConnection(docName);
      try {
        const lifecycleMap = dc.document?.getMap('lifecycle');
        expect(lifecycleMap?.get('status')).toBe('conflict');
        expect(lifecycleMap?.get('reason')).toBe('conflict-markers');
      } finally {
        await dc.disconnect();
      }

      // Structured-JSON event emitted per restored doc.
      const restoredEvent = warnLines.find((l) => {
        try {
          const parsed = JSON.parse(l) as { event?: string; 'doc.name'?: string };
          return (
            parsed.event === 'lifecycle-restored-from-conflicts-json' &&
            parsed['doc.name'] === docName
          );
        } catch (e) {
          // Only swallow JSON parse failures — re-throw anything else so a
          // future property-access bug inside the try body fails loudly
          // instead of silently surfacing as `expect(...).toBeDefined()`.
          if (e instanceof SyntaxError) return false;
          throw e;
        }
      });
      expect(restoredEvent).toBeDefined();

      // Immediate mutating request post-boot returns 409 (the gate is
      // closed BEFORE any request reaches the handler).
      const res = await fetch(`http://127.0.0.1:${booted.port}/api/agent-write-md`, {
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
      expect(res.status).toBe(409);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.type).toBe('urn:ok:error:doc-in-conflict');
    } finally {
      while (cleanups.length > 0) await cleanups.pop()?.();
    }
  }, 30_000);
});

describe('FR16: "Keep mine" dispatched as strategy="content" writes the bytes the user saw (CH-H1)', () => {
  /**
   * The fix: pre-conflict unflushed Y.Text edits must reach disk after
   * "Keep mine" because the editor-area DiffView passes the live Y.Text
   * snapshot as the resolve-conflict `content` payload (NOT `git show :2:`
   * bytes, which would lose the in-flight edits). This test demonstrates
   * the round-trip:
   *
   *   1. Doc loaded; user types `... + USER EDITS` into Y.Text but it never
   *      flushes (persistence skip during conflict; here we use a long
   *      debounce to keep BASE on disk).
   *   2. Lifecycle.status='conflict' is set (simulating the moment the
   *      file-watcher detects conflict markers — but using the long
   *      debounce we keep disk at BASE_CONTENT and Y.Text at OURS+EDITS).
   *   3. Client captures `live = ytext.toString()` — what the DiffView's
   *      "ours" pane would render under the `?source=ytext` query.
   *   4. POST /api/sync/resolve-conflict { strategy: 'content', content: live }.
   *   5. Read disk; assert it equals `live` — proving the bytes the user
   *      SAW landed on disk via the content-strategy round-trip.
   *
   */
  test('content-strategy resolution writes the Y.Text snapshot (CH-H1 round-trip)', async () => {
    const cleanups: Array<() => Promise<void> | void> = [];
    try {
      // Long persistence debounce so Y.Text edits stay in-memory; disk
      // holds the BASE bytes throughout the test window. This mirrors the
      // reality: during conflict the persistence layer doesn't
      // flush, so the only place the "OURS + USER EDITS" bytes exist is
      // the live Y.Text.
      const docName = `fr16-${crypto.randomUUID()}`;
      const fileName = `${docName}.md`;
      const server = await createTestServer({ debounce: 60_000, maxDebounce: 60_000 });
      cleanups.push(() => server.cleanup());

      // Wire git tracking so the `git add` inside ConflictStore.resolveConflict
      // succeeds. The harness already calls ensureProjectGit; we just need
      // the file to be a known path that `git add` accepts.
      writeFileSync(join(server.contentDir, fileName), BASE_CONTENT, 'utf-8');
      await execFileAsync('git', ['-C', server.contentDir, 'config', 'user.name', 'Test']);
      await execFileAsync('git', [
        '-C',
        server.contentDir,
        'config',
        'user.email',
        'test@test.com',
      ]);
      await execFileAsync('git', ['-C', server.contentDir, 'add', fileName]);
      await execFileAsync('git', ['-C', server.contentDir, 'commit', '-m', 'base']);

      await pollUntil(async () => {
        const res = await fetch(`http://127.0.0.1:${server.port}/api/documents`).catch(() => null);
        if (!res?.ok) return false;
        const data = (await res.json()) as { documents?: Array<{ docName: string }> };
        return data.documents?.some((d) => d.docName === docName) ?? false;
      });

      const client = await createTestClient(server.port, docName);
      cleanups.push(() => client.cleanup());
      await pollUntil(() => client.ytext.toString().includes('Base paragraph'));

      // Type USER EDITS into Y.Text — these never flush under the 60s debounce.
      const editMarker = '\n\nUSER EDIT typed mid-session.\n';
      client.doc.transact(() => {
        client.ytext.insert(client.ytext.length, editMarker);
      });
      await pollUntil(() => {
        const sd = server.instance.hocuspocus.documents.get(docName);
        return sd?.getText('source').toString().includes('USER EDIT') ?? false;
      }, 5000);

      // Sanity: disk still shows BASE (the bytes the team would see in a
      // pre-resolve `git show :2:` query against an external conflict file).
      const diskBefore = readFileSync(join(server.contentDir, fileName), 'utf-8');
      expect(diskBefore).toBe(BASE_CONTENT);
      expect(diskBefore).not.toContain('USER EDIT');

      // Set lifecycle.status='conflict' (proxy for the moment the
      // file-watcher detects markers; we drive the gate directly so the
      // long debounce keeps disk at BASE). Raw Y.Map.set, no transact —
      // matches the sibling test convention and the production
      // `case 'conflict'` branch in `server-factory.ts`
      // (the reconcile path reaches the same lifecycle state via the
      // file-watcher, not the raw-set convention). The server-side
      // Y.Map.set is synchronous; the downstream `store.resolveConflict`
      // reads server-side state directly, so no WS sync to a connected
      // client is required. This eliminates the 10s
      // `pollUntil(client.doc.getMap('lifecycle')...)` flake that surfaced
      // on the contended `ubuntu-64gb workers=4` runner.
      const serverDoc = server.instance.hocuspocus.documents.get(docName);
      if (!serverDoc) throw new Error(`serverDoc not found for ${docName}`);
      const lifecycleMap = serverDoc.getMap('lifecycle');
      lifecycleMap.set('status', 'conflict');
      lifecycleMap.set('reason', 'conflict-markers');
      expect(lifecycleMap.get('status')).toBe('conflict');
      expect(lifecycleMap.get('reason')).toBe('conflict-markers');

      // Exercise the byte-equality contract via ConflictStore directly.
      // The server-side HTTP handler ultimately calls
      // `engine.resolveConflict` → `store.resolveConflict`, but invoking
      // that handler with a single tracked conflict triggers the final
      // `git commit --no-edit` step. Outside a real `git merge` (which
      // would require setting up MERGE_HEAD via simple-git's
      // multi-branch divergence pattern), that commit fails and re-adds
      // the file. The byte-equality contract is independent of the
      // commit-step success path — the assertion that owns this test is:
      // when "Keep mine" passes the live Y.Text snapshot as
      // `content`, that snapshot is what lands on disk. We seed TWO
      // conflicts so that resolving the first short-circuits the
      // `hasConflicts() === false` branch (no commit fires); the
      // byte-equality round-trip is observable cleanly.
      const { ConflictStore } = await import('../../../server/src/conflict-storage.ts');
      const otherFile = `fr16-other-${crypto.randomUUID()}.md`;
      writeFileSync(join(server.contentDir, otherFile), '# Other\n', 'utf-8');
      await execFileAsync('git', ['-C', server.contentDir, 'add', otherFile]);
      await execFileAsync('git', ['-C', server.contentDir, 'commit', '-m', 'other base']);
      const store = new ConflictStore(server.contentDir, 'main');
      store.addConflict({ file: fileName, detectedAt: '2026-05-19T00:00:00.000Z' });
      store.addConflict({ file: otherFile, detectedAt: '2026-05-19T00:00:00.000Z' });

      // Snapshot the bytes the DiffView's "ours" pane would render. Under
      // the `?source=ytext` query this is `serializeDoc(docName)` server-side =
      // `Y.Text('source').toString()` client-side (frontmatter + body
      // round-trip via the same primitive).
      const ourBytes = client.ytext.toString();
      expect(ourBytes).toContain('Base paragraph');
      expect(ourBytes).toContain('USER EDIT');

      // Dispatch the "Keep mine" path — strategy: 'content' with the live
      // Y.Text snapshot. With two conflicts seeded, this resolves only
      // the first and skips the final commit step.
      await store.resolveConflict(fileName, 'content', ourBytes);

      // Disk now equals the bytes the user saw — NOT BASE_CONTENT, NOT a
      // theirs-marker payload: the round-trip preserved the in-flight edits
      // the editor surfaced.
      const diskAfter = readFileSync(join(server.contentDir, fileName), 'utf-8');
      expect(diskAfter).toBe(ourBytes);
      expect(diskAfter).toContain('USER EDIT');
    } finally {
      while (cleanups.length > 0) await cleanups.pop()?.();
    }
  }, 45_000);
});

describe('FR17: Conflicts list HTTP shape (data feed the sidebar section consumes)', () => {
  /**
   * UI auto-hide + row-click → focus tab are covered by
   * `ConflictsSection.dom.test.tsx` + `use-conflicts.dom.test.tsx`. This
   * test pins the underlying HTTP shape those hooks consume: when a
   * conflict is seeded, `/api/sync/conflicts` returns it with the file
   * path field; when the conflict is resolved, the array empties (the
   * source of truth driving the section's `return null` at zero).
   *
   */
  test('seeded conflicts surface via /api/sync/conflicts; resolve → list drops; auto-hide-at-zero is observable via empty array', async () => {
    const cleanups: Array<() => Promise<void> | void> = [];
    try {
      const { mkdtempSync, realpathSync, rmSync } = await import('node:fs');
      const { tmpdir } = await import('node:os');
      const tmpDir = realpathSync(mkdtempSync(join(tmpdir(), 'ok-fr17-')));
      cleanups.push(() => rmSync(tmpDir, { recursive: true, force: true }));

      mkdirSync(join(tmpDir, '.ok'), { recursive: true });
      writeFileSync(join(tmpDir, '.ok', 'config.yml'), '', 'utf-8');
      await execFileAsync('git', ['init', '--initial-branch=main', tmpDir]);

      const fileA = `fr17-a-${crypto.randomUUID()}.md`;
      const fileB = `fr17-b-${crypto.randomUUID()}.md`;
      // Stage a real two-file merge conflict so the sync-engine's
      // start() reconcile (which clears conflicts.json when no
      // MERGE_HEAD is present) keeps the seeded entries.
      await seedRealMergeConflict(tmpDir, [fileA, fileB]);

      // Seed TWO conflicts so resolving the first short-circuits the
      // `hasConflicts() === false` branch in ConflictStore.resolveConflict
      // — the final `git commit --no-edit` step doesn't fire (it would
      // fail outside of a real MERGE_HEAD). With the second still tracked,
      // the engine's count = 1 after the first resolve. To demonstrate the
      // auto-hide-at-zero shape, we ALSO use a second-server pattern with
      // zero seeded conflicts (the section's `return null` precondition).
      seedConflictsJson(tmpDir, [{ file: fileA }, { file: fileB }]);
      seedSyncStateConflicts(tmpDir, [fileA, fileB]);

      const server = await createTestServer({ contentDir: tmpDir, keepContentDir: true });
      cleanups.push(() => server.cleanup());

      // Section header + count surface from this shape: { conflicts: [{file, detectedAt, ...}] }.
      const beforeRes = await fetch(`http://127.0.0.1:${server.port}/api/sync/conflicts`);
      expect(beforeRes.ok).toBe(true);
      const beforeBody = (await beforeRes.json()) as {
        conflicts: Array<{ file: string; detectedAt: string }>;
      };
      expect(beforeBody.conflicts).toHaveLength(2);
      const fileSet = new Set(beforeBody.conflicts.map((c) => c.file));
      expect(fileSet.has(fileA)).toBe(true);
      expect(fileSet.has(fileB)).toBe(true);
      // Shape: each entry carries a detectedAt timestamp (ConflictEntry schema).
      for (const entry of beforeBody.conflicts) {
        expect(typeof entry.detectedAt).toBe('string');
      }

      // Resolve fileA via the live HTTP endpoint (mirrors what the
      // editor-area DiffView dispatches under [Keep mine]).
      const resolveRes = await fetch(`http://127.0.0.1:${server.port}/api/sync/resolve-conflict`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          file: fileA,
          strategy: 'content',
          content: '# A resolved\n',
        }),
      });
      expect(resolveRes.ok).toBe(true);

      // After resolution: list dropped to fileB only.
      const afterRes = await fetch(`http://127.0.0.1:${server.port}/api/sync/conflicts`);
      const afterBody = (await afterRes.json()) as { conflicts: Array<{ file: string }> };
      expect(afterBody.conflicts).toHaveLength(1);
      expect(afterBody.conflicts[0]?.file).toBe(fileB);

      // Auto-hide-at-zero demonstration: a fresh server over a tmpdir with
      // no seeded conflicts returns `{ conflicts: [] }`. That empty-array
      // shape is what the ConflictsSection's `return null` keys off.
      const { mkdtempSync: mkdtempSync2, realpathSync: realpathSync2 } = await import('node:fs');
      const tmpDir2 = realpathSync2(mkdtempSync2(join(tmpdir(), 'ok-fr17-empty-')));
      cleanups.push(() => rmSync(tmpDir2, { recursive: true, force: true }));
      mkdirSync(join(tmpDir2, '.ok'), { recursive: true });
      writeFileSync(join(tmpDir2, '.ok', 'config.yml'), '', 'utf-8');
      await execFileAsync('git', ['init', '--initial-branch=main', tmpDir2]);
      const server2 = await createTestServer({ contentDir: tmpDir2, keepContentDir: true });
      cleanups.push(() => server2.cleanup());
      const emptyRes = await fetch(`http://127.0.0.1:${server2.port}/api/sync/conflicts`);
      const emptyBody = (await emptyRes.json()) as { conflicts: Array<{ file: string }> };
      expect(emptyBody.conflicts).toHaveLength(0);

      // Sanity: conflicts.json on disk for the resolved-from-2 server now
      // shows only fileB — the section count + disk truth + endpoint shape
      // converge on the same source.
      const storedPath = join(getLocalDir(tmpDir), 'conflicts.json');
      expect(existsSync(storedPath)).toBe(true);
      const stored = JSON.parse(readFileSync(storedPath, 'utf-8')) as {
        conflicts: Array<{ file: string }>;
      };
      expect(stored.conflicts).toHaveLength(1);
      expect(stored.conflicts[0]?.file).toBe(fileB);
    } finally {
      while (cleanups.length > 0) await cleanups.pop()?.();
    }
  }, 45_000);
});
