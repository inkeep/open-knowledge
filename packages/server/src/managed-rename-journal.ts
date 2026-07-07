import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { getLocalDir } from './config/paths.ts';
import {
  tracedMkdirSync,
  tracedRenameSync,
  tracedRmdirSync,
  tracedRmSync,
  tracedWriteFileSync,
} from './fs-traced.ts';
import { safeContentPath } from './persistence.ts';

const MANAGED_RENAME_JOURNAL_FILENAME = 'managed-rename.json';

export interface ManagedRenameSnapshot {
  docName: string;
  content: string;
}

export interface ManagedRenamePathSnapshot {
  path: string;
  content: string;
}

interface ManagedRenameAffectedDoc {
  from: string;
  to: string;
}

/**
 * V1 schema (legacy) — single-doc rename. Kept for back-compat reading at
 * startup. New journals are written as V2.
 */
interface ManagedRenameRecoveryJournalV1 {
  version: 1;
  sourceDocName: string;
  destinationDocName: string;
  createdAt: string;
  snapshots: ManagedRenameSnapshot[];
}

/**
 * V2 schema — multi-doc rename. `affectedDocs[]` drives recovery's destination
 * cleanup; `fromPath` / `toPath` are observability-only (logs + dashboards).
 */
interface ManagedRenameRecoveryJournalV2 {
  version: 2;
  fromPath: string;
  toPath: string;
  affectedDocs: ManagedRenameAffectedDoc[];
  createdAt: string;
  snapshots: ManagedRenameSnapshot[];
  pathSnapshots?: ManagedRenamePathSnapshot[];
  cleanupPaths?: string[];
}

type ManagedRenameRecoveryJournal = ManagedRenameRecoveryJournalV1 | ManagedRenameRecoveryJournalV2;

interface ManagedRenameRecoveryResult {
  recovered: boolean;
  journal: ManagedRenameRecoveryJournal | null;
  restoredDocNames: string[];
}

type MaybePromise<T> = T | Promise<T>;

function journalDir(projectDir: string): string {
  return getLocalDir(projectDir);
}

/**
 * Absolute path to the managed-rename recovery journal at
 * `<projectDir>/.ok/local/managed-rename.json`.
 *
 * The journal is per-project runtime state (cross-machine ignore, per-machine
 * recovery target), so it lives at the project root rather than inside a
 * content sub-folder configured via `content.dir`.
 */
export function managedRenameJournalPath(projectDir: string): string {
  return resolve(journalDir(projectDir), MANAGED_RENAME_JOURNAL_FILENAME);
}

export function createManagedRenameRecoveryJournal(args: {
  fromPath: string;
  toPath: string;
  affectedDocs: ManagedRenameAffectedDoc[];
  snapshots: ManagedRenameSnapshot[];
  pathSnapshots?: ManagedRenamePathSnapshot[];
  cleanupPaths?: string[];
  createdAt?: string;
}): ManagedRenameRecoveryJournalV2 {
  const journal: ManagedRenameRecoveryJournalV2 = {
    version: 2,
    fromPath: args.fromPath,
    toPath: args.toPath,
    affectedDocs: args.affectedDocs,
    createdAt: args.createdAt ?? new Date().toISOString(),
    snapshots: args.snapshots,
  };
  if (args.pathSnapshots && args.pathSnapshots.length > 0) {
    journal.pathSnapshots = args.pathSnapshots;
  }
  if (args.cleanupPaths && args.cleanupPaths.length > 0) {
    journal.cleanupPaths = args.cleanupPaths;
  }
  return journal;
}

function isManagedRenameSnapshot(value: unknown): value is ManagedRenameSnapshot {
  if (!value || typeof value !== 'object') return false;
  const snapshot = value as Partial<ManagedRenameSnapshot>;
  return typeof snapshot.docName === 'string' && typeof snapshot.content === 'string';
}

function isManagedRenamePathSnapshot(value: unknown): value is ManagedRenamePathSnapshot {
  if (!value || typeof value !== 'object') return false;
  const snapshot = value as Partial<ManagedRenamePathSnapshot>;
  return typeof snapshot.path === 'string' && typeof snapshot.content === 'string';
}

function isManagedRenameCleanupPath(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isManagedRenameAffectedDoc(value: unknown): value is ManagedRenameAffectedDoc {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Partial<ManagedRenameAffectedDoc>;
  return typeof entry.from === 'string' && typeof entry.to === 'string';
}

function parseV2(value: Record<string, unknown>): ManagedRenameRecoveryJournalV2 {
  if (typeof value.fromPath !== 'string' || value.fromPath.length === 0) {
    throw new Error('Managed rename journal v2 is missing fromPath');
  }
  if (typeof value.toPath !== 'string' || value.toPath.length === 0) {
    throw new Error('Managed rename journal v2 is missing toPath');
  }
  if (typeof value.createdAt !== 'string' || value.createdAt.length === 0) {
    throw new Error('Managed rename journal v2 is missing createdAt');
  }
  const affectedDocs = value.affectedDocs;
  const rawPathSnapshots = value.pathSnapshots;
  const rawCleanupPaths = value.cleanupPaths;
  const hasPathSnapshots = Array.isArray(rawPathSnapshots) && rawPathSnapshots.length > 0;
  const hasCleanupPaths = Array.isArray(rawCleanupPaths) && rawCleanupPaths.length > 0;
  if (!Array.isArray(affectedDocs) || !affectedDocs.every(isManagedRenameAffectedDoc)) {
    throw new Error('Managed rename journal v2 has invalid affectedDocs');
  }
  if (affectedDocs.length === 0 && !hasPathSnapshots && !hasCleanupPaths) {
    throw new Error('Managed rename journal v2 has invalid affectedDocs');
  }
  if (
    !Array.isArray(value.snapshots) ||
    (affectedDocs.length > 0 && value.snapshots.length === 0) ||
    !value.snapshots.every(isManagedRenameSnapshot)
  ) {
    throw new Error('Managed rename journal v2 has invalid snapshots');
  }
  if (rawPathSnapshots !== undefined) {
    if (!Array.isArray(rawPathSnapshots) || !rawPathSnapshots.every(isManagedRenamePathSnapshot)) {
      throw new Error('Managed rename journal v2 has invalid pathSnapshots');
    }
  }
  if (rawCleanupPaths !== undefined) {
    if (!Array.isArray(rawCleanupPaths) || !rawCleanupPaths.every(isManagedRenameCleanupPath)) {
      throw new Error('Managed rename journal v2 has invalid cleanupPaths');
    }
  }
  for (const entry of affectedDocs as ManagedRenameAffectedDoc[]) {
    if (
      !(value.snapshots as ManagedRenameSnapshot[]).some(
        (snapshot) => snapshot.docName === entry.from,
      )
    ) {
      throw new Error(
        `Managed rename journal v2 is missing snapshot for affected doc: ${entry.from}`,
      );
    }
  }
  return {
    version: 2,
    fromPath: value.fromPath,
    toPath: value.toPath,
    affectedDocs: affectedDocs as ManagedRenameAffectedDoc[],
    createdAt: value.createdAt,
    snapshots: value.snapshots as ManagedRenameSnapshot[],
    ...(hasPathSnapshots ? { pathSnapshots: rawPathSnapshots as ManagedRenamePathSnapshot[] } : {}),
    ...(hasCleanupPaths ? { cleanupPaths: rawCleanupPaths as string[] } : {}),
  };
}

function parseV1(value: Record<string, unknown>): ManagedRenameRecoveryJournalV1 {
  if (typeof value.sourceDocName !== 'string' || value.sourceDocName.length === 0) {
    throw new Error('Managed rename journal v1 is missing sourceDocName');
  }
  if (typeof value.destinationDocName !== 'string' || value.destinationDocName.length === 0) {
    throw new Error('Managed rename journal v1 is missing destinationDocName');
  }
  if (typeof value.createdAt !== 'string' || value.createdAt.length === 0) {
    throw new Error('Managed rename journal v1 is missing createdAt');
  }
  if (
    !Array.isArray(value.snapshots) ||
    value.snapshots.length === 0 ||
    !value.snapshots.every(isManagedRenameSnapshot)
  ) {
    throw new Error('Managed rename journal v1 has invalid snapshots');
  }
  if (
    !(value.snapshots as ManagedRenameSnapshot[]).some(
      (snapshot) => snapshot.docName === value.sourceDocName,
    )
  ) {
    throw new Error('Managed rename journal v1 must include the source document snapshot');
  }
  return {
    version: 1,
    sourceDocName: value.sourceDocName,
    destinationDocName: value.destinationDocName,
    createdAt: value.createdAt,
    snapshots: value.snapshots as ManagedRenameSnapshot[],
  };
}

function parseManagedRenameRecoveryJournal(value: unknown): ManagedRenameRecoveryJournal {
  if (!value || typeof value !== 'object') {
    throw new Error('Managed rename journal must be an object');
  }
  const journal = value as Record<string, unknown>;
  if (journal.version === 2) return parseV2(journal);
  if (journal.version === 1) return parseV1(journal);
  throw new Error(`Unsupported managed rename journal version: ${String(journal.version)}`);
}

export function readManagedRenameJournal(projectDir: string): ManagedRenameRecoveryJournal | null {
  const path = managedRenameJournalPath(projectDir);
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, 'utf-8');
    return parseManagedRenameRecoveryJournal(JSON.parse(raw) as unknown);
  } catch (err) {
    throw new Error(
      `Managed rename journal at ${path} is corrupt: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export function writeManagedRenameJournal(
  projectDir: string,
  journal: ManagedRenameRecoveryJournalV2,
): void {
  const path = managedRenameJournalPath(projectDir);
  tracedMkdirSync(dirname(path), { recursive: true });
  const tempPath = `${path}.tmp`;
  tracedWriteFileSync(tempPath, JSON.stringify(journal, null, 2), 'utf-8');
  tracedRenameSync(tempPath, path);
}

function clearManagedRenameJournal(projectDir: string): void {
  tracedRmSync(managedRenameJournalPath(projectDir), { force: true });
}

/**
 * Persist the pre-rename recovery journal, run the managed rename operation,
 * then clear the journal only if the operation completes successfully.
 *
 * If the operation throws, the journal remains on disk so the next server
 * startup can restore the pre-rename state. Do not wrap this in `try/finally`
 * or the crash-recovery guarantee is lost.
 *
 * `projectDir` locates the journal under `<projectDir>/.ok/local/`. Callers
 * that pass `contentDir` keep working when `projectDir === contentDir`;
 * when they differ, `projectDir` is the load-bearing one.
 */
export async function withManagedRenameRecovery<T>(
  projectDir: string,
  journal: ManagedRenameRecoveryJournalV2,
  operation: () => MaybePromise<T>,
): Promise<T> {
  writeManagedRenameJournal(projectDir, journal);
  const result = await operation();
  clearManagedRenameJournal(projectDir);
  return result;
}

function destinationsToCleanV1(journal: ManagedRenameRecoveryJournalV1): string[] {
  return [journal.destinationDocName];
}

function destinationsToCleanV2(journal: ManagedRenameRecoveryJournalV2): string[] {
  return journal.affectedDocs.map((entry) => entry.to);
}

function resolveRecoveryPath(contentDir: string, relativePath: string): string {
  const root = resolve(contentDir);
  const filePath = resolve(root, relativePath);
  if (relativePath.includes('\x00') || filePath === root || !filePath.startsWith(`${root}${sep}`)) {
    throw new Error(`Invalid recovery path: ${relativePath}`);
  }
  return filePath;
}

function pruneEmptyAncestors(filePath: string, contentDir: string): void {
  const root = resolve(contentDir);
  const boundary = `${root}${sep}`;
  let cur = dirname(filePath);
  while (cur.startsWith(boundary) && cur !== root) {
    let entries: string[];
    try {
      entries = readdirSync(cur);
    } catch (err) {
      console.warn(`[managed-rename] pruneEmptyAncestors: cannot read ${cur}:`, err);
      return;
    }
    if (entries.length > 0) return;
    try {
      tracedRmdirSync(cur);
    } catch (err) {
      console.warn(`[managed-rename] pruneEmptyAncestors: cannot rmdir ${cur}:`, err);
      return;
    }
    cur = dirname(cur);
  }
}

export function recoverPendingManagedRename(
  contentDir: string,
  projectDir: string = contentDir,
): ManagedRenameRecoveryResult {
  const journal = readManagedRenameJournal(projectDir);
  if (!journal) {
    return { recovered: false, journal: null, restoredDocNames: [] };
  }

  const restoredDocNames = new Set<string>();
  const restoredPaths = new Set<string>();
  const restoreFailures: Array<{ docName: string; cause: unknown }> = [];
  for (const snapshot of journal.snapshots) {
    try {
      const filePath = safeContentPath(snapshot.docName, contentDir);
      tracedMkdirSync(dirname(filePath), { recursive: true });
      tracedWriteFileSync(filePath, snapshot.content, 'utf-8');
      restoredDocNames.add(snapshot.docName);
    } catch (err) {
      restoreFailures.push({ docName: snapshot.docName, cause: err });
      console.warn(`[managed-rename] Failed to restore ${snapshot.docName}:`, err);
    }
  }

  if (restoreFailures.length > 0) {
    const failedNames = restoreFailures.map((f) => f.docName).join(', ');
    console.warn(
      `[managed-rename] Recovery incomplete; keeping journal for retry (${failedNames})`,
    );
    const causes = restoreFailures.map((f) =>
      f.cause instanceof Error ? f.cause : new Error(String(f.cause)),
    );
    throw new AggregateError(
      causes,
      `Managed rename recovery incomplete; failed to restore: ${failedNames}`,
    );
  }

  if (journal.version === 2) {
    const pathRestoreFailures: Array<{ path: string; cause: unknown }> = [];
    for (const snapshot of journal.pathSnapshots ?? []) {
      try {
        const filePath = resolveRecoveryPath(contentDir, snapshot.path);
        tracedMkdirSync(dirname(filePath), { recursive: true });
        tracedWriteFileSync(filePath, snapshot.content, 'utf-8');
        restoredPaths.add(snapshot.path);
      } catch (err) {
        pathRestoreFailures.push({ path: snapshot.path, cause: err });
        console.warn(`[managed-rename] Failed to restore path ${snapshot.path}:`, err);
      }
    }

    if (pathRestoreFailures.length > 0) {
      const failedPaths = pathRestoreFailures.map((f) => f.path).join(', ');
      console.warn(
        `[managed-rename] Recovery incomplete; keeping journal for retry (${failedPaths})`,
      );
      const causes = pathRestoreFailures.map((f) =>
        f.cause instanceof Error ? f.cause : new Error(String(f.cause)),
      );
      throw new AggregateError(
        causes,
        `Managed rename recovery incomplete; failed to restore paths: ${failedPaths}`,
      );
    }
  }

  const destinationsToClean =
    journal.version === 2 ? destinationsToCleanV2(journal) : destinationsToCleanV1(journal);
  const cleanupFailures: Array<{ destination: string; cause: unknown }> = [];
  for (const destination of destinationsToClean) {
    if (restoredDocNames.has(destination)) continue;
    const destinationPath = safeContentPath(destination, contentDir);
    try {
      tracedRmSync(destinationPath, { force: true });
      pruneEmptyAncestors(destinationPath, contentDir);
    } catch (err) {
      if (existsSync(destinationPath)) {
        console.warn(
          `[managed-rename] Both source and destination files exist after partial recovery for ${destination}`,
        );
      }
      console.warn(
        `[managed-rename] Recovery incomplete; failed to clean destination ${destination}:`,
        err,
      );
      cleanupFailures.push({ destination, cause: err });
    }
  }

  if (journal.version === 2) {
    for (const destination of journal.cleanupPaths ?? []) {
      if (restoredPaths.has(destination)) continue;
      let destinationPath: string | null = null;
      try {
        destinationPath = resolveRecoveryPath(contentDir, destination);
        tracedRmSync(destinationPath, { force: true });
        pruneEmptyAncestors(destinationPath, contentDir);
      } catch (err) {
        if (destinationPath && existsSync(destinationPath)) {
          console.warn(
            `[managed-rename] Both source and destination paths exist after partial recovery for ${destination}`,
          );
        }
        console.warn(
          `[managed-rename] Recovery incomplete; failed to clean destination path ${destination}:`,
          err,
        );
        cleanupFailures.push({ destination, cause: err });
      }
    }
  }

  if (cleanupFailures.length > 0) {
    const failedNames = cleanupFailures.map((f) => f.destination).join(', ');
    const causes = cleanupFailures.map((f) =>
      f.cause instanceof Error ? f.cause : new Error(String(f.cause)),
    );
    throw new AggregateError(
      causes,
      `Managed rename recovery incomplete; failed to clean destinations: ${failedNames}`,
    );
  }

  clearManagedRenameJournal(projectDir);

  return {
    recovered: true,
    journal,
    restoredDocNames: [...restoredDocNames].sort((a, b) => a.localeCompare(b)),
  };
}
