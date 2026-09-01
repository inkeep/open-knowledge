import { statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { OK_PROJECT_MARKER } from '@inkeep/open-knowledge-core';

const ANCESTOR_WALK_DEPTH_LIMIT = 30;

export function isProjectRoot(dir: string): boolean {
  try {
    return statSync(resolve(dir, OK_PROJECT_MARKER)).isFile();
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return false;
    throw err;
  }
}

export interface FindEnclosingProjectRootResult {
  readonly rootPath: string;
  readonly distance: number;
}

export function findEnclosingProjectRoot(dir: string): FindEnclosingProjectRootResult | null {
  let cursor = resolve(dir);
  let distance = 0;
  while (distance < ANCESTOR_WALK_DEPTH_LIMIT) {
    let hit = false;
    try {
      hit = isProjectRoot(cursor);
    } catch {
      hit = false;
    }
    if (hit) {
      return { rootPath: cursor, distance };
    }
    const parent = dirname(cursor);
    if (parent === cursor) return null;
    cursor = parent;
    distance += 1;
  }
  return null;
}
