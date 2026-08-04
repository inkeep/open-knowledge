import { realpathSync } from 'node:fs';
import { dirname, sep } from 'node:path';
import { SymlinkEscapeError } from './apply-managed-rename.ts';
import { isWithinContentDir } from './content-path.ts';
import { errnoCode } from './http/handler-utils.ts';

/**
 * Filesystem-safety predicates shared by every write surface that creates or
 * moves entries under the content directory (uploads, file ops, renames).
 */

/**
 * Ensures `fullPath` does not escape `resolvedContentDir` via symlinks (matches persistence
 * symlink-escape checks). Walks up with dirname when the leaf is missing so destinations like
 * `link/new.md` are rejected if `link` resolves outside the content dir.
 *
 * Uses `realpathSync(resolvedContentDir)` as the boundary anchor so platform normalization
 * (e.g. macOS `/var` → `/private/var`) matches `realpathSync` of paths under it.
 */
export function assertNoSymlinkEscape(fullPath: string, resolvedContentDir: string): void {
  let contentRoot: string;
  try {
    contentRoot = realpathSync(resolvedContentDir);
  } catch (err) {
    const code = errnoCode(err);
    // ENOENT means the content dir hasn't been created yet — no symlink
    // escape is possible against a non-existent directory, but we have
    // no safe baseline for the check either. Throw the same
    // `symlink-escape:` error class so the caller's catch routes through
    // the existing error path. Other errno classes (EPERM, EIO, ENOMEM)
    // must NOT be swallowed silently — they'd leave the security gate
    // disabled with no log line, no telemetry, no error response. Throw
    // and let the top-level handler emit a typed RFC 9457 problem.
    if (code === 'ENOENT') {
      throw new SymlinkEscapeError('content directory does not exist');
    }
    throw err;
  }

  let cur = fullPath;
  for (;;) {
    try {
      const canonical = realpathSync(cur);
      if (!isWithinContentDir(canonical, contentRoot)) {
        throw new SymlinkEscapeError('path resolves outside content directory');
      }
      return;
    } catch (err) {
      const code = errnoCode(err);
      if (code === 'ELOOP') {
        throw new SymlinkEscapeError('symlink cycle in path');
      }
      if (code !== 'ENOENT') throw err;
      const parent = dirname(cur);
      if (parent === cur) throw err;
      // Bound the ENOENT ancestor walk against EITHER spelling of the root.
      // The walk's parents keep the caller's spelling, but a platform alias
      // (macOS /var → /private/var) can put the caller's root and the
      // realpath'd `contentRoot` in different spellings — matching only one
      // false-positives for the other. Widening is safe: this guard only
      // bounds how far the walk ascends; containment is enforced by the
      // realpath check above.
      const withinRaw =
        parent === resolvedContentDir || parent.startsWith(`${resolvedContentDir}${sep}`);
      const withinCanonical = parent === contentRoot || parent.startsWith(`${contentRoot}${sep}`);
      if (!withinRaw && !withinCanonical) {
        throw err;
      }
      cur = parent;
    }
  }
}

export function isAlreadyExistsError(err: unknown): boolean {
  const code = errnoCode(err);
  // Node's cpSync distinguishes the destination-occupied cases by the type
  // mismatch: a same-type collision surfaces as ERR_FS_CP_EEXIST, but copying a
  // directory onto an existing file (or a file onto an existing directory)
  // surfaces as ERR_FS_CP_DIR_TO_NON_DIR / ERR_FS_CP_NON_DIR_TO_DIR. All three
  // mean the destination path is already taken and must map to 409.
  return (
    code === 'EEXIST' ||
    code === 'ERR_FS_CP_EEXIST' ||
    code === 'ERR_FS_CP_DIR_TO_NON_DIR' ||
    code === 'ERR_FS_CP_NON_DIR_TO_DIR'
  );
}
