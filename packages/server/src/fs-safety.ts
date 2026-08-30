import { realpathSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { isWithinContentDir } from './content-path.ts';
import { normalizeFsPath } from './fs-traced.ts';
import { errnoCode } from './http/handler-utils.ts';
import type { PinoLogger } from './logger.ts';

/**
 * Filesystem-safety predicates shared by every write surface that creates or
 * moves entries under the content directory (uploads, file ops, renames).
 * Home of the containment error family: `SymlinkEscapeError` (realpath half),
 * `PathContainmentError` (lexical half), the `isContainmentRejection`
 * classifier over both, and the non-containment `ContentRootUnavailableError`
 * (missing anchor — a server fault, outside the family). Also home of
 * `canonicalRelPathForNewTarget`, the canonicalizer reserved-subtree checks
 * run on not-yet-existing targets. `apply-managed-rename.ts` re-exports
 * `SymlinkEscapeError` for its historical import path.
 */

/**
 * Thrown when a `safeContentPath` resolution lands outside the content
 * directory — path resolves outside, or a symlink cycle. Caller surfaces as
 * 400 `urn:ok:error:path-escape`. (A missing content dir is NOT this — see
 * `ContentRootUnavailableError` below.)
 */
export class SymlinkEscapeError extends Error {
  constructor(message: string) {
    super(`symlink-escape: ${message}`);
    this.name = 'SymlinkEscapeError';
  }
}

/**
 * Thrown when the containment ANCHOR itself is missing: the content directory
 * does not exist, so there is no baseline to check a path against. This is a
 * server-side condition (dir deleted under a running server, unmounted volume),
 * not a malformed request, so it is deliberately NOT part of the containment
 * family — `isContainmentRejection` returns false and route catches let it
 * surface as a typed 500 instead of blaming the caller with a 400 path-escape.
 */
export class ContentRootUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ContentRootUnavailableError';
  }
}

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
    // escape is possible against a non-existent directory, but we have no
    // safe baseline for the check either. This is the SERVER's problem, not
    // the caller's, so it throws the non-containment
    // `ContentRootUnavailableError` and surfaces as a 500 rather than a 400
    // path-escape. Other errno classes (EPERM, EIO, ENOMEM) must NOT be
    // swallowed silently — they'd leave the security gate disabled with no
    // log line, no telemetry, no error response. Throw and let the
    // top-level handler emit a typed RFC 9457 problem.
    if (code === 'ENOENT') {
      throw new ContentRootUnavailableError('content directory does not exist');
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

/**
 * Raised by the lexical half of content-path containment — before the realpath
 * symlink check — for a path that is absent/absolute/backslashed/NUL-bearing,
 * carries a `.` or `..` segment, or resolves outside the content root by string
 * prefix. Its sibling `SymlinkEscapeError` (above in this module) covers
 * the realpath half. Both are the CALLER's fault and map to a 400 path-escape;
 * they differ only in which check tripped. A raw realpath errno
 * (EACCES/EIO/ESTALE) rethrown by `assertNoSymlinkEscape` is NOT one of these —
 * it is an infrastructure fault and must surface as a 500.
 */
export class PathContainmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PathContainmentError';
  }
}

/**
 * True when `err` is a client-side containment rejection: the lexical
 * `PathContainmentError` or the realpath `SymlinkEscapeError`. This is exactly
 * the set a path-resolution catch maps to a 400 path-escape — everything else
 * (notably the raw realpath errnos `assertNoSymlinkEscape` rethrows by contract,
 * and `ContentRootUnavailableError` for a missing content dir) must propagate so
 * it surfaces as a typed 500 with the right log level and telemetry tag, not a
 * misleading client 400.
 */
export function isContainmentRejection(err: unknown): boolean {
  return err instanceof PathContainmentError || err instanceof SymlinkEscapeError;
}

function logCanonicalizationFault(log: PinoLogger, path: string, err: unknown): void {
  // Keep the raw error object in the structured fields so the errno `code`
  // survives for grepping/alerting; the message carries only the summary.
  log.warn(
    { path: normalizeFsPath(path), code: errnoCode(err), err },
    '[fs-safety] reserved-path canonicalization fell back to the lexical path; a symlink-based reserved-subtree check may be stale for this request',
  );
}

/**
 * Canonical contentDir-relative path for a target that does not exist yet,
 * always `/`-separated. `path.resolve` does not follow symlinks, so a lexical
 * `fullPath` can name a reserved subtree without any `.ok`/`.git` segment (a
 * symlinked directory). Realpath the nearest existing ancestor and re-attach the
 * missing tail so a reserved-path check sees where the write would ACTUALLY
 * land. The content root is realpath'd too, so a platform alias (macOS `/var` →
 * `/private/var`) on one side doesn't skew the relative result.
 *
 * POSTCONDITION: the return value uses `/` separators regardless of platform.
 * This is a contract with the sole consumer `isReservedProjectStatePath`, which
 * does `path.split('/')` — a `\`-separated win32 result would split into one
 * element and silently defeat the guard. TypeScript cannot express this, hence
 * the explicit normalization at every exit.
 *
 * Falls back to the lexical relative path (still `/`-normalized) when nothing can
 * be canonicalized — a raw realpath errno logs and returns; ENOENT all the way to
 * the filesystem root returns silently. The caller's lexical reserved check still
 * stands in the fallback. `realpath` and the path flavor `p` are injectable so the
 * fault branches AND the win32 separator normalization can be tested
 * deterministically from any platform.
 *
 * Sibling primitive: `assertRealpathWithinDir` in `symlink-guard.ts` answers the
 * same realpath-then-refuse-`.ok`/`.git` question with two deliberate
 * differences — it matches only ROOT-level `.git`/`.ok` (nested `<folder>/.ok/`
 * is a first-class shape there) where `isReservedProjectStatePath` matches at any
 * depth, and it resolves dangling symlink leaves manually via `lstat`/`readlink`
 * with a step cap where this helper's ENOENT branch climbs by `dirname`. Harden
 * one and check whether the other needs the same change.
 */
export function canonicalRelPathForNewTarget(
  fullPath: string,
  resolvedContentDir: string,
  log: PinoLogger,
  realpath: typeof realpathSync = realpathSync,
  p: Pick<typeof import('node:path').posix, 'join' | 'relative' | 'dirname' | 'sep'> = {
    join,
    relative,
    dirname,
    sep,
  },
): string {
  const toPosix = (s: string): string => s.split(p.sep).join('/');
  let contentRoot: string;
  try {
    contentRoot = realpath(resolvedContentDir);
  } catch (err) {
    // ENOENT (content dir not created yet) is benign; anything else means the
    // anchor could not be canonicalized and the check may be stale — worth a warn.
    if (errnoCode(err) !== 'ENOENT') logCanonicalizationFault(log, resolvedContentDir, err);
    contentRoot = resolvedContentDir;
  }
  let cur = fullPath;
  for (;;) {
    try {
      const canonicalAncestor = realpath(cur);
      const canonicalFull = p.join(canonicalAncestor, p.relative(cur, fullPath));
      return toPosix(p.relative(contentRoot, canonicalFull));
    } catch (err) {
      if (errnoCode(err) !== 'ENOENT') {
        logCanonicalizationFault(log, cur, err);
        return toPosix(p.relative(contentRoot, fullPath));
      }
      const parent = p.dirname(cur);
      if (parent === cur) return toPosix(p.relative(contentRoot, fullPath));
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
