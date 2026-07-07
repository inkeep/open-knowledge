/**
 * Crash mid-folder-rename recovery (full lifecycle).
 *
 * The unit harness in managed-rename-journal.test.ts writes a v2 journal by
 * hand and asserts recoverPendingManagedRename behaves correctly in
 * isolation. It does NOT exercise the boot-time path: createServer →
 * initAsync → recoverPendingManagedRename → server is ready with on-disk
 * state restored.
 *
 * This test scripts that full lifecycle:
 *   1. Boot serverA, write a folder + backlink-source docs to disk.
 *   2. Stage a "mid-rename" disk state — simulate a crash that landed AFTER
 *      writing the journal + dest files but BEFORE removing the source files.
 *      (We cannot intercept the real rename mid-flight from the test process,
 *      but we can construct the equivalent on-disk state plus a v2 journal
 *      pointing at the pre-rename snapshots.)
 *   3. Tear down serverA.
 *   4. Boot serverB on the same contentDir; serverB.ready triggers
 *      recoverPendingManagedRename via initAsync.
 *   5. Assert: source docs restored, dest docs removed, empty ancestor dirs
 *      pruned, journal cleared, sibling-source backlinks unchanged.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createManagedRenameRecoveryJournal,
  managedRenameJournalPath,
  writeManagedRenameJournal,
} from '../../../server/src/managed-rename-journal';
import { createRestartableServer } from './test-harness';

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.();
  }
});

describe('Managed rename — crash recovery via boot-time initAsync (QA-006)', () => {
  test('mid-folder-rename crash → restart restores pre-rename state and prunes empty ancestor dirs', async () => {
    const contentDir = mkdtempSync(join(tmpdir(), 'ok-crash-recovery-'));
    cleanups.push(() => rmSync(contentDir, { recursive: true, force: true }));

    // Pre-rename state: folder articles/ contains 3 docs; folder docs/ has a
    // backlink to articles/a.
    const preRenameArticlesA = '# Articles A\n\nBody of A.\n';
    const preRenameArticlesB = '# Articles B\n\nBody of B.\n';
    const preRenameArticlesC = '# Articles C\n\nBody of C.\n';
    const preRenameDocsIndex = '# Index\n\nLink: [[articles/a]]\n';

    mkdirSync(join(contentDir, 'articles'), { recursive: true });
    mkdirSync(join(contentDir, 'docs'), { recursive: true });

    // Stage the "mid-rename" disk state — destination files exist, source
    // files DO NOT (the mv completed but the journal-clear step never fired).
    // The empty ancestor essays/category/ should be pruned by recovery.
    mkdirSync(join(contentDir, 'essays', 'category'), { recursive: true });
    writeFileSync(join(contentDir, 'essays', 'category', 'a.md'), preRenameArticlesA, 'utf-8');
    writeFileSync(join(contentDir, 'essays', 'category', 'b.md'), preRenameArticlesB, 'utf-8');
    writeFileSync(join(contentDir, 'essays', 'category', 'c.md'), preRenameArticlesC, 'utf-8');
    // The backlink-source doc has the post-rewrite link (since the rewrite
    // landed before the crash). Recovery restores it from the journal snapshot
    // back to the pre-rewrite [[articles/a]] form.
    writeFileSync(
      join(contentDir, 'docs', 'index.md'),
      '# Index\n\nLink: [[essays/category/a]]\n',
      'utf-8',
    );

    // Write the journal that the in-flight rename would have persisted before
    // any disk mutation.
    const journal = createManagedRenameRecoveryJournal({
      fromPath: 'articles',
      toPath: 'essays/category',
      affectedDocs: [
        { from: 'articles/a', to: 'essays/category/a' },
        { from: 'articles/b', to: 'essays/category/b' },
        { from: 'articles/c', to: 'essays/category/c' },
      ],
      snapshots: [
        { docName: 'articles/a', content: preRenameArticlesA },
        { docName: 'articles/b', content: preRenameArticlesB },
        { docName: 'articles/c', content: preRenameArticlesC },
        // Backlink source — its pre-rewrite content must be restored too.
        { docName: 'docs/index', content: preRenameDocsIndex },
      ],
    });
    mkdirSync(join(contentDir, '.ok'), { recursive: true });
    writeManagedRenameJournal(contentDir, journal);

    // Sanity preconditions — the staged "mid-rename" state is what we expect.
    expect(existsSync(managedRenameJournalPath(contentDir))).toBe(true);
    expect(existsSync(join(contentDir, 'essays', 'category', 'a.md'))).toBe(true);
    expect(existsSync(join(contentDir, 'articles', 'a.md'))).toBe(false);

    // Boot a server pointed at the staged contentDir. createRestartableServer
    // → createServer → initAsync → recoverPendingManagedRename. ready resolves
    // after recovery.
    const server = await createRestartableServer({
      contentDir,
      // Don't let the cleanup wipe the contentDir — we own it via cleanups[].
    });
    cleanups.push(() => server.shutdown());

    // Recovery happens before ready resolves. Now assert the post-recovery
    // disk state matches pre-rename:
    //   - source docs restored
    expect(readFileSync(join(contentDir, 'articles', 'a.md'), 'utf-8')).toBe(preRenameArticlesA);
    expect(readFileSync(join(contentDir, 'articles', 'b.md'), 'utf-8')).toBe(preRenameArticlesB);
    expect(readFileSync(join(contentDir, 'articles', 'c.md'), 'utf-8')).toBe(preRenameArticlesC);
    //   - backlink source restored to pre-rewrite form
    expect(readFileSync(join(contentDir, 'docs', 'index.md'), 'utf-8')).toBe(preRenameDocsIndex);
    //   - destination files removed
    expect(existsSync(join(contentDir, 'essays', 'category', 'a.md'))).toBe(false);
    expect(existsSync(join(contentDir, 'essays', 'category', 'b.md'))).toBe(false);
    expect(existsSync(join(contentDir, 'essays', 'category', 'c.md'))).toBe(false);
    //   - empty ancestor directories pruned (the directories are now empty
    //     after recovery removed their files; pruneEmptyAncestors should
    //     have removed both `essays/category/` and `essays/`)
    expect(existsSync(join(contentDir, 'essays', 'category'))).toBe(false);
    expect(existsSync(join(contentDir, 'essays'))).toBe(false);
    //   - journal cleared
    expect(existsSync(managedRenameJournalPath(contentDir))).toBe(false);

    // The server boots ready (no degraded subsystems specific to recovery
    // — ready resolved without throwing).
  }, 30_000);

  test('subsequent rename attempt on the same source succeeds after recovery', async () => {
    // Sequencing test: after recovery puts the disk in pre-rename state, a
    // user retry must succeed. The journal is gone, the source is back, the
    // serialized critical section sees no leftover state.
    const contentDir = mkdtempSync(join(tmpdir(), 'ok-crash-retry-'));
    cleanups.push(() => rmSync(contentDir, { recursive: true, force: true }));

    mkdirSync(join(contentDir, 'articles'), { recursive: true });
    writeFileSync(join(contentDir, 'articles', 'a.md'), '# A\n', 'utf-8');

    // Stage crash + journal pointing to a single-doc folder rename.
    mkdirSync(join(contentDir, 'essays'), { recursive: true });
    writeFileSync(join(contentDir, 'essays', 'a.md'), '# A\n', 'utf-8');
    rmSync(join(contentDir, 'articles', 'a.md'));
    rmSync(join(contentDir, 'articles'), { recursive: true });
    mkdirSync(join(contentDir, 'articles'), { recursive: true });
    writeFileSync(join(contentDir, 'articles', 'a.md'), '# A\n', 'utf-8');
    rmSync(join(contentDir, 'articles', 'a.md'));
    rmSync(join(contentDir, 'articles'), { recursive: true });

    const journal = createManagedRenameRecoveryJournal({
      fromPath: 'articles',
      toPath: 'essays',
      affectedDocs: [{ from: 'articles/a', to: 'essays/a' }],
      snapshots: [{ docName: 'articles/a', content: '# A\n' }],
    });
    mkdirSync(join(contentDir, '.ok'), { recursive: true });
    writeManagedRenameJournal(contentDir, journal);

    const server = await createRestartableServer({ contentDir });
    cleanups.push(() => server.shutdown());

    // Recovery happened. Source restored, dest removed.
    expect(existsSync(join(contentDir, 'articles', 'a.md'))).toBe(true);
    expect(existsSync(join(contentDir, 'essays', 'a.md'))).toBe(false);
    expect(existsSync(managedRenameJournalPath(contentDir))).toBe(false);

    // Retry the rename — it must succeed now that on-disk state is clean.
    const res = await fetch(`http://127.0.0.1:${server.port}/api/rename-path`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'folder', fromPath: 'articles', toPath: 'essays' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      renamed: Array<{ fromDocName: string; toDocName: string }>;
    };
    expect(body.renamed.length).toBeGreaterThan(0);

    // Post-retry state.
    expect(existsSync(join(contentDir, 'essays', 'a.md'))).toBe(true);
    expect(existsSync(join(contentDir, 'articles', 'a.md'))).toBe(false);
    expect(existsSync(managedRenameJournalPath(contentDir))).toBe(false);
  }, 30_000);
});
