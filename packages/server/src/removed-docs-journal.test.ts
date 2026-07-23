import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { RecentlyRemovedDocs } from './recently-removed-docs.ts';
import {
  loadRemovedDocsJournal,
  removedDocsJournalPath,
  saveRemovedDocsJournal,
} from './removed-docs-journal.ts';

function makeProjectDir(): string {
  return mkdtempSync(join(tmpdir(), 'ok-removed-docs-journal-'));
}

describe('removed-docs journal — round trip', () => {
  test('save + load preserves entries, kinds, targets, timestamps, and order', () => {
    const projectDir = makeProjectDir();
    const cache = new RecentlyRemovedDocs(10, { now: () => 1111 });
    cache.setDeleted('notes/gone');
    cache.setRenamed('old-name', 'new-name');

    saveRemovedDocsJournal(projectDir, cache.entries());
    const loaded = loadRemovedDocsJournal(projectDir);

    expect(loaded).toEqual([
      ['notes/gone', { kind: 'deleted', addedAt: 1111 }],
      ['old-name', { kind: 'renamed', newDocName: 'new-name', addedAt: 1111 }],
    ]);
  });

  test('restore() re-populates a cache verbatim (addedAt preserved, unlike setDeleted)', () => {
    const projectDir = makeProjectDir();
    const original = new RecentlyRemovedDocs(10, { now: () => 2222 });
    original.setDeleted('doomed');
    saveRemovedDocsJournal(projectDir, original.entries());

    const reloaded = new RecentlyRemovedDocs(10, { now: () => 9999 });
    for (const [docName, entry] of loadRemovedDocsJournal(projectDir)) {
      reloaded.restore(docName, entry);
    }

    expect(reloaded.get('doomed')).toEqual({ kind: 'deleted', addedAt: 2222 });
  });

  test('missing journal file loads as empty', () => {
    expect(loadRemovedDocsJournal(makeProjectDir())).toEqual([]);
  });

  test('corrupt JSON loads as empty instead of throwing', () => {
    const projectDir = makeProjectDir();
    const path = removedDocsJournalPath(projectDir);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, '{not json', 'utf-8');
    expect(loadRemovedDocsJournal(projectDir)).toEqual([]);
  });

  test('unknown version or malformed entries are dropped, valid ones kept', () => {
    const projectDir = makeProjectDir();
    const path = removedDocsJournalPath(projectDir);
    mkdirSync(dirname(path), { recursive: true });

    writeFileSync(path, JSON.stringify({ version: 99, entries: [] }), 'utf-8');
    expect(loadRemovedDocsJournal(projectDir)).toEqual([]);

    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        entries: [
          { docName: 'ok-entry', kind: 'deleted', addedAt: 5 },
          { docName: '', kind: 'deleted', addedAt: 5 },
          { docName: 'no-kind', addedAt: 5 },
          { docName: 'renamed-no-target', kind: 'renamed', addedAt: 5 },
          'not-an-object',
        ],
      }),
      'utf-8',
    );
    expect(loadRemovedDocsJournal(projectDir)).toEqual([
      ['ok-entry', { kind: 'deleted', addedAt: 5 }],
    ]);
  });
});

describe('RecentlyRemovedDocs — onMutate hook (journal wiring point)', () => {
  test('fires on set, delete, and restore — not on get/has/peek/entries', () => {
    let mutations = 0;
    const cache = new RecentlyRemovedDocs(10, { onMutate: () => mutations++ });

    cache.setDeleted('a');
    expect(mutations).toBe(1);
    cache.setRenamed('b', 'c');
    expect(mutations).toBe(2);
    cache.restore('d', { kind: 'deleted', addedAt: 1 });
    expect(mutations).toBe(3);

    cache.get('a');
    cache.has('a');
    cache.peek('a');
    cache.entries();
    expect(mutations).toBe(3);

    cache.delete('a');
    expect(mutations).toBe(4);
    // Deleting a missing key changes nothing — no mutation signal.
    cache.delete('a');
    expect(mutations).toBe(4);
  });
});
