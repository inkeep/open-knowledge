import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { getLocalDir } from './config/paths.ts';
import { tracedMkdirSync, tracedRenameSync, tracedWriteFileSync } from './fs-traced.ts';
import { getLogger } from './logger.ts';
import type { RemovalEntry } from './recently-removed-docs.ts';

const log = getLogger('removed-docs-journal');

const REMOVED_DOCS_JOURNAL_FILENAME = 'removed-docs.json';

interface RemovedDocsJournalV1 {
  version: 1;
  entries: Array<{ docName: string } & RemovalEntry>;
}

export function removedDocsJournalPath(projectDir: string): string {
  return join(getLocalDir(projectDir), REMOVED_DOCS_JOURNAL_FILENAME);
}

function isJournalEntry(value: unknown): value is { docName: string } & RemovalEntry {
  if (typeof value !== 'object' || value === null) return false;
  const entry = value as Record<string, unknown>;
  if (typeof entry.docName !== 'string' || entry.docName.length === 0) return false;
  if (typeof entry.addedAt !== 'number') return false;
  if (entry.kind === 'deleted') return true;
  if (entry.kind === 'renamed') return typeof entry.newDocName === 'string';
  return false;
}

export function loadRemovedDocsJournal(projectDir: string): Array<[string, RemovalEntry]> {
  const path = removedDocsJournalPath(projectDir);
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as Partial<RemovedDocsJournalV1>;
    if (parsed.version !== 1 || !Array.isArray(parsed.entries)) {
      log.warn({ path }, '[removed-docs-journal] unrecognized journal shape — ignoring');
      return [];
    }
    const entries: Array<[string, RemovalEntry]> = [];
    for (const raw of parsed.entries) {
      if (!isJournalEntry(raw)) continue;
      const { docName, ...entry } = raw;
      entries.push([docName, entry as RemovalEntry]);
    }
    return entries;
  } catch (err) {
    log.warn({ path, err }, '[removed-docs-journal] failed to read journal — ignoring');
    return [];
  }
}

export function saveRemovedDocsJournal(
  projectDir: string,
  entries: ReadonlyArray<[string, RemovalEntry]>,
): void {
  const path = removedDocsJournalPath(projectDir);
  const journal: RemovedDocsJournalV1 = {
    version: 1,
    entries: entries.map(([docName, entry]) => ({ docName, ...entry })),
  };
  tracedMkdirSync(dirname(path), { recursive: true });
  const tmpPath = `${path}.tmp`;
  tracedWriteFileSync(tmpPath, JSON.stringify(journal), 'utf-8');
  tracedRenameSync(tmpPath, path);
}
