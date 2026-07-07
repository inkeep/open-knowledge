/**
 * Destructive helper backing the `ok:fs:remove-git-folder` IPC. Scope-narrowed
 * by design: callers pass a directory (`gitRoot`); the helper appends `.git`
 * itself, validates the resolved path, and refuses anything that doesn't
 * canonicalize to a `.git` entry. Extracted into a pure function so the
 * `ok:fs:remove-git-folder` handler is testable against real tmpdir fixtures
 * (per the existing `create-new-project.ts` / `folder-admission.ts` pattern).
 *
 * Layered defenses against a compromised or careless renderer:
 *   1. **Input validation** — non-empty string + already-resolved absolute
 *      path (`resolve(x) === x`), refusing `..`-based traversal in the input.
 *   2. **Membership check** — caller must pass an `allowedGitRoots` set,
 *      typically populated by recent `findEnclosingGitRoot` returns. The
 *      handler refuses anything the renderer fabricated locally.
 *   3. **Symlink defense** — `realpath` the resolved `.git` path; if the
 *      canonicalized basename is no longer `.git`, refuse. Catches a crafted
 *      `<gitRoot>/.git -> /Users/foo/important-dir` symlink that an attacker
 *      could plant pre-click.
 *   4. **Idempotence** — `.git` already absent (e.g. an external delete
 *      arrived between probe and click) is success, not failure. The
 *      ENOENT race during `realpath` is treated the same way.
 *
 * All rejections throw an `Error` with the documented prefix
 * `'ok:fs:remove-git-folder rejected:'` so the renderer's `parseError` /
 * surface logic can distinguish handler-rejected vs system-EXX errors.
 */

import { existsSync, promises as fsPromises, realpathSync } from 'node:fs';
import { basename, isAbsolute, join, resolve } from 'node:path';

const REJECT_PREFIX = 'ok:fs:remove-git-folder rejected:';

interface RemoveGitFolderDeps {
  /** Set of `gitRoot` strings the renderer may legitimately request. Populated
   *  by the main process on every `findEnclosingGitRoot` return. Tests pass a
   *  hand-built set. */
  readonly allowedGitRoots: ReadonlySet<string>;
}

/**
 * Permanently remove `<gitRoot>/.git`. Idempotent on the already-absent path.
 * Throws (with the `ok:fs:remove-git-folder rejected:` prefix) on input
 * validation failure, membership-set miss, or symlink-target mismatch.
 * Non-ENOENT `realpath` failures (EACCES, ELOOP) are wrapped into the same
 * rejection prefix with the original errno preserved as `cause` so the
 * renderer-side error banner reads consistently rather than surfacing raw
 * Node errno strings.
 */
export async function removeGitFolder(gitRoot: unknown, deps: RemoveGitFolderDeps): Promise<void> {
  if (typeof gitRoot !== 'string' || gitRoot.length === 0) {
    throw new Error(`${REJECT_PREFIX} gitRoot must be a non-empty string`);
  }
  // Already-resolved absolute path only. Catches `..`-traversal in the
  // input (`resolve` normalizes those away — if the input differs from
  // its resolved form, the caller is doing something the dialog never
  // surfaces). `findEnclosingGitRoot` always returns absolute, resolved
  // paths, so a legitimate flow always satisfies this.
  if (!isAbsolute(gitRoot) || resolve(gitRoot) !== gitRoot) {
    throw new Error(`${REJECT_PREFIX} gitRoot must be an absolute, resolved path`);
  }
  if (!deps.allowedGitRoots.has(gitRoot)) {
    throw new Error(`${REJECT_PREFIX} gitRoot was not surfaced by a recent probe`);
  }
  const target = join(gitRoot, '.git');
  if (!existsSync(target)) {
    // Idempotent — a parallel external delete (e.g. the user removing it
    // via Finder mid-click) shouldn't fail the action.
    return;
  }
  // Realpath defends against a crafted `<gitRoot>/.git` symlink that points
  // at an unrelated tree. If the canonicalized basename is no longer `.git`,
  // refuse before any rm. `find-git-root` uses `existsSync` without
  // `isDirectory` checks so worktree `.git` files are also accepted — the
  // rm here handles both file and directory via `recursive: true`.
  try {
    const canonical = realpathSync(target);
    if (basename(canonical) !== '.git') {
      throw new Error(`${REJECT_PREFIX} resolved symlink target is not a .git entry`);
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return;
    if (err instanceof Error && err.message.startsWith(REJECT_PREFIX)) throw err;
    // Wrap EACCES / ELOOP / other errno paths in the consistent prefix so
    // the renderer banner doesn't dump raw "ELOOP: too many levels..." at
    // the user. Preserve the original via `cause`.
    throw new Error(`${REJECT_PREFIX} could not resolve path (${code ?? 'unknown'})`, {
      cause: err,
    });
  }
  await fsPromises.rm(target, { recursive: true, force: true });
}
