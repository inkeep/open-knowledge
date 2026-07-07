/**
 * Project-root helpers for the create-new-project dialog cascade, the IPC
 * handler that runs the same cascade server-side, MCP `findProjectDir`, the
 * CLI's preAction project anchor (`ok start`/`stop`/`status`/`clean`/`ui`/
 * `mcp`/`preview` walk up to the enclosing project — see the CLI's
 * `project-anchor.ts`), and `planSeed`.
 *
 * The marker is `.ok/config.yml` — not just `.ok/`. Nested folder rules write
 * `.ok/frontmatter.yml` (and other sidecars) without a `config.yml`, so
 * checking `config.yml` is what distinguishes a real project root from a
 * folder that merely carries OK folder-rule metadata.
 *
 * Ancestor walks use `path.resolve` only; they intentionally do NOT call
 * `fs.realpath`. The user's mental model for "is the folder I picked inside
 * a project" is the path they picked, not the inode that path resolves to.
 * Symlink-canonicalization for content-dir file identity is a separate
 * concern (see the symlink section of the package docs).
 */

import { statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { OK_PROJECT_MARKER } from '@inkeep/open-knowledge-core';

/**
 * Maximum ancestor levels traversed before giving up. Realistic project
 * depths are <10; the cap is defensive against pathological inputs.
 * Matches `ANCESTOR_WALK_DEPTH_LIMIT` in `folder-admission.ts`.
 */
const ANCESTOR_WALK_DEPTH_LIMIT = 30;

/**
 * Single source of truth for "is `<dir>` a valid OK project root?" — used by
 * `findEnclosingProjectRoot`, MCP `findProjectDir`, CLI `ok start`, and
 * `planSeed`. Returns `true` iff `<dir>/.ok/config.yml` exists as a regular
 * file.
 *
 * The strict file check (vs plain `existsSync`) rejects pathological inputs:
 * a directory at `.ok/config.yml`, a dangling symlink, a regular file named
 * `.ok` blocking descent — all return `false` so callers walk past them
 * (ancestor-walk mode) or fail closed (single-cwd mode). Real filesystem
 * errors (EACCES, EPERM, ELOOP, EMFILE, …) surface to the caller rather
 * than being silently treated as "not a project here".
 */
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

/**
 * Walk upward from `dir` looking for an ancestor whose `<cur>/.ok/config.yml`
 * exists as a regular file. Returns the first hit with the directory distance
 * from the input (0 = `dir` itself is the project root); returns `null` if no
 * ancestor up to filesystem root is a project root.
 *
 * Marker is `.ok/config.yml` (not just `.ok/`); folders with `.ok/` sidecars
 * but no `config.yml` are NOT project roots.
 */
export function findEnclosingProjectRoot(dir: string): FindEnclosingProjectRootResult | null {
  let cursor = resolve(dir);
  let distance = 0;
  while (distance < ANCESTOR_WALK_DEPTH_LIMIT) {
    let hit = false;
    try {
      hit = isProjectRoot(cursor);
    } catch {
      // EACCES / ELOOP mid-walk: treat as a miss and keep walking. The
      // ancestor walk is best-effort across an arbitrary filesystem tree;
      // a single permission denial shouldn't abort the walk.
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
