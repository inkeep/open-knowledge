import type { Dirent } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { getLogger } from './desktop-logger.ts';

const CHUNK_YIELD_EVERY = 1000;

export type TraversalEntry = Pick<Dirent, 'name' | 'isDirectory' | 'isSymbolicLink'>;

function isTraversableDirent(entry: TraversalEntry): boolean {
  return entry.isDirectory() || entry.isSymbolicLink();
}

function isDirectoryDirent(entry: TraversalEntry): boolean {
  return entry.isDirectory();
}

export async function walkExceedsCap(
  root: string,
  cap: number,
  options: {
    readonly descendSymlinks: boolean;
    readonly readdirImpl?: (path: string) => Promise<readonly TraversalEntry[]>;
    readonly chunkYieldEvery?: number;
  },
): Promise<boolean> {
  const shouldDescend = options.descendSymlinks ? isTraversableDirent : isDirectoryDirent;
  const readdirImpl = options.readdirImpl ?? ((p: string) => readdir(p, { withFileTypes: true }));
  const chunkYieldEvery = options.chunkYieldEvery ?? CHUNK_YIELD_EVERY;
  let count = 0;
  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    if (dir === undefined) break;
    let entries: readonly TraversalEntry[];
    try {
      entries = await readdirImpl(dir);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EMFILE' || code === 'ENFILE') return true;
      continue;
    }
    for (const entry of entries) {
      count += 1;
      if (count > cap) return true;
      if (count % chunkYieldEvery === 0) {
        await new Promise<void>((r) => setImmediate(r));
      }
      if (shouldDescend(entry)) {
        if (entry.name === 'node_modules' || entry.name === '.git') continue;
        stack.push(join(dir, entry.name));
      }
    }
  }
  return false;
}

export function createBootBudgetDirSizeProbe(
  cap: number,
): (dir: string) => Promise<{ readonly exceedsCap: boolean }> {
  return async (dir) => {
    try {
      return { exceedsCap: await walkExceedsCap(dir, cap, { descendSymlinks: false }) };
    } catch (err) {
      getLogger('project').warn(
        { err },
        'project admission size probe failed, treating as over cap',
      );
      return { exceedsCap: true };
    }
  };
}
