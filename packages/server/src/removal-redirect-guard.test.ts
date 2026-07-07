import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { HocuspocusAuthRejection } from './auth-token-schema.ts';
import { getMetrics, resetMetrics } from './metrics.ts';
import { RecentlyRemovedDocs } from './recently-removed-docs.ts';
import { runRemovalRedirectGuard } from './removal-redirect-guard.ts';

// ─── Test harness ───────────────────────────────────────────────────────────
//
// Builds the dependency triple `runRemovalRedirectGuard` consumes (cache +
// path resolver + fs probe). The path resolver mirrors
// `server-factory.ts:resolveDocFilePath` so tests exercise the same shape
// the registered extension uses at runtime; `fileExists` is wired to the
// real `existsSync` against a tmpdir so the file-existence-first branch is
// observed via real filesystem state, not a stub.

interface Harness {
  contentDir: string;
  cache: RecentlyRemovedDocs;
  resolveFilePath: (docName: string) => string | null;
  warns: string[];
  run: (documentName: string) => Promise<unknown>;
  cleanup: () => void;
}

function makeHarness(opts: { fileExists?: (filePath: string) => boolean } = {}): Harness {
  const contentDir = mkdtempSync(join(tmpdir(), 'ok-removal-guard-'));
  const cache = new RecentlyRemovedDocs();
  const warns: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]): void => {
    warns.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
  };

  const resolveFilePath = (docName: string): string | null => {
    if (
      docName.includes('..') ||
      docName.startsWith('/') ||
      docName.includes('\x00') ||
      docName.includes('\\')
    ) {
      return null;
    }
    return resolve(contentDir, `${docName}.md`);
  };

  const run = async (documentName: string): Promise<unknown> => {
    let thrown: unknown = null;
    try {
      await runRemovalRedirectGuard(documentName, {
        recentlyRemovedDocs: cache,
        resolveFilePath,
        fileExists: opts.fileExists ?? existsSync,
      });
    } catch (err) {
      thrown = err;
    }
    return thrown;
  };

  return {
    contentDir,
    cache,
    resolveFilePath,
    warns,
    run,
    cleanup: () => {
      console.warn = originalWarn;
      try {
        rmSync(contentDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    },
  };
}

describe('runRemovalRedirectGuard', () => {
  let harness: Harness;

  beforeEach(() => {
    resetMetrics();
    harness = makeHarness();
  });
  afterEach(() => {
    harness.cleanup();
  });

  // ─── Synthetic-doc passthrough ────────────────────────────────────────────

  test('system docs short-circuit at entry (no cache lookup, no redirect)', async () => {
    // Pre-populate the cache with a same-name entry to prove the gate
    // wins over the lookup. A real subsystem would never put `__system__`
    // in the cache (STOP rule), but the gate must hold even if it did.
    harness.cache.setDeleted('__system__');
    const thrown = await harness.run('__system__');
    expect(thrown).toBeNull();
    expect(getMetrics().authDocDeletedCount).toBe(0);
  });

  test('config docs short-circuit at entry', async () => {
    const thrown = await harness.run('__config__/project');
    expect(thrown).toBeNull();
  });

  // ─── (recreation collision) is handled by upstream invalidation ────────

  test('recreation collision (G5) admits — cache invalidated by create-page upstream', async () => {
    // The production path: `/api/create-page`
    // calls `cache.delete(docName)` after the sync-write succeeds, and
    // the watcher's `'add'` event in server-factory.ts does the same
    // when an external touch lands a file at a stale path. Both paths
    // ensure the cache is empty for the docName by the time the auth
    // extension runs, so the originating connection admits cleanly.
    writeFileSync(join(harness.contentDir, 'foo.md'), '# foo');
    // Stale entry from a prior rename → upstream invalidation has fired.
    harness.cache.setRenamed('foo', 'bar');
    harness.cache.delete('foo'); // simulates /api/create-page / watcher 'add'
    expect(harness.cache.has('foo')).toBe(false);

    const thrown = await harness.run('foo');
    expect(thrown).toBeNull();
  });

  test('G5 defense-in-depth: deleted entry + file present → guard drops stale entry and admits', async () => {
    // Defense-in-depth path for the guard's own deleted-kind branch. The
    // upstream invalidation in `/api/create-page` and watcher `'add'` is
    // the primary mechanism, but if a file is recreated
    // via a path that doesn't invalidate — or in the race window before
    // invalidation fires — the guard's `fileExistsForDocName` branch
    // admits AND drops the stale cache entry so the next
    // attempt skips the lookup entirely.
    writeFileSync(join(harness.contentDir, 'foo.md'), '# recreated');
    harness.cache.setDeleted('foo');

    const thrown = await harness.run('foo');
    expect(thrown).toBeNull();
    expect(harness.cache.has('foo')).toBe(false);
    expect(getMetrics().authDocDeletedCount).toBe(0);
  });

  test('cache-claim authority: stale renamed entry + present file → redirect (failed-rename rollback)', async () => {
    // Cache says renamed but the file is still at the OLD name. The
    // spine completes the disk move before the forced close, so this
    // skew no longer arises from the close-driven reconnect; it arises
    // from a failed-rename rollback (`withManagedRenameRecovery`
    // restored the source on disk but did not clear the cache). The
    // guard trusts the cache absolutely for the `renamed` kind (no
    // file-existence self-clean) — redirect regardless.
    writeFileSync(join(harness.contentDir, 'foo.md'), '# foo (in flight)');
    harness.cache.setRenamed('foo', 'bar');

    const thrown = await harness.run('foo');
    expect(thrown).toBeInstanceOf(HocuspocusAuthRejection);
    expect((thrown as HocuspocusAuthRejection).kind).toBe('rename-redirect');
    expect((thrown as HocuspocusAuthRejection).payload).toBe('bar');
  });

  test('no file and no cache entry admits (legitimate first-write may follow)', async () => {
    const thrown = await harness.run('not-yet-created');
    expect(thrown).toBeNull();
  });

  // ─── Single-hop rename redirect ───────────────────────────────────────────

  test('single-hop rename redirect: file at newDocName → throws rename-redirect with payload', async () => {
    writeFileSync(join(harness.contentDir, 'bar.md'), '# bar');
    harness.cache.setRenamed('foo', 'bar');

    const thrown = await harness.run('foo');
    expect(thrown).toBeInstanceOf(HocuspocusAuthRejection);
    const rej = thrown as HocuspocusAuthRejection;
    expect(rej.kind).toBe('rename-redirect');
    expect(rej.payload).toBe('bar');
    expect(rej.reason).toBe('rename-redirect:bar');
    expect(getMetrics().authRenameRedirectCount).toBe(1);
  });

  // ─── Single-hop delete reject ─────────────────────────────────────────────

  test('single-hop delete: cache says deleted, no file → throws doc-deleted', async () => {
    harness.cache.setDeleted('foo');

    const thrown = await harness.run('foo');
    expect(thrown).toBeInstanceOf(HocuspocusAuthRejection);
    const rej = thrown as HocuspocusAuthRejection;
    expect(rej.kind).toBe('doc-deleted');
    expect(rej.payload).toBeUndefined();
    expect(rej.reason).toBe('doc-deleted');
    expect(getMetrics().authDocDeletedCount).toBe(1);
    expect(getMetrics().authRenameRedirectCount).toBe(0);
  });

  // ─── Multi-hop chain walk ─────────────────────────────────────────────────

  test('multi-hop chain walk terminates at file-exists target', async () => {
    // A → B → C, only C.md exists.
    writeFileSync(join(harness.contentDir, 'C.md'), '# C');
    harness.cache.setRenamed('A', 'B');
    harness.cache.setRenamed('B', 'C');

    const thrown = await harness.run('A');
    expect(thrown).toBeInstanceOf(HocuspocusAuthRejection);
    const rej = thrown as HocuspocusAuthRejection;
    expect(rej.kind).toBe('rename-redirect');
    expect(rej.payload).toBe('C');
    expect(getMetrics().authRenameRedirectCount).toBe(1);
  });

  test('chain walk lands on a deleted entry mid-chain → throws doc-deleted', async () => {
    // A → B → (deleted), no files on disk.
    harness.cache.setRenamed('A', 'B');
    harness.cache.setDeleted('B');

    const thrown = await harness.run('A');
    expect(thrown).toBeInstanceOf(HocuspocusAuthRejection);
    const rej = thrown as HocuspocusAuthRejection;
    expect(rej.kind).toBe('doc-deleted');
    expect(getMetrics().authDocDeletedCount).toBe(1);
  });

  test('chain walk lands on a deleted entry whose file was recreated → redirect to terminal, drop stale entry', async () => {
    // A → B → (deleted), but B.md was recreated on disk. The chain walk
    // exercises the branch: cache says B is deleted, but
    // the file exists, so drop the stale deleted entry for B and redirect
    // the originating connect on A to the live B. Conservative choice per
    // the source comment — land the client on the live doc rather than
    // the stale ancestor.
    writeFileSync(join(harness.contentDir, 'B.md'), '# B recreated');
    harness.cache.setRenamed('A', 'B');
    harness.cache.setDeleted('B');

    const thrown = await harness.run('A');
    expect(thrown).toBeInstanceOf(HocuspocusAuthRejection);
    const rej = thrown as HocuspocusAuthRejection;
    expect(rej.kind).toBe('rename-redirect');
    expect(rej.payload).toBe('B');
    expect(harness.cache.has('B')).toBe(false);
    expect(getMetrics().authRenameRedirectCount).toBe(1);
    expect(getMetrics().authDocDeletedCount).toBe(0);
  });

  test('chain walk that runs off the end (no file, no cache entry) still redirects (in-flight rename)', async () => {
    // A → B → undefined: B has no file and no further cache entry.
    // Under the cache-first algorithm the cache claim is authoritative,
    // so we redirect to B regardless of `existsSync(B.md)`. The spine
    // moves the file before the forced close, so a B-absent state here
    // is the residual case: a brand-new connection landing during the
    // narrow `git mv` syscall window, or a failed-rename rollback that
    // removed B. The redirect succeeds at the wire level; the client's
    // next handshake against B either admits (disk caught up / source
    // restored) or loads an empty doc that syncs when the file lands.
    harness.cache.setRenamed('A', 'B');
    const thrown = await harness.run('A');
    expect(thrown).toBeInstanceOf(HocuspocusAuthRejection);
    expect((thrown as HocuspocusAuthRejection).kind).toBe('rename-redirect');
    expect((thrown as HocuspocusAuthRejection).payload).toBe('B');
  });

  // ─── Cycle protection ─────────────────────────────────────────────────────

  test('pathological cycle (A → B → A) admits with structured warn (no infinite loop)', async () => {
    harness.cache.setRenamed('A', 'B');
    harness.cache.setRenamed('B', 'A');

    const thrown = await harness.run('A');
    expect(thrown).toBeNull();
    const cycleWarns = harness.warns.filter((w) => w.includes('removal-redirect-chain-cycle'));
    expect(cycleWarns.length).toBe(1);
    expect(cycleWarns[0]).toContain('"documentName":"A"');
    // Counter mirrors `authRemovalGuardErrors` for the same defense-bypass
    // class — operators alert on either when phantom-resurrection protection
    // silently degrades.
    expect(getMetrics().removalRedirectChainCycles).toBe(1);
  });

  // ─── Internal-error fall-through ──────────────────────────────────────────

  test('internal error from cache lookup falls through to admit + structured warn + counter', async () => {
    // Construct a probe that throws when called — simulates a fs-layer
    // failure (EBUSY, EMFILE) inside `existsSync`. The full body is
    // wrapped in try/catch and must admit on internal error — admitting
    // beats crashing the connection, and the counter makes the bypass
    // observable so a future refactor that silently disables the defense
    // surfaces as a rate signal instead of going invisible.
    //
    // The cache-first algorithm only probes `existsSync` when there's
    // already a cache entry, so seed one for the docName under test.
    const throwingHarness = makeHarness({
      fileExists: () => {
        throw new Error('synthetic fs failure');
      },
    });
    throwingHarness.cache.setDeleted('A'); // forces the fileExists probe path
    try {
      const thrown = await throwingHarness.run('A');
      expect(thrown).toBeNull();
      const errorWarns = throwingHarness.warns.filter((w) =>
        w.includes('removal-redirect-extension-error'),
      );
      expect(errorWarns.length).toBe(1);
      expect(errorWarns[0]).toContain('"message":"synthetic fs failure"');
      expect(getMetrics().authRemovalGuardErrors).toBe(1);
    } finally {
      throwingHarness.cleanup();
    }
  });

  test('HocuspocusAuthRejection rethrow path does NOT increment the bypass counter', async () => {
    // The bypass counter is for bona-fide internal errors (admit
    // path), not for the rejection emit path. Confirms the `instanceof`
    // re-throw fires before the counter increment.
    harness.cache.setDeleted('foo');
    const thrown = await harness.run('foo');
    expect(thrown).toBeInstanceOf(HocuspocusAuthRejection);
    expect(getMetrics().authRemovalGuardErrors).toBe(0);
  });

  test('HocuspocusAuthRejection thrown by the algorithm is NOT swallowed by the catch', async () => {
    // Confirms the `instanceof HocuspocusAuthRejection` re-throw path —
    // any other error is admitted, but rejections must propagate so the
    // framework writes the PermissionDenied frame.
    harness.cache.setDeleted('foo');
    const thrown = await harness.run('foo');
    expect(thrown).toBeInstanceOf(HocuspocusAuthRejection);
  });

  // ─── Counter increments are isolated per arm ──────────────────────────────

  test('counters increment exactly once per rejection emit', async () => {
    writeFileSync(join(harness.contentDir, 'b.md'), '# b');
    harness.cache.setRenamed('a', 'b');
    harness.cache.setDeleted('c');

    await harness.run('a');
    await harness.run('c');

    expect(getMetrics().authRenameRedirectCount).toBe(1);
    expect(getMetrics().authDocDeletedCount).toBe(1);
  });

  // ─── Unsafe docName paths are admitted (path resolution returns null) ─────

  test('docName with .. fragment short-circuits as if no file (no cache hit → admit)', async () => {
    // resolveFilePath returns null on traversal-shaped names. The guard
    // treats null identically to "file does not exist" and falls through
    // to the cache lookup, which is also empty → admit.
    const thrown = await harness.run('../escape');
    expect(thrown).toBeNull();
  });
});
