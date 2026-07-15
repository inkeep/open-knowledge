/**
 * Renderer-path containment primitives shared by every IPC handler that acts
 * on a renderer-supplied filesystem path (`spawnCursor`, `showItemInFolder`,
 * `trashItem`, asset opens, bug-report send). Lives in its own leaf module —
 * importing only `node:path` — so validation-only consumers don't drag in the
 * rest of the handler surface (and its `@inkeep/open-knowledge-server`
 * dependency, which several sibling test suites replace via `mock.module`).
 */

import { posix as pathPosix, win32 as pathWin32 } from 'node:path';

/** Reject non-absolute paths, null bytes, and empties. Shared with tests. */
export function validateSpawnPath(path: string, platform: NodeJS.Platform): boolean {
  if (!path || typeof path !== 'string') return false;
  if (path.includes('\0')) return false;
  if (platform === 'win32') {
    // Match `C:\…`, `C:/…`, or UNC `\\server\share\…`.
    return /^([a-zA-Z]:[\\/]|\\\\)/.test(path);
  }
  // POSIX (darwin / linux) — absolute paths start with `/`.
  return path.startsWith('/');
}

/**
 * Resolve both paths canonically and verify `path` lies at or under
 * `projectPath`. Returns false on invalid inputs or boundary escape.
 *
 * Uses `path/posix` or `path/win32` explicitly instead of the host default so
 * Windows inputs resolve correctly on a POSIX dev runner under test, and
 * production behavior follows the caller's platform regardless of Node's
 * runtime `path` module.
 *
 * On Windows, also rejects when the two paths don't share a canonical root
 * (drive letter or `\\server\share` for UNC, `\\?\…` / `\\.\…` for device
 * namespaces). Without that check, `path.win32.relative()` returns the
 * absolute "to" path when roots differ — and the rel-shape probes below
 * miss the UNC / device-prefix forms because they don't begin with a drive
 * letter. Root comparison is case-insensitive (Windows filesystem semantics).
 *
 * Lexical comparison only — does not resolve symlinks. A symlink inside
 * `projectPath` that targets a path outside (e.g. `<proj>/notes -> /etc`)
 * passes this check; the OS will follow it at use time.
 *
 * **Logical sibling of `isPathWithinDir` in `@inkeep/open-knowledge-server`.**
 * Both implement the same containment algorithm; the desktop version is
 * retained because its test suite exercises edge cases this file uniquely
 * cares about (Electron `showItemInFolder` UNC + device-namespace handling).
 * If the two versions ever drift, consolidate by re-exporting one as the
 * other — they share a security contract. A parity matrix in
 * `path-containment.test.ts` pins the two to identical verdicts.
 */
export function isPathWithinProject(
  userPath: string,
  projectPath: string,
  platform: NodeJS.Platform,
): boolean {
  if (!validateSpawnPath(userPath, platform)) return false;
  if (!validateSpawnPath(projectPath, platform)) return false;
  const p = platform === 'win32' ? pathWin32 : pathPosix;
  try {
    const canonicalUser = p.resolve(userPath);
    const canonicalProject = p.resolve(projectPath);
    if (platform === 'win32') {
      const userRoot = p.parse(canonicalUser).root.toLowerCase();
      const projectRoot = p.parse(canonicalProject).root.toLowerCase();
      if (!userRoot || !projectRoot || userRoot !== projectRoot) return false;
    }
    if (canonicalUser === canonicalProject) return true;
    const rel = p.relative(canonicalProject, canonicalUser);
    // `relative` returns `..` / `..\foo` / `../foo` when `userPath` escapes
    // the project root, or an absolute form when roots differ on Windows.
    if (rel === '' || rel === '.') return true;
    if (rel === '..' || rel.startsWith(`..${p.sep}`)) return false;
    // Defense-in-depth — the root check above already rejects cross-root,
    // but if a future code path introduces another way for `rel` to come
    // back absolute (drive `D:\…`, UNC `\\server\…`, device `\\?\…`,
    // `\\.\…`), refuse it here.
    if (platform === 'win32' && (/^[a-zA-Z]:[\\/]/.test(rel) || rel.startsWith('\\\\'))) {
      return false;
    }
    if (platform !== 'win32' && rel.startsWith('/')) return false;
    return true;
  } catch (err) {
    // path.resolve / path.parse are total on inputs that pass the shape
    // checks above — a throw here is unexpected (corrupted unicode, a
    // Node-internals regression). Warn so an engineer debugging an
    // unexplained containment refusal sees the root cause instead of
    // investigating a phantom path-escape — same semantics as
    // `isPathWithinDir` in `@inkeep/open-knowledge-server`.
    // Deliberate `console.warn` rather than the pino desktop logger (the
    // AGENTS.md default): this is a dependency-free leaf containment util
    // shared with contexts that inject no logger, mirroring the logger-free
    // server `isPathWithinDir` it must stay verdict-compatible with.
    console.warn('[path-containment] unexpected path-resolution error:', err);
    return false;
  }
}
