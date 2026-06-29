import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { HocuspocusAuthRejection } from './auth-token-schema.ts';
import { getMetrics, resetMetrics } from './metrics.ts';
import { RecentlyRemovedDocs } from './recently-removed-docs.ts';
import { runRemovalRedirectGuard } from './removal-redirect-guard.ts';

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
      } catch {}
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

  test('system docs short-circuit at entry (no cache lookup, no redirect)', async () => {
    harness.cache.setDeleted('__system__');
    const thrown = await harness.run('__system__');
    expect(thrown).toBeNull();
    expect(getMetrics().authDocDeletedCount).toBe(0);
  });

  test('config docs short-circuit at entry', async () => {
    const thrown = await harness.run('__config__/project');
    expect(thrown).toBeNull();
  });

  test('recreation collision (G5) admits — cache invalidated by create-page upstream', async () => {
    writeFileSync(join(harness.contentDir, 'foo.md'), '# foo');
    harness.cache.setRenamed('foo', 'bar');
    harness.cache.delete('foo'); // simulates /api/create-page / watcher 'add'
    expect(harness.cache.has('foo')).toBe(false);

    const thrown = await harness.run('foo');
    expect(thrown).toBeNull();
  });

  test('G5 defense-in-depth: deleted entry + file present → guard drops stale entry and admits', async () => {
    writeFileSync(join(harness.contentDir, 'foo.md'), '# recreated');
    harness.cache.setDeleted('foo');

    const thrown = await harness.run('foo');
    expect(thrown).toBeNull();
    expect(harness.cache.has('foo')).toBe(false);
    expect(getMetrics().authDocDeletedCount).toBe(0);
  });

  test('cache-claim authority: stale renamed entry + present file → redirect (failed-rename rollback)', async () => {
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

  test('multi-hop chain walk terminates at file-exists target', async () => {
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
    harness.cache.setRenamed('A', 'B');
    harness.cache.setDeleted('B');

    const thrown = await harness.run('A');
    expect(thrown).toBeInstanceOf(HocuspocusAuthRejection);
    const rej = thrown as HocuspocusAuthRejection;
    expect(rej.kind).toBe('doc-deleted');
    expect(getMetrics().authDocDeletedCount).toBe(1);
  });

  test('chain walk lands on a deleted entry whose file was recreated → redirect to terminal, drop stale entry', async () => {
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
    harness.cache.setRenamed('A', 'B');
    const thrown = await harness.run('A');
    expect(thrown).toBeInstanceOf(HocuspocusAuthRejection);
    expect((thrown as HocuspocusAuthRejection).kind).toBe('rename-redirect');
    expect((thrown as HocuspocusAuthRejection).payload).toBe('B');
  });

  test('pathological cycle (A → B → A) admits with structured warn (no infinite loop)', async () => {
    harness.cache.setRenamed('A', 'B');
    harness.cache.setRenamed('B', 'A');

    const thrown = await harness.run('A');
    expect(thrown).toBeNull();
    const cycleWarns = harness.warns.filter((w) => w.includes('removal-redirect-chain-cycle'));
    expect(cycleWarns.length).toBe(1);
    expect(cycleWarns[0]).toContain('"documentName":"A"');
    expect(getMetrics().removalRedirectChainCycles).toBe(1);
  });

  test('internal error from cache lookup falls through to admit + structured warn + counter', async () => {
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
    harness.cache.setDeleted('foo');
    const thrown = await harness.run('foo');
    expect(thrown).toBeInstanceOf(HocuspocusAuthRejection);
    expect(getMetrics().authRemovalGuardErrors).toBe(0);
  });

  test('HocuspocusAuthRejection thrown by the algorithm is NOT swallowed by the catch', async () => {
    harness.cache.setDeleted('foo');
    const thrown = await harness.run('foo');
    expect(thrown).toBeInstanceOf(HocuspocusAuthRejection);
  });

  test('counters increment exactly once per rejection emit', async () => {
    writeFileSync(join(harness.contentDir, 'b.md'), '# b');
    harness.cache.setRenamed('a', 'b');
    harness.cache.setDeleted('c');

    await harness.run('a');
    await harness.run('c');

    expect(getMetrics().authRenameRedirectCount).toBe(1);
    expect(getMetrics().authDocDeletedCount).toBe(1);
  });

  test('docName with .. fragment short-circuits as if no file (no cache hit → admit)', async () => {
    const thrown = await harness.run('../escape');
    expect(thrown).toBeNull();
  });
});
