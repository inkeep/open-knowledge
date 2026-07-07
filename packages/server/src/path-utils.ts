/**
 * Normalize a filesystem path to POSIX (`/`) separators.
 *
 * Logical identifiers in OpenKnowledge — docNames, relative content paths,
 * and response `path` / `targetPath` fields — are ALWAYS POSIX. `path.relative`
 * (and prefix-stripping of absolute paths) emit `\` on Windows, so any such
 * result that becomes a docName, map key, or wire field MUST pass through here
 * first or it diverges from the POSIX docNames the rest of the system uses.
 *
 * Unconditional `\` → `/` (matching `file-watcher.ts`'s long-standing
 * `replaceAll('\\', '/')`): a no-op on already-POSIX paths, and POSIX absolute
 * paths produced by `resolve()` / `relative()` never contain backslashes. Being
 * separator-independent (rather than gated on `process.platform`) is what lets
 * the Windows behavior be unit-tested on a POSIX CI runner.
 */
export function toPosix(p: string): string {
  return p.replace(/\\/g, '/');
}

/**
 * True when `child` is `parent` itself or nested beneath it.
 *
 * Separator-correct: both operands are normalized to POSIX before comparison,
 * so this works for POSIX (`/foo/bar`) and Windows (`C:\foo\bar`, or mixed
 * `C:\foo/bar`) paths alike — and on any host OS, since it does not consult
 * `path.sep`. It is a string-prefix check, NOT a filesystem walk; both
 * arguments must be the same kind of path (in practice both `resolve()` /
 * `realpath()` output) so they share a root. Hardcoding `/` against an
 * un-normalized Windows path is the bug class this replaces: there
 * `child.startsWith(`${parent}/`)` never matches because `child` uses `\`.
 */
export function isWithinDir(child: string, parent: string): boolean {
  const c = toPosix(child);
  const p = toPosix(parent);
  return c === p || c.startsWith(`${p}/`);
}
