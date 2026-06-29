import type { Dirent } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { OK_DIR } from '@inkeep/open-knowledge-core';

const SCAN_CAP = 1000;

const SKIP_DIRS: ReadonlySet<string> = new Set([
  '.git',
  OK_DIR,
  'node_modules',
  '.changeset',
  '.claude',
  '.agents',
  'dist',
  'build',
]);

type MtimeSnapshot = Map<string, number>;

export async function snapshotMtimes(
  projectDir: string,
): Promise<{ snapshot: MtimeSnapshot; truncated: boolean }> {
  const root = resolve(projectDir);
  const snapshot: MtimeSnapshot = new Map();
  let count = 0;
  let truncated = false;

  async function walk(dir: string): Promise<void> {
    if (truncated) return;
    let entries: Dirent[];
    try {
      entries = (await readdir(dir, { withFileTypes: true })) as Dirent[];
    } catch {
      return;
    }
    for (const entry of entries) {
      if (truncated) return;
      if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) continue;
      const full = resolve(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      if (count >= SCAN_CAP) {
        truncated = true;
        return;
      }
      try {
        const s = await stat(full);
        snapshot.set(relative(root, full), s.mtimeMs);
        count++;
      } catch {
      }
    }
  }

  await walk(root);
  return { snapshot, truncated };
}

interface MtimeDiff {
  changed: string[];
}

export function diffMtimes(before: MtimeSnapshot, after: MtimeSnapshot): MtimeDiff {
  const changed: string[] = [];
  for (const [path, mtime] of after) {
    const prev = before.get(path);
    if (prev === undefined || prev !== mtime) {
      changed.push(path);
    }
  }
  for (const [path] of before) {
    if (!after.has(path)) changed.push(path);
  }
  return { changed };
}
