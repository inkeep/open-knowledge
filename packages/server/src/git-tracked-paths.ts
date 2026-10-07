import { statSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathspecArgs } from '@inkeep/open-knowledge-core';
import type { SimpleGit } from 'simple-git';
import { listNames } from './git-paths.ts';
import { isRacyStat, sampleWallClockNs, statSignature } from './stat-signature.ts';

interface IndexObservation {
  signature: string;
  racy: boolean;
}

interface LastLookup {
  indexSignature: string;
  scope: string;
  listing: ReadonlySet<string> | undefined;
}

const PRINTABLE_ASCII = /^[ -~]*$/;

const indexPaths = new Map<string, string>();
const lastLookups = new Map<string, LastLookup>();

function parentScope(relPath: string): string {
  const slash = relPath.lastIndexOf('/');
  return slash === -1 ? '' : relPath.slice(0, slash);
}

function observeIndex(indexPath: string): IndexObservation | null {
  const sampledAtNs = sampleWallClockNs();
  try {
    const stats = statSync(indexPath, { bigint: true });
    return { signature: statSignature(stats), racy: isRacyStat(stats, sampledAtNs) };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

function withAncestorDirectories(files: readonly string[]): Set<string> {
  const paths = new Set<string>();
  for (const file of files) {
    let path = file;
    while (path !== '' && !paths.has(path)) {
      paths.add(path);
      path = parentScope(path);
    }
  }
  return paths;
}

export async function isPathTrackedInGit(
  git: SimpleGit,
  projectDir: string,
  relPath: string,
): Promise<boolean> {
  const projectKey = resolve(projectDir);
  let indexPath = indexPaths.get(projectKey);
  if (indexPath === undefined) {
    indexPath = resolve(projectKey, (await git.raw('rev-parse', '--git-path', 'index')).trim());
    indexPaths.set(projectKey, indexPath);
  }
  const index = observeIndex(indexPath);
  if (index === null) {
    lastLookups.delete(projectKey);
    return false;
  }
  const scope = parentScope(relPath);
  const last = lastLookups.get(projectKey);
  const listable = !index.racy && PRINTABLE_ASCII.test(relPath);
  if (listable && last?.indexSignature === index.signature && last.scope === scope) {
    last.listing ??= withAncestorDirectories(
      await listNames(git, ['ls-files', ...(scope === '' ? [] : pathspecArgs([scope]))]),
    );
    return last.listing.has(relPath);
  }
  if (listable) {
    lastLookups.set(projectKey, { indexSignature: index.signature, scope, listing: undefined });
  }
  return (await listNames(git, ['ls-files', ...pathspecArgs([relPath])])).length > 0;
}
