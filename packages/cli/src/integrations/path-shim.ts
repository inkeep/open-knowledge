/**
 * The PATH-shim contract — shared by the DESKTOP installer (which writes the
 * shim) and the CLI reverter (which removes it for `ok uninstall`).
 *
 * The desktop app (macOS packaged only) puts `ok` on the user's PATH by:
 *   - symlinking `~/.ok/bin/{ok,open-knowledge}` at the app's CLI wrapper,
 *   - writing `~/.ok/env.sh` (prepends `~/.ok/bin` to PATH),
 *   - injecting a fenced managed block into each shell rc file that sources
 *     `~/.ok/env.sh`, and
 *   - recording every change in a manifest at
 *     `~/Library/Application Support/OpenKnowledge/path-install.json`.
 *
 * The install side lives in the desktop package (`main/path-install.ts`), which
 * imports the fence markers + marker path + marker shape FROM HERE so the
 * install and revert can never disagree about what a managed block looks like
 * or where the manifest lives. The CLI can't import desktop (the dependency
 * runs desktop→cli), so this — the lower layer both share — is the single
 * source of truth for the contract, and the home of the CLI-side revert.
 *
 * The revert itself is deliberately manifest-driven: it strips ONLY the recorded
 * rc files' managed blocks and removes ONLY the recorded extra symlinks (and
 * only while they still point at the recorded target), so a user's own PATH
 * lines and unrelated `ok`-named binaries are never touched.
 */

import {
  existsSync as fsExistsSync,
  lstatSync as fsLstatSync,
  readFileSync as fsReadFileSync,
  readlinkSync as fsReadlinkSync,
} from 'node:fs';
import { join } from 'node:path';

/** Fence opening the managed block in a shell rc file. */
export const PATH_SHIM_BEGIN = '# >>> open-knowledge cli >>>';
/** Fence closing the managed block. */
export const PATH_SHIM_END = '# <<< open-knowledge cli <<<';
/**
 * Matches the whole fenced managed block (fence-to-fence, incl. its trailing
 * newline). Multiline + non-greedy so a file with the block anywhere — and only
 * that block — is stripped. IDENTICAL to the install-side `BLOCK_RE`; the two
 * MUST stay in lock-step, which is why both sides import this one constant.
 */
export const PATH_SHIM_BLOCK_RE =
  /^# >>> open-knowledge cli >>>\n[\s\S]*?^# <<< open-knowledge cli <<<\n?/m;

/** Diagnostic snapshot of the interactive PATH captured at install time. */
export interface PathDiscovery {
  capturedAt: string;
  pathEntries: string[];
  shellUsed: string;
  okBinAlreadyOnPath: boolean;
}

/**
 * The user's rc-append consent record. Additive on version-1 markers:
 * pre-consent markers carry no field, and older builds reading a marker with
 * the field ignore it. Absence means "no decision recorded" — the desktop
 * installer then falls back to grandfather evidence (a healthy managed block
 * already on disk ⇒ granted) or, with no evidence either, leaves the user's
 * rc files untouched until the first-launch consent dialog decides. The
 * revert ignores it (`ok uninstall` deletes the whole manifest).
 */
export interface PathInstallConsent {
  status: 'granted' | 'declined';
  at: string;
}

/**
 * The install manifest — the complete record of every PATH change, written to
 * `~/Library/Application Support/OpenKnowledge/path-install.json`. The revert
 * reads `rcFiles` (blocks to strip) and `extraSymlinks` (guarded removals);
 * `binDir` + `envShimPath` live under `~/.ok/` and are swept by the whole-dir
 * removal.
 */
export interface PathInstallMarker {
  version: 1;
  installedAt: string;
  bundleVersion: string;
  bundleWrapperPath: string;
  binDir: string;
  envShimPath: string;
  rcFiles: string[];
  /** Rc files the user stripped the managed block from — never written to
   *  again by the installer. */
  rcOptOuts: string[];
  pathDiscovery: PathDiscovery | null;
  extraSymlinks: Array<{
    path: string;
    target: string;
    createdAt: string;
    kind: 'created' | 'refreshed-our-own';
  }>;
  /** Rc-append consent record — see `PathInstallConsent`. `version` stays 1. */
  consent?: PathInstallConsent;
}

/** Absolute path to the PATH-install manifest (macOS layout — the shim is
 *  macOS-packaged-desktop only, so this path is where it is ever written). */
export function pathInstallMarkerPath(home: string): string {
  return join(home, 'Library', 'Application Support', 'OpenKnowledge', 'path-install.json');
}

/** Minimal fs surface the revert reads through (injectable for tests). */
export interface PathShimFsOps {
  existsSync(path: string): boolean;
  readFileSync(path: string, encoding: 'utf8'): string;
  lstatSync(path: string): { isSymbolicLink(): boolean };
  readlinkSync(path: string): string;
}

const defaultFsOps: PathShimFsOps = {
  existsSync: (path) => fsExistsSync(path),
  readFileSync: (path, encoding) => fsReadFileSync(path, encoding),
  lstatSync: (path) => fsLstatSync(path),
  readlinkSync: (path) => fsReadlinkSync(path),
};

/**
 * Read + validate the install manifest, returning `null` when it is absent,
 * unreadable, malformed, or an unknown version — every not-ours case degrades
 * to "no PATH shim recorded", so the revert simply finds nothing to strip
 * (matching the installer's own `readMarker` tolerance).
 */
export function readPathInstallMarker(
  home: string,
  fs: PathShimFsOps = defaultFsOps,
): PathInstallMarker | null {
  const path = pathInstallMarkerPath(home);
  if (!fs.existsSync(path)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(path, 'utf8')) as PathInstallMarker;
    return parsed?.version === 1 ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Strip the managed block from an rc file's text, byte-preserving everything
 * else (same discipline as the git-exclude removal — remove only what is ours).
 *
 * `emptyAfter` is true when nothing but whitespace remains: the caller deletes
 * the file outright rather than leave a blank one. This is what removes the
 * OK-OWNED fish conf file (`~/.config/fish/conf.d/open-knowledge.fish`, whose
 * entire contents are the block) while a user's own `~/.zshrc` — which keeps
 * its other lines — is written back with only the block gone.
 */
export function stripManagedPathBlock(text: string): {
  text: string;
  changed: boolean;
  emptyAfter: boolean;
} {
  const next = text.replace(PATH_SHIM_BLOCK_RE, '');
  return { text: next, changed: next !== text, emptyAfter: next.trim() === '' };
}

/**
 * True iff `path` is a symlink still pointing at `target` — the guard the
 * installer's own cleanup uses before removing a recorded extra symlink. A
 * re-pointed or replaced entry (no longer ours) or a missing one returns false,
 * so the revert never unlinks a binary that isn't the one it created.
 */
export function extraSymlinkStillOurs(
  path: string,
  target: string,
  fs: PathShimFsOps = defaultFsOps,
): boolean {
  try {
    if (!fs.lstatSync(path).isSymbolicLink()) return false;
    return fs.readlinkSync(path) === target;
  } catch {
    return false;
  }
}
