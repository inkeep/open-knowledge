/**
 * Path-safety helpers shared by `planSeed` and `applySeed`.
 *
 * Two distinct attack vectors are guarded here:
 *
 *   1. Direct path traversal in plan entries — applySeed receives a ScaffoldPlan
 *      whose `created[].path` values come from across a trust boundary
 *      (`/api/seed/apply` HTTP body, Electron IPC payload). A path like
 *      `../etc/passwd` joined with `projectDir` would write outside the
 *      project. Lexical containment (`resolve(...).startsWith(projectAbs+sep)`)
 *      catches this.
 *
 *   2. Symlink escape — `projectDir` may contain a pre-existing symlink
 *      (`brain -> /etc`) planted by an attacker (cloned repo, mounted volume).
 *      Lexical resolve does not follow symlinks, so `<projectDir>/brain/...`
 *      passes containment while writes land outside via the symlink. Defeated
 *      by `realpathSync` of the deepest existing ancestor — symlinks anywhere
 *      on the path get canonicalized before the containment comparison.
 */

import { existsSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, resolve, sep } from 'node:path';
import { SeedRootDirError } from './types.ts';

/**
 * Validate an entry path supplied by a caller (plan body, IPC payload). Returns
 * the resolved absolute path on success. Throws `SeedRootDirError` (used here
 * for any seed-input rejection — kind doesn't change the semantics for
 * surfaced errors) on:
 *   - empty / non-string input
 *   - null byte
 *   - absolute path
 *   - `..` segment (POSIX or Windows separator)
 *   - lexical resolve outside `projectDir`
 *   - realpath of any existing ancestor outside the canonical project dir
 *
 * `projectDir` itself is realpath'd so the comparison anchor matches platform
 * normalization (macOS `/var` → `/private/var`).
 */
export function assertEntryPathInProject(projectDir: string, relPath: unknown): string {
  if (typeof relPath !== 'string' || relPath === '') {
    throw new SeedRootDirError(`entry path must be a non-empty string, got: ${typeof relPath}`);
  }
  if (relPath.includes('\0')) {
    throw new SeedRootDirError('entry path must not contain null bytes');
  }
  if (isAbsolute(relPath)) {
    throw new SeedRootDirError(`entry path must be relative, got: ${relPath}`);
  }
  if (relPath.split(/[/\\]/).some((seg) => seg === '..')) {
    throw new SeedRootDirError(`entry path must not contain '..' segments, got: ${relPath}`);
  }

  const projectAbs = resolve(projectDir);
  const candidateAbs = resolve(projectAbs, relPath);
  if (candidateAbs !== projectAbs && !candidateAbs.startsWith(projectAbs + sep)) {
    throw new SeedRootDirError(
      `entry path must resolve inside the project directory, got: ${relPath}`,
    );
  }

  assertNoSymlinkEscape(candidateAbs, projectAbs);
  return candidateAbs;
}

/**
 * Walks up from `target` finding the first existing ancestor, realpath's it,
 * and asserts the canonical path stays within realpath(`projectAbs`). Missing
 * leaves are expected (apply hasn't created the file yet) — we only need at
 * least one existing ancestor to anchor the canonical comparison, and
 * `projectAbs` itself is guaranteed to exist (caller already realpath'd it
 * implicitly by getting here from planSeed/applySeed which require a real
 * project dir).
 *
 * Symlink loops surface as ELOOP and are rejected. Non-ENOENT errors propagate
 * so callers see e.g. EACCES rather than a silent allow.
 */
function assertNoSymlinkEscape(target: string, projectAbs: string): void {
  let projectRoot: string;
  try {
    projectRoot = realpathSync(projectAbs);
  } catch {
    // projectDir doesn't exist or isn't readable — caller's
    // existsSync(.ok/config.yml) check will catch the missing-project case;
    // nothing useful to compare to.
    return;
  }

  let cur = target;
  for (;;) {
    if (existsSync(cur)) {
      let canonical: string;
      try {
        canonical = realpathSync(cur);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'ELOOP') {
          throw new SeedRootDirError(`entry path traverses a symlink cycle: ${target}`);
        }
        throw err;
      }
      if (canonical !== projectRoot && !canonical.startsWith(projectRoot + sep)) {
        throw new SeedRootDirError(
          `entry path resolves outside the project directory via symlink: ${target}`,
        );
      }
      return;
    }
    const parent = dirname(cur);
    if (parent === cur) {
      // Reached filesystem root without finding any existing ancestor.
      // projectAbs itself is presumed to exist; if we walked past it without
      // matching, the candidate was outside lexically — caller already rejected
      // that case, so this is unreachable in practice. Be conservative.
      throw new SeedRootDirError(
        `entry path has no existing ancestor inside the project directory: ${target}`,
      );
    }
    cur = parent;
  }
}
