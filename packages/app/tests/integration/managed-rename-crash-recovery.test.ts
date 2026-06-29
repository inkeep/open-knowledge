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

    const preRenameArticlesA = '# Articles A\n\nBody of A.\n';
    const preRenameArticlesB = '# Articles B\n\nBody of B.\n';
    const preRenameArticlesC = '# Articles C\n\nBody of C.\n';
    const preRenameDocsIndex = '# Index\n\nLink: [[articles/a]]\n';

    mkdirSync(join(contentDir, 'articles'), { recursive: true });
    mkdirSync(join(contentDir, 'docs'), { recursive: true });

    mkdirSync(join(contentDir, 'essays', 'category'), { recursive: true });
    writeFileSync(join(contentDir, 'essays', 'category', 'a.md'), preRenameArticlesA, 'utf-8');
    writeFileSync(join(contentDir, 'essays', 'category', 'b.md'), preRenameArticlesB, 'utf-8');
    writeFileSync(join(contentDir, 'essays', 'category', 'c.md'), preRenameArticlesC, 'utf-8');
    writeFileSync(
      join(contentDir, 'docs', 'index.md'),
      '# Index\n\nLink: [[essays/category/a]]\n',
      'utf-8',
    );

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
        { docName: 'docs/index', content: preRenameDocsIndex },
      ],
    });
    mkdirSync(join(contentDir, '.ok'), { recursive: true });
    writeManagedRenameJournal(contentDir, journal);

    expect(existsSync(managedRenameJournalPath(contentDir))).toBe(true);
    expect(existsSync(join(contentDir, 'essays', 'category', 'a.md'))).toBe(true);
    expect(existsSync(join(contentDir, 'articles', 'a.md'))).toBe(false);

    const server = await createRestartableServer({
      contentDir,
    });
    cleanups.push(() => server.shutdown());

    expect(readFileSync(join(contentDir, 'articles', 'a.md'), 'utf-8')).toBe(preRenameArticlesA);
    expect(readFileSync(join(contentDir, 'articles', 'b.md'), 'utf-8')).toBe(preRenameArticlesB);
    expect(readFileSync(join(contentDir, 'articles', 'c.md'), 'utf-8')).toBe(preRenameArticlesC);
    expect(readFileSync(join(contentDir, 'docs', 'index.md'), 'utf-8')).toBe(preRenameDocsIndex);
    expect(existsSync(join(contentDir, 'essays', 'category', 'a.md'))).toBe(false);
    expect(existsSync(join(contentDir, 'essays', 'category', 'b.md'))).toBe(false);
    expect(existsSync(join(contentDir, 'essays', 'category', 'c.md'))).toBe(false);
    expect(existsSync(join(contentDir, 'essays', 'category'))).toBe(false);
    expect(existsSync(join(contentDir, 'essays'))).toBe(false);
    expect(existsSync(managedRenameJournalPath(contentDir))).toBe(false);

  }, 30_000);

  test('subsequent rename attempt on the same source succeeds after recovery', async () => {
    const contentDir = mkdtempSync(join(tmpdir(), 'ok-crash-retry-'));
    cleanups.push(() => rmSync(contentDir, { recursive: true, force: true }));

    mkdirSync(join(contentDir, 'articles'), { recursive: true });
    writeFileSync(join(contentDir, 'articles', 'a.md'), '# A\n', 'utf-8');

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

    expect(existsSync(join(contentDir, 'articles', 'a.md'))).toBe(true);
    expect(existsSync(join(contentDir, 'essays', 'a.md'))).toBe(false);
    expect(existsSync(managedRenameJournalPath(contentDir))).toBe(false);

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

    expect(existsSync(join(contentDir, 'essays', 'a.md'))).toBe(true);
    expect(existsSync(join(contentDir, 'articles', 'a.md'))).toBe(false);
    expect(existsSync(managedRenameJournalPath(contentDir))).toBe(false);
  }, 30_000);
});
