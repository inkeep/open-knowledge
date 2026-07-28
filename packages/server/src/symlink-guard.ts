/**
 * Realpath-based symlink-escape containment for the fs write/read sites that
 * operate on git-tracked paths — the pull-only overlay apply, working-tree
 * conflict resolution, and conflict-content reads.
 *
 * A git remote is untrusted: it can commit a symlink at a tracked path, and a
 * fast-forward materialises that link on disk. A subsequent bare `node:fs`
 * write follows the link to wherever it points, so a lexical `..`/absolute
 * check (which normalizes but never dereferences symlinks) is not enough — a
 * symlinked path component sails through it. Refuse when the target resolves
 * outside `rootDir`, OR into the root's own `.git`/`.ok` trees (see below).
 * Mirrors the persistence + api-extension `assertNoSymlinkEscape` controls;
 * fails closed on unexpected realpath errors.
 *
 * Two subtleties this handles that a plain realpath check does not:
 *   1. `.git`/`.ok` live INSIDE the git root, so a lexical/realpath "within
 *      root" check alone still permits a symlink resolving to
 *      `.git/hooks/post-checkout` (code-exec on the next git op) or
 *      `.ok/local/config.yml` (config hijack). The logical-path content filter
 *      only sees the pre-symlink name, so those must be re-refused on the
 *      resolved path here.
 *   2. A DANGLING symlink (target not yet created — e.g. git ships
 *      `post-checkout.sample`, not `post-checkout`) makes `realpathSync` throw
 *      ENOENT, and a naive climb to the lexical parent would pass it — yet a
 *      write through that link CREATES the target. The link is resolved
 *      manually so its destination is checked even when absent.
 */

import { lstatSync, readlinkSync, realpathSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { SymlinkEscapeError } from './apply-managed-rename.ts';
import { isWithinDir, toPosix } from './path-utils.ts';

/**
 * Assert that `targetAbsPath` does not resolve (via symlinks) outside `rootDir`
 * and does not resolve into the root's `.git` or `.ok` state trees. Throws
 * {@link SymlinkEscapeError} on escape, on a symlink cycle, or on any
 * unexpected realpath failure (fail-closed). A missing leaf is fine — the walk
 * climbs to the nearest existing ancestor (or follows a dangling symlink to its
 * intended target) and checks that instead, so a brand-new file under a
 * legitimate directory passes.
 */
export function assertRealpathWithinDir(targetAbsPath: string, rootDir: string): void {
  const resolvedRoot = resolve(rootDir);
  let canonicalRoot: string;
  try {
    canonicalRoot = realpathSync(resolvedRoot);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') throw new SymlinkEscapeError('root directory does not exist');
    throw err;
  }

  let cur = resolve(targetAbsPath);
  // Each pass either climbs one lexical parent (path shrinks) or follows one
  // symlink; the counter is a fail-closed backstop against a pathological
  // dangling-symlink chain that neither resolves nor climbs to root.
  for (let steps = 0; ; steps++) {
    if (steps > 256) throw new SymlinkEscapeError('too many symlink resolutions in path');
    try {
      const canonical = realpathSync(cur);
      if (!isWithinDir(canonical, canonicalRoot)) {
        throw new SymlinkEscapeError(`path resolves outside ${rootDir}`);
      }
      if (resolvesIntoInternalStateDir(canonical, canonicalRoot)) {
        throw new SymlinkEscapeError('path resolves into the .git/.ok state tree');
      }
      return;
    } catch (err) {
      if (err instanceof SymlinkEscapeError) throw err;
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ELOOP') throw new SymlinkEscapeError('symlink cycle in path');
      // Anything other than "leaf not created yet" leaves the gate unverifiable:
      // fail closed rather than silently permitting the write.
      if (code !== 'ENOENT') throw err;
      // `cur` didn't resolve. If `cur` itself is a symlink, its target is merely
      // absent (dangling) — realpath can't follow it, but a write WOULD create
      // the target. Resolve the link manually so its destination is checked;
      // otherwise a dangling symlink into `.git`/`.ok` (or outside root) would
      // slip through the lexical-parent climb.
      let linkTarget: string | null = null;
      try {
        if (lstatSync(cur).isSymbolicLink()) linkTarget = readlinkSync(cur);
      } catch {
        // `cur` doesn't exist at all (not even as a dangling link) — fall
        // through to the lexical climb to find the nearest existing ancestor.
      }
      if (linkTarget !== null) {
        cur = resolve(dirname(cur), linkTarget);
        continue;
      }
      const parent = dirname(cur);
      if (parent === cur) throw err;
      // Never climb above the root while chasing a missing leaf — a target that
      // would resolve above `rootDir` is itself an escape.
      if (parent !== resolvedRoot && !isWithinDir(parent, resolvedRoot)) {
        throw new SymlinkEscapeError(`path resolves outside ${rootDir}`);
      }
      cur = parent;
    }
  }
}

/**
 * True when `canonical` (already confirmed within `canonicalRoot`) sits inside
 * the root-level `.git` (git internals) or `.ok` (per-machine state) tree. Only
 * the two ROOT-level trees are matched — a nested `<folder>/.ok/` holding folder
 * metadata is legitimate content-adjacent state and is intentionally allowed.
 */
function resolvesIntoInternalStateDir(canonical: string, canonicalRoot: string): boolean {
  const rel = toPosix(relative(canonicalRoot, canonical));
  if (rel === '' || rel.startsWith('..')) return false;
  const first = rel.split('/')[0];
  return first === '.git' || first === '.ok';
}
