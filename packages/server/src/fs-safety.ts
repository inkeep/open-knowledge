import { lstatSync, realpathSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { isWithinContentDir } from './content-path.ts';
import { normalizeFsPath } from './fs-traced.ts';
import { errnoCode } from './http/handler-utils.ts';
import type { PinoLogger } from './logger.ts';

export class SymlinkEscapeError extends Error {
  constructor(message: string) {
    super(`symlink-escape: ${message}`);
    this.name = 'SymlinkEscapeError';
  }
}

export class ContentRootUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ContentRootUnavailableError';
  }
}

export function assertNoSymlinkEscape(fullPath: string, resolvedContentDir: string): void {
  let contentRoot: string;
  try {
    contentRoot = realpathSync(resolvedContentDir);
  } catch (err) {
    const code = errnoCode(err);
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

export type SymlinkLeafCheck =
  | { kind: 'not-symlink' }
  | { kind: 'symlink' }
  | { kind: 'unverifiable'; code: string | undefined };

/* STOP: an `<folder>/.ok` artifact path (the `frontmatter.yml` leaf or the
   `.ok` directory itself) must never be a symlink on the arms this guard
   fronts — the folder-config, template, and folder-history HTTP arms plus
   the `readFolderFrontmatter` / `collectFromFolder` readers they share with
   directory enrichment — even though the sync plane admits in-root
   shareable-artifact symlinks via `assertRealpathWithinDir`'s
   `allowShareableOkArtifact`: the folder-config PUT merges and rewrites the
   leaf in place (`renameSync` replaces the link), so realpath containment
   alone would let a committed link materialize foreign content as in-root
   git-trackable bytes. Do not harmonize the `symlink` case back to
   containment semantics. This is NOT a whole-plane claim: the MCP
   `edit({ template })` leaf read and the `exec` cat-path enrichment
   (`enrichPath` → `readFrontmatter`) still resolve lexically and are not
   covered here. `unverifiable` (a non-ENOENT lstat failure —
   EACCES/ELOOP/ENOTDIR) is reported DISTINCTLY from `symlink` so callers
   never assert "it is a symlink" for a path that is not one; read arms
   surface it as a warning, the template ancestor walk fails loud (500
   carrying the errno) except for ENOTDIR, which it treats as absent and
   walks past (a non-directory `.ok` / `templates` provably holds no
   templates, matching the menu's skip), and everywhere else the follow-on
   syscall (containment realpath, or the write itself) fails on the same
   errno. `lstat` differs from open/stat only in not following the FINAL
   component, and a symlinked final component makes lstat SUCCEED (→
   `symlink`), so no errno can make this return `unverifiable` while a
   follow-on read of the same path succeeds. The `frontmatter.yml`-leaf
   accessors and every call site of this guard (pinned per file by argument
   expression) are enforced by `symlink-leaf-guard-enforcement.test.ts`;
   loop-free call sites keep each guarded component pin-visible. */
export function checkSymlinkLeaf(absPath: string): SymlinkLeafCheck {
  try {
    return lstatSync(absPath).isSymbolicLink() ? { kind: 'symlink' } : { kind: 'not-symlink' };
  } catch (err) {
    const code = errnoCode(err);
    if (code === 'ENOENT') return { kind: 'not-symlink' };
    return { kind: 'unverifiable', code };
  }
}

export class PathContainmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PathContainmentError';
  }
}

export function isContainmentRejection(err: unknown): boolean {
  return err instanceof PathContainmentError || err instanceof SymlinkEscapeError;
}

function logCanonicalizationFault(log: PinoLogger, path: string, err: unknown): void {
  log.warn(
    { path: normalizeFsPath(path), code: errnoCode(err), err },
    '[fs-safety] reserved-path canonicalization fell back to the lexical path; a symlink-based reserved-subtree check may be stale for this request',
  );
}

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
  return (
    code === 'EEXIST' ||
    code === 'ERR_FS_CP_EEXIST' ||
    code === 'ERR_FS_CP_DIR_TO_NON_DIR' ||
    code === 'ERR_FS_CP_NON_DIR_TO_DIR'
  );
}
