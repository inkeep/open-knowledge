/**
 * Asset-open gate — the pure validation layer that sits in front of every
 * `shell.openPath` / `shell.showItemInFolder` dispatch for renderer-
 * supplied asset paths.
 *
 * Enforces three checks in this order on every `openAssetSafely` call:
 *   1. **Path containment** via `isPathWithinProject(canonicalPath,
 *      projectPath, platform)` — a realpath-resolved prefix check against
 *      the caller window's `ProjectContext.projectPath`. Rejects traversal
 *      (`../..`), absolute paths outside the project, cross-drive Windows
 *      escapes, and symlinked escapes.
 *   2. **Existence** via `fs.statSync` on the canonical path. A missing file
 *      is a clean refusal (`not-found`) rather than a `shell.openPath` that
 *      would surface an OS dialog on macOS or silently fail on Windows.
 *   3. **Extension blocklist** via `EXECUTABLE_BLOCKLIST_EXTENSIONS`
 *      — every entry is either a shell-executable (RCE risk via OS handler)
 *      or a scripted document (stored-XSS risk via browser-tab preview).
 *      Union of Windows exec + POSIX shell + OK's existing SCRIPTED_DOC_EXTS.
 *
 * `revealAssetSafely` skips the extension blocklist: `shell.showItemInFolder`
 * opens the *parent* directory without invoking the OS content handler, so
 * even an executable at the target is lower-risk (user still has to
 * double-click it themselves from Finder / Explorer).
 *
 * Pure module — no Electron import — so unit tests can exercise the three
 * checks without standing up an app. `openAssetSafely` and `revealAssetSafely`
 * take `deps` objects that inject the FS / shell primitives; the `index.ts`
 * wire-up passes the real `shell.openPath` + `shell.showItemInFolder`.
 *
 * Mirrors the shape of `shell-allowlist.ts` (URL-scheme gate for
 * `shell.openExternal`) so the two gates sit side-by-side architecturally.
 *
 */

import { realpathSync, statSync } from 'node:fs';
import * as pathPosix from 'node:path/posix';
import * as pathWin32 from 'node:path/win32';
import { EXECUTABLE_BLOCKLIST_EXTENSIONS } from '@inkeep/open-knowledge-core';
import { isPathWithinProject } from './ipc-handlers.ts';

export type AssetOpenResult =
  | { ok: true }
  | { ok: false; reason: 'extension-blocked' | 'path-escape' | 'not-found' | 'resolve-error' };

type AssetRevealResult =
  | { ok: true }
  | { ok: false; reason: 'path-escape' | 'not-found' | 'resolve-error' };

/**
 * Extract the lowercased extension from a path's last segment. Empty string
 * if the last segment has no `.` (or the `.` is a leading dot, i.e. dotfiles
 * like `.gitignore` — those have no extension by convention).
 */
export function extractPathExtension(path: string): string {
  const lastSep = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  const basename = lastSep >= 0 ? path.slice(lastSep + 1) : path;
  const dotIdx = basename.lastIndexOf('.');
  if (dotIdx <= 0) return '';
  return basename.slice(dotIdx + 1).toLowerCase();
}

interface OpenAssetDeps {
  readonly projectPath: string;
  readonly platform: NodeJS.Platform;
  readonly openPath: (canonical: string) => Promise<string>;
  /**
   * Test seam — defaults to `realpathSync` + `statSync`. Failure modes
   * mapped to `resolve-error` / `not-found` result branches.
   */
  readonly resolveCanonical?: (path: string) => string;
  readonly statExists?: (path: string) => boolean;
}

interface RevealAssetDeps {
  readonly projectPath: string;
  readonly platform: NodeJS.Platform;
  readonly showItemInFolder: (canonical: string) => void;
  readonly resolveCanonical?: (path: string) => string;
  readonly statExists?: (path: string) => boolean;
}

/**
 * Resolve `relPath` against `projectPath`, canonicalize via realpath, and
 * confirm it still lives under the project root. Returns the canonical
 * path on success or a failure-reason string suitable for the
 * `AssetOpenResult` / `AssetRevealResult` union.
 *
 * Shared between `openAssetSafely` and `revealAssetSafely` so the two
 * handlers never diverge on containment semantics.
 */
function resolveAndContain(
  relPath: string,
  projectPath: string,
  platform: NodeJS.Platform,
  resolveCanonical: (path: string) => string,
  statExists: (path: string) => boolean,
):
  | { ok: true; canonical: string }
  | { ok: false; reason: 'path-escape' | 'not-found' | 'resolve-error' } {
  // Refuse absolute paths from the renderer at the IPC boundary. Renderer
  // must always send project-relative paths; an absolute path is either a
  // bug or a renderer-compromise attempt.
  const p = platform === 'win32' ? pathWin32 : pathPosix;
  if (p.isAbsolute(relPath)) {
    return { ok: false, reason: 'path-escape' };
  }

  // Resolve relative → absolute under projectPath, then realpath to close
  // the symlink-escape window.
  const joined = p.resolve(projectPath, relPath);

  let canonical: string;
  try {
    canonical = resolveCanonical(joined);
  } catch (err) {
    // realpath throws ENOENT if the file is missing along the chain; the
    // missing-file case is distinguished from a generic resolve-error so
    // the renderer can tell "path doesn't exist" from "FS refused to
    // canonicalize for some other reason" (permission, I/O, etc.).
    const code = (err as NodeJS.ErrnoException | null)?.code;
    if (code === 'ENOENT') return { ok: false, reason: 'not-found' };
    return { ok: false, reason: 'resolve-error' };
  }

  if (!isPathWithinProject(canonical, projectPath, platform)) {
    return { ok: false, reason: 'path-escape' };
  }

  if (!statExists(canonical)) {
    return { ok: false, reason: 'not-found' };
  }

  return { ok: true, canonical };
}

function defaultResolveCanonical(path: string): string {
  return realpathSync(path);
}

function defaultStatExists(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Main-process handler for `ok:shell:open-asset`. Renderer sends a
 * project-relative path; this function resolves / contains / extension-gates
 * / dispatches. Returns `AssetOpenResult` — the renderer's dispatcher logs
 * the reason on failure (see `packages/app/src/editor/asset-dispatch/dispatcher.ts`).
 */
export async function openAssetSafely(
  deps: OpenAssetDeps,
  relPath: string,
): Promise<AssetOpenResult> {
  const resolveCanonical = deps.resolveCanonical ?? defaultResolveCanonical;
  const statExists = deps.statExists ?? defaultStatExists;

  const contained = resolveAndContain(
    relPath,
    deps.projectPath,
    deps.platform,
    resolveCanonical,
    statExists,
  );
  if (!contained.ok) return contained;

  const ext = extractPathExtension(contained.canonical);
  if (EXECUTABLE_BLOCKLIST_EXTENSIONS.has(ext)) {
    return { ok: false, reason: 'extension-blocked' };
  }

  // shell.openPath returns '' on success, error-string on failure. Map the
  // non-empty return to `resolve-error` so the renderer can log + surface.
  // Note: `openPath` doesn't reject the promise — consumers must inspect
  // the return value (this is the `openPath` vs `openExternal` asymmetry
  // called out in the Electron docs).
  const osError = await deps.openPath(contained.canonical);
  if (osError !== '') {
    return { ok: false, reason: 'resolve-error' };
  }
  return { ok: true };
}

/**
 * Main-process handler for `ok:shell:reveal-asset`. Opens the native file
 * manager pointed at the parent directory — no OS content-handler dispatch,
 * so executable-blocklist doesn't apply (blocklist scope is `openPath` only).
 */
export async function revealAssetSafely(
  deps: RevealAssetDeps,
  relPath: string,
): Promise<AssetRevealResult> {
  const resolveCanonical = deps.resolveCanonical ?? defaultResolveCanonical;
  const statExists = deps.statExists ?? defaultStatExists;

  const contained = resolveAndContain(
    relPath,
    deps.projectPath,
    deps.platform,
    resolveCanonical,
    statExists,
  );
  if (!contained.ok) return contained;

  // showItemInFolder returns void; Electron's docs note "the item doesn't
  // have to exist" on Windows but does on macOS. We've already statExists-
  // checked above so the behavior is uniform across platforms.
  deps.showItemInFolder(contained.canonical);
  return { ok: true };
}
