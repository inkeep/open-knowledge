/**
 * Post-exec security-invariant check.
 *
 * Before every `exec` call we snapshot `(relPath, mtimeMs)` for files in
 * `projectDir`; after the call we re-snapshot and diff. Any path whose
 * mtime changed (or that newly exists) on a read-only command indicates
 * a parser bug that let a writer through — we abort the response with
 * `security_invariant_violation`.
 *
 * This is the defense-in-depth backstop — a lean alternative to
 * subprocess isolation. Typical overhead for dirs ≤500 files is <10ms.
 *
 * Bounded at `SCAN_CAP` entries; traversal skips hidden OK directories
 * (`.git/`, `.ok/`, `node_modules/`).
 */
import type { Dirent } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { OK_DIR } from '@inkeep/open-knowledge-core';

/** Upper bound on the number of files we scan. Typical content dirs are well under 500. */
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

/**
 * Snapshot `(relPath, mtimeMs)` for files in `projectDir`. Bounded; returns
 * early at SCAN_CAP with a `truncated` flag caller can act on.
 */
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
        // ignore unreadable files
      }
    }
  }

  await walk(root);
  return { snapshot, truncated };
}

interface MtimeDiff {
  /** Paths whose mtime changed between snapshots (or appeared/disappeared). */
  changed: string[];
}

/**
 * Diff two snapshots. Any path whose mtime differs is reported.
 * Paths present only in `after` (newly created) are reported.
 * Paths present only in `before` (deleted) are reported.
 */
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
