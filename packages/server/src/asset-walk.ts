
import type { Dirent, Stats } from 'node:fs';
import { readdirSync } from 'node:fs';
import { lstat, readdir, realpath, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import {
  ASSET_EXTENSIONS,
  type BasenameIndex,
  LINKABLE_ASSET_EXTENSIONS,
} from '@inkeep/open-knowledge-core';
import type { ContentFilter } from './content-filter.ts';
import { isSupportedAssetFile } from './doc-extensions.ts';
import { isWithinDir, toPosix } from './path-utils.ts';

type SeedSkipReason =
  | 'read-failed'
  | 'lstat-failed'
  | 'realpath-failed'
  | 'symlink-escape'
  | 'symlink-stat-failed';

interface SeedOptions {
  contentDir: string;
  contentFilter?: ContentFilter;
  basenameIndex: BasenameIndex;
  onSkip?(reason: SeedSkipReason, code: string | undefined, path: string): void;
}

function errnoCode(err: unknown): string | undefined {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  return typeof code === 'string' ? code : undefined;
}

export function seedSingleDirBasenameIndex(opts: {
  contentDir: string;
  basenameIndex: BasenameIndex;
  onSkip?(reason: SeedSkipReason, code: string | undefined, path: string): void;
}): void {
  let entries: Dirent[];
  try {
    entries = readdirSync(opts.contentDir, { withFileTypes: true }) as Dirent[];
  } catch (err) {
    const code = errnoCode(err);
    if (code !== 'ENOENT') opts.onSkip?.('read-failed', code, opts.contentDir);
    return;
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!isSupportedAssetFile(entry.name, ASSET_EXTENSIONS)) continue;
    opts.basenameIndex.add(entry.name);
  }
}

export async function seedBasenameIndex(opts: SeedOptions): Promise<void> {
  const root = opts.contentDir;
  const visited = new Set<number>();

  async function walk(dir: string): Promise<void> {
    let entries: Dirent[];
    try {
      entries = (await readdir(dir, { withFileTypes: true })) as Dirent[];
    } catch (err) {
      const code = errnoCode(err);
      if (code !== 'ENOENT') opts.onSkip?.('read-failed', code, dir);
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      const rel = toPosix(relative(root, full));
      if (rel.startsWith('..')) continue;
      if (opts.contentFilter?.isDirExcluded(rel) && entry.isDirectory()) continue;

      let entryStat: Stats;
      try {
        entryStat = await lstat(full);
      } catch (err) {
        const code = errnoCode(err);
        if (code !== 'ENOENT') opts.onSkip?.('lstat-failed', code, full);
        continue;
      }

      if (entryStat.isSymbolicLink()) {
        let canonical: string;
        try {
          canonical = await realpath(full);
        } catch (err) {
          const code = errnoCode(err);
          if (code !== 'ENOENT') opts.onSkip?.('realpath-failed', code, full);
          continue;
        }
        if (!isWithinDir(canonical, root)) {
          opts.onSkip?.('symlink-escape', undefined, full);
          continue;
        }
        let realStat: Stats;
        try {
          realStat = await stat(canonical);
        } catch (err) {
          const code = errnoCode(err);
          if (code !== 'ENOENT') opts.onSkip?.('symlink-stat-failed', code, canonical);
          continue;
        }
        if (visited.has(realStat.ino)) continue;
        visited.add(realStat.ino);
        if (realStat.isDirectory()) await walk(canonical);
        else if (
          realStat.isFile() &&
          isSupportedAssetFile(full, LINKABLE_ASSET_EXTENSIONS) &&
          !opts.contentFilter?.isExcluded(rel)
        ) {
          opts.basenameIndex.add(rel);
        }
        continue;
      }

      if (entryStat.isDirectory()) {
        if (visited.has(entryStat.ino)) continue;
        visited.add(entryStat.ino);
        await walk(full);
        continue;
      }
      if (
        entryStat.isFile() &&
        isSupportedAssetFile(full, LINKABLE_ASSET_EXTENSIONS) &&
        !opts.contentFilter?.isExcluded(rel)
      ) {
        opts.basenameIndex.add(rel);
      }
    }
  }

  await walk(root);
}
