import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const ANCESTOR_WALK_DEPTH_LIMIT = 30;

const GIT_MARKER = '.git';

export interface FindEnclosingGitRootResult {
  readonly gitRoot: string;
  readonly distance: number;
}

export function findEnclosingGitRoot(dir: string): FindEnclosingGitRootResult | null {
  let cursor = resolve(dir);
  let distance = 0;
  while (distance < ANCESTOR_WALK_DEPTH_LIMIT) {
    let hit = false;
    try {
      hit = existsSync(resolve(cursor, GIT_MARKER));
    } catch {
      hit = false;
    }
    if (hit) {
      return { gitRoot: cursor, distance };
    }
    const parent = dirname(cursor);
    if (parent === cursor) return null;
    cursor = parent;
    distance += 1;
  }
  return null;
}
