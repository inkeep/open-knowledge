/**
 * Lexical path-containment helpers for MCP tool surfaces.
 *
 * Every MCP tool that resolves a caller-supplied path against the project /
 * content directory MUST funnel through `resolveWithinRoot` so the `..`
 * traversal class can never escape the configured root. The bash exec
 * sandbox (`ReadWriteFs` in `createBashInstance`) blocks traversal at the
 * shell layer, but the enrichment helpers (`enrichPath`, `enrichDirectory`)
 * and `exec` use `node:fs` directly with
 * `resolve(cwd, relPath)` — a `..` in `relPath` escapes silently without
 * these guards. Same gap for `exec` referenced-path enrichment: the bash
 * sandbox refuses `ls ../etc/` but `extractFromLs` still emits `"../etc"`
 * as a referenced path, and `enrichDirectory` happily readdirs `/etc/`.
 *
 * Containment is lexical (`path.resolve` + `path.relative`). Symlink-based
 * escape is a separate concern handled by the persistence layer's realpath
 * check (`symlink-escape`).
 */
import { isAbsolute, relative, resolve } from 'node:path';

interface ContainmentOk {
  ok: true;
  /** Resolved absolute host path, guaranteed to be at-or-under `root`. */
  abs: string;
  /**
   * `root`-relative path with no leading `./` and no `..` segments. May be
   * the empty string when `candidate` resolves to `root` itself.
   */
  rel: string;
}

interface ContainmentErr {
  ok: false;
  reason: string;
}

type ContainmentResult = ContainmentOk | ContainmentErr;

/**
 * Resolve `candidate` against `root` and verify the result stays inside
 * `root` (or equals it).
 *
 * `candidate` may be relative (`articles/auth.md`, `./foo`, `foo/../bar.md`)
 * or absolute (`/tmp/x`). Either way, the lexical resolution must not
 * escape `root` — `..` segments and absolute paths that point outside
 * `root` are rejected.
 *
 * `root` MUST be an absolute path. Pass the configured projectDir / contentDir.
 *
 * Returns `{ ok: true, abs, rel }` on containment, `{ ok: false, reason }`
 * otherwise. Never throws.
 */
export function resolveWithinRoot(root: string, candidate: string): ContainmentResult {
  if (typeof root !== 'string' || !isAbsolute(root)) {
    return { ok: false, reason: `root path is not absolute: ${String(root)}` };
  }
  if (typeof candidate !== 'string') {
    return { ok: false, reason: 'path must be a string' };
  }
  if (candidate.includes('\x00')) {
    return { ok: false, reason: 'path contains a NUL byte' };
  }
  const normalizedRoot = resolve(root);
  const abs = resolve(normalizedRoot, candidate);
  const rel = relative(normalizedRoot, abs);
  if (rel === '') {
    return { ok: true, abs, rel: '' };
  }
  // `path.relative` returns the path FROM `root` TO `abs`. If `abs` lies
  // outside `root` either (a) the relative result starts with `..`, or
  // (b) it's an absolute path (Windows: different drive). Both reject.
  // POSIX-only: this server targets Bun on macOS/Linux, and
  // `path.relative` always uses `/` on POSIX. A literal `'../'` prefix is
  // simpler and correct here. A heuristic that infers the separator from
  // `rel[2]` would false-positive on filenames like `..abc` (the third
  // character `'a'` would be misread as the separator and `..a` would
  // match `..a`).
  if (rel === '..' || rel.startsWith('../') || isAbsolute(rel)) {
    return {
      ok: false,
      reason: `path "${candidate}" escapes the configured root`,
    };
  }
  return { ok: true, abs, rel };
}
