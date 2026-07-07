/**
 * Lightweight `<projectPath>/<path>` existence probe for the share-receive
 * pre-server target check. Runs after the `.git/HEAD` branch comparison
 * passes — answers "does the target the share links to actually exist on the
 * current working tree?" Without this gate, a share-link whose target does
 * not exist on the receiver's locally checked-out branch (typical
 * stale-branch scenario: the receiver has not `git fetch`ed since the target
 * was added on the remote branch) opens a blank editor with no signal.
 *
 * Kind-aware: a `doc` target probes for a regular file
 * (`<path>` resolves to a non-directory `statSync`); a `folder` target
 * probes for a directory (`statSync(<path>).isDirectory()`). The result
 * shape (`exists | missing | unreadable`) is identical across kinds; only
 * the on-disk predicate differs. Content-root folder shares (empty path)
 * skip this probe entirely at the call site — the root always exists — so
 * this function never receives an empty `path`.
 *
 * This runs before any project is opened — no server, no `simple-git`. The
 * receiver is choosing between silent dispatch (target present) and
 * surfacing a "missing on branch" toast (target absent); a graceful fail
 * must collapse to silent dispatch so a single broken project never blocks
 * a share-receive that the file system happens to refuse to stat.
 *
 * Safety mirrors `read-head-branch.ts`'s `isSafeProjectPath`, plus a stricter
 * relative-path discipline on `path`: must NOT be absolute, must NOT
 * contain `..` segments, must resolve inside `projectPath` (`realpath` is
 * not used — symlinks are honoured by the existing project semantics, the
 * containment check uses lexical resolution).
 */

import { statSync } from 'node:fs';
import { isAbsolute, join, resolve, sep } from 'node:path';

/**
 * Outcome of probing `<projectPath>/<path>`. Discriminated string so the
 * IPC payload stays small + JSON-stable across the renderer boundary.
 *
 * - `'exists'` — the resolved path matches the requested kind: a regular
 *   file for `doc`, a directory for `folder`. Silent dispatch proceeds.
 * - `'missing'` — the resolved path returned `ENOENT`, or it resolved to
 *   something other than the requested kind (a `doc` probe hitting a
 *   directory, or a `folder` probe hitting a file). Dialog surfaces the
 *   "not on this branch yet" copy.
 * - `'unreadable'` — input rejected (unsafe path) OR an I/O error other
 *   than `ENOENT` (e.g. `EACCES`, `EIO`). Caller treats this identically
 *   to `'exists'`: graceful-fail collapses to silent dispatch.
 */
export type CheckTargetExistsResult = 'exists' | 'missing' | 'unreadable';

/**
 * Reject `projectPath` inputs that aren't safe to consume from a fresh
 * IPC payload. Mirrors `isSafeProjectPath` in `read-head-branch.ts`. We
 * deliberately re-implement rather than import — these two files are the
 * full pre-server probe surface, and a future migration off either should
 * not require touching the other.
 */
function isSafeProjectPath(projectPath: string): boolean {
  if (typeof projectPath !== 'string') return false;
  if (projectPath.length === 0) return false;
  if (projectPath.includes('\0')) return false;
  if (!isAbsolute(projectPath)) return false;
  // `resolve` collapses `..` traversal; if the caller passed
  // `/a/b/../../etc`, `resolve` returns `/etc` and we refuse.
  if (resolve(projectPath) !== projectPath) return false;
  return true;
}

/**
 * Reject `path` inputs that aren't safe as a share-link target path. Applies
 * uniformly to doc and folder targets — the only difference between the two
 * kinds is the final stat predicate, not the path-shape gate.
 *
 * Constraints:
 * - non-empty string (content-root's empty path is short-circuited at the
 *   call site, so this probe never sees it)
 * - NOT absolute (the share encodes a repo-relative path)
 * - no backslash (macOS-only; `\` is never a separator and could not have
 *   been minted by the sender) and no control chars (NUL through US + DEL)
 * - no `..` or `.git` segments (rejected pre-resolve so `a/../b` style escapes
 *   fail-loud — the containment check below catches absolute `..` sequences
 *   too, but pre-checking yields clearer telemetry, and `.git` keeps the gate
 *   symmetric with the sender-side validators)
 */
function isSafeTargetPath(path: string): boolean {
  if (typeof path !== 'string') return false;
  if (path.length === 0) return false;
  if (isAbsolute(path)) return false;
  // Reject ANY backslash, matching the sender-side `isValidSharePath` and
  // `isValidBranchInfoPath` (precedent #55, predicate symmetry). OK is
  // macOS-only, so a backslash is never a path separator; a backslash-bearing
  // target path could never have been minted by the sender, so reject it here
  // too rather than treating `\` as a separator.
  if (path.includes('\\')) return false;
  // Reject all control chars (NUL through US, plus DEL), not just NUL — a
  // control char would survive `path.join` into the `cat-file -e <ref>:<path>`
  // probe. Symmetric with the sibling validators.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control chars are exactly what we want to reject
  if (/[\x00-\x1F\x7F]/.test(path)) return false;
  // Reject `..` (escape) and `.git` (git-internals) segments up-front. The
  // containment check below catches `..` escapes too, but pre-checking yields
  // clearer telemetry and keeps the gate symmetric with the sender side.
  const segments = path.split('/');
  // Reject empty segments (consecutive/trailing slashes) alongside `..` and
  // `.git`, matching both sibling validators. A well-formed repo-relative path
  // has no empty segments; the content-root empty path is short-circuited at
  // the call site, so this never rejects a legitimate target.
  if (segments.some((s) => s === '' || s === '..' || s === '.git')) return false;
  return true;
}

/**
 * Compose `<projectPath>/<path>` and verify the resolved path stays
 * inside `projectPath`. Returns `null` on containment violation. Lexical
 * check — does not resolve symlinks. Symlinks inside `contentDir` are a
 * supported topology; this guard
 * exists for the malicious-input case where `path` is crafted to
 * traverse out via `..` or absolute-style components that survive
 * `isSafeTargetPath` due to platform-specific separator handling.
 */
function joinContained(projectPath: string, path: string): string | null {
  const joined = resolve(join(projectPath, path));
  const projectResolved = resolve(projectPath);
  // Add a trailing separator to the project root so a sibling directory
  // sharing a prefix (`/a/project-evil`) cannot satisfy `startsWith`
  // against the legitimate root (`/a/project`).
  const projectWithSep = projectResolved.endsWith(sep) ? projectResolved : projectResolved + sep;
  if (joined === projectResolved) return joined;
  if (!joined.startsWith(projectWithSep)) return null;
  return joined;
}

/**
 * Probe `<projectPath>/<path>` and classify it against the share target's
 * `kind`. Never throws; any error other than `ENOENT` returns the
 * `'unreadable'` sentinel so the caller falls back to silent dispatch.
 *
 * - `kind: 'doc'` → `'exists'` only when the path is a regular file.
 * - `kind: 'folder'` → `'exists'` only when the path is a directory.
 *
 * A path that resolves to the wrong type for its kind (a `doc` probe landing
 * on a directory, or a `folder` probe landing on a file) is `'missing'` —
 * the share's target genuinely isn't present in the expected shape on this
 * branch.
 */
export function checkTargetExists(
  projectPath: string,
  kind: 'doc' | 'folder',
  path: string,
): CheckTargetExistsResult {
  if (!isSafeProjectPath(projectPath)) return 'unreadable';
  if (!isSafeTargetPath(path)) return 'unreadable';
  const fullPath = joinContained(projectPath, path);
  if (fullPath === null) return 'unreadable';
  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(fullPath);
  } catch (err) {
    // ENOENT is the load-bearing miss signal — surface it as `'missing'`
    // so the renderer can show the "not on this branch yet" copy.
    // Every other errno (EACCES, EIO, ELOOP, ENAMETOOLONG, ...) is a real
    // filesystem failure that the share-receive flow should NOT block on;
    // collapse to `'unreadable'` and let the silent-dispatch fallback
    // run.
    if (
      typeof err === 'object' &&
      err !== null &&
      'code' in err &&
      (err as { code?: unknown }).code === 'ENOENT'
    ) {
      return 'missing';
    }
    return 'unreadable';
  }
  const matches = kind === 'folder' ? stat.isDirectory() : stat.isFile();
  if (!matches) return 'missing';
  return 'exists';
}

/**
 * Decide whether a share-receive deep-link target is absent on the receiver's
 * checked-out working tree, so the caller can flag the window it is about to
 * open. Renderer-initiated opens — a fresh clone, or a pivot into another
 * worktree — reach window-open through the `ok:project:open` IPC handler rather
 * than the deep-link dispatcher, so they never run the target probe that
 * `dispatchResolvedShare` runs on the `branch-match-ok` leg. Without it a moved
 * or deleted target lands the receiver in the create-mode editor and lets them
 * silently fork the doc at the shared path. (This mirrors the `isContentRoot`
 * short-circuit + `=== 'missing'` check in `url-scheme.ts`'s dispatcher; kept
 * separate because that path takes the probe as an injected dep.)
 *
 * Content-root folder shares (empty `path`) always exist — the working-tree
 * root is the target — so they short-circuit before the probe, which classifies
 * an empty path as `unreadable`. Only a definitive `'missing'` flags the target:
 * `'unreadable'` (unsafe input, or an I/O error other than ENOENT) collapses to
 * `false`, so a probe failure never blocks the open.
 */
export function computeShareTargetMissing(
  probe: (projectPath: string, kind: 'doc' | 'folder', path: string) => CheckTargetExistsResult,
  projectPath: string,
  target: { kind: 'doc' | 'folder'; path: string },
): boolean {
  if (target.kind === 'folder' && target.path === '') return false;
  return probe(projectPath, target.kind, target.path) === 'missing';
}
