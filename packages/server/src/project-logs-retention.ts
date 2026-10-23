import { lstatSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { PROJECT_DIAGNOSTIC_FILES } from '@inkeep/open-knowledge-core';
import {
  isProjectLogsKey,
  okProjectLogsDir,
  projectLogsKeyForCanonicalPath,
} from '@inkeep/open-knowledge-core/server';
import { tracedMkdirSync, tracedRmSync, tracedUtimesSync } from './fs-traced.ts';
import { getLogger } from './logger.ts';
import {
  ServerAuthorityRegistryError,
  withServerAuthorityProjectDirs,
  withServerAuthorityRegistryTransaction,
} from './server-authority.ts';

const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const PROJECT_LOG_FILES: ReadonlySet<string> = new Set(Object.values(PROJECT_DIAGNOSTIC_FILES));

function expiredNamespace(path: string, cutoff: number): boolean {
  const directory = lstatSync(path);
  if (!directory.isDirectory() || directory.isSymbolicLink() || directory.mtimeMs >= cutoff)
    return false;
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    if (!entry.isFile() || !PROJECT_LOG_FILES.has(entry.name)) return false;
    const file = lstatSync(join(path, entry.name));
    if (!file.isFile() || file.isSymbolicLink() || file.mtimeMs >= cutoff) return false;
  }
  return true;
}

function refreshNamespace(path: string): boolean {
  tracedMkdirSync(path, { recursive: true, mode: 0o700 });
  const directory = lstatSync(path);
  if (!directory.isDirectory() || directory.isSymbolicLink()) return false;
  const now = new Date();
  tracedUtimesSync(path, now, now);
  return true;
}

function pruneProjectLogs(root: string, authorityRegistryPath?: string): void {
  const directory = lstatSync(root);
  if (!directory.isDirectory() || directory.isSymbolicLink()) return;
  const cutoff = Date.now() - MAX_AGE_MS;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !isProjectLogsKey(entry.name)) continue;
    const path = join(root, entry.name);
    try {
      if (!expiredNamespace(path, cutoff)) continue;
      let verified = true;
      withServerAuthorityProjectDirs(
        (activeProjectDirs) => {
          if (activeProjectDirs === null) {
            verified = false;
            return;
          }
          for (const projectDir of activeProjectDirs) {
            if (projectLogsKeyForCanonicalPath(projectDir) === entry.name) return;
          }
          if (expiredNamespace(path, cutoff)) tracedRmSync(path, { recursive: true });
        },
        authorityRegistryPath,
        0,
      );
      if (!verified) return;
    } catch (err) {
      getLogger('project-logs-retention').warn(
        { err },
        'Inactive project diagnostic cleanup skipped',
      );
      if (err instanceof ServerAuthorityRegistryError) return;
    }
  }
}

export function prepareProjectLogsDir(
  projectDir: string,
  options: { home?: string; authorityRegistryPath?: string } = {},
): string {
  const path = okProjectLogsDir(projectDir, options.home);
  let canPrune = false;
  withServerAuthorityProjectDirs((activeProjectDirs) => {
    try {
      canPrune = refreshNamespace(path) && activeProjectDirs !== null;
    } catch (err) {
      getLogger('project-logs-retention').warn(
        { err },
        'Project diagnostic namespace could not be refreshed',
      );
    }
  }, options.authorityRegistryPath);
  if (canPrune) {
    try {
      pruneProjectLogs(dirname(path), options.authorityRegistryPath);
    } catch (err) {
      getLogger('project-logs-retention').warn(
        { err },
        'Project diagnostic cleanup could not scan namespaces',
      );
    }
  }
  return path;
}

export async function prepareSpawnProjectLogsDir(
  projectDir: string,
  options: { home?: string; authorityRegistryPath?: string } = {},
): Promise<string> {
  const path = okProjectLogsDir(projectDir, options.home);
  const deadline = Date.now() + 5_000;
  for (;;) {
    try {
      withServerAuthorityRegistryTransaction(
        () => {
          refreshNamespace(path);
        },
        options.authorityRegistryPath,
        0,
      );
      return path;
    } catch (err) {
      if (
        !(err instanceof ServerAuthorityRegistryError) ||
        err.kind !== 'contention' ||
        Date.now() >= deadline
      )
        throw err;
      await delay(25);
    }
  }
}
