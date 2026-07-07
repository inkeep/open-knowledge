/**
 * Unified content filter — encapsulates exclusion logic in one module.
 *
 * Pattern sources, all unioned in a single `ignore`-lib instance so cross-source
 * `!`-negation works (e.g. a `!secret.md` line in `.okignore` re-includes a
 * file that `.gitignore` excluded):
 *   - root `.gitignore` (project-relative)
 *   - root `.okignore`  (project-relative)
 *   - nested `.gitignore` and `.okignore` files at any folder depth
 *   - the `.git` directory (always excluded — `node-ignore` does not auto-add it)
 *
 * Extension gating happens upstream via `isSupportedDocFile()`
 * (`packages/server/src/doc-extensions.ts`); exclusions live in `.okignore`
 * (no YAML include/exclude keys).
 *
 * Used by the file watcher to decide which files belong in the content index
 * and by the CLI preview helper to enumerate the same set without booting the
 * server.
 */

import { execFile as execFileCb, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { readdir, readFile as readFileAsync } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import { LINKABLE_ASSET_EXTENSIONS, SKILL_CONTENT_ROOT } from '@inkeep/open-knowledge-core';
import ignore, { type Ignore } from 'ignore';
import { isReservedForUserTree } from './cc1-broadcast.ts';
import { isSupportedDocFile, stripDocExtension } from './doc-extensions.ts';
import { getLogger } from './logger.ts';
import { toPosix } from './path-utils.ts';
import { withSpan } from './telemetry.ts';

const execFileAsync = promisify(execFileCb);

/**
 * Directories that are always skipped during traversal, independent of
 * `.gitignore` / `.okignore`.
 *
 * Criteria: never contains user-authored markdown AND either (a) uses symlinks
 * aggressively, (b) is a massive tree, or (c) is a framework/tool cache.
 *
 * Package managers / language runtimes:
 *   node_modules  — pnpm broken symlinks crash statSync; massive tree
 *   .venv / venv / env — Python virtualenvs
 *   __pycache__   — Python bytecode
 *   vendor        — Go / PHP / Ruby vendored deps
 *
 * Build output:
 *   dist / build / out / output — compiled assets
 *   .next / .nuxt / .svelte-kit / .astro — framework build caches
 *   .turbo / .cache / .parcel-cache     — build tool caches
 *   coverage                            — test coverage reports
 *
 * VCS / per-project state:
 *   .git — already in the ig instance; hardcoded here for the fast-path
 *   .ok  — per-project state dir; the committed `.ok/.gitignore` already
 *          self-ignores its contents for git, but adding it here lets the
 *          walker skip the descent entirely
 *   .open-knowledge / .openknowledge — legacy per-project state dirs from
 *          pre-rename OK versions (≤v0.3.0). Kept in the skip set so any
 *          residue left on disk in user content dirs stays out of the
 *          sidebar even though the codebase no longer writes to them.
 *
 * OS-managed directories (macOS):
 *   Library     — application data, caches, preferences; ~macOS only but safe
 *                 to skip on all platforms (no project ever authors markdown here)
 *   Applications — macOS app bundles; never user markdown
 *   .Trash      — OS recycle bin; symlink-heavy, contents irrelevant
 */
const BUILTIN_SKIP_DIRS = new Set([
  // Package managers / language runtimes
  'node_modules',
  '.venv',
  'venv',
  'env',
  '__pycache__',
  'vendor',
  // Build output
  'dist',
  'build',
  'out',
  'output',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.astro',
  '.turbo',
  '.cache',
  '.parcel-cache',
  'coverage',
  // VCS / per-project state
  '.git',
  '.ok',
  '.open-knowledge',
  '.openknowledge',
  // Editor host dirs — hold OK's skill PROJECTIONS (`.{editor}/skills/<name>/`)
  // plus MCP config / launch.json. OK-managed tool artifacts, never KB content,
  // so skill projections stay out of the note/content index.
  '.claude',
  '.cursor',
  '.codex',
  '.agents',
  '.opencode',
  // OS-managed (macOS)
  'Library',
  'Applications',
  '.Trash',
]);

/**
 * Directories pruned even when `bypassFilters: true` (the Show All Files
 * toggle). A deliberate STRICT SUBSET of `BUILTIN_SKIP_DIRS`: VCS internals,
 * dependency trees, and OK's own per-project state — none ever hold
 * user-authored markdown, and each is large/symlink-heavy enough that walking
 * it under Show All Files on a repo-root content dir exhausts the heap (a
 * multi-GB `.git` object store, thousands of nested `node_modules`).
 *
 * Excludes content-bearing-but-gitignored dirs (`dist`, `build`, `coverage`,
 * `.venv`, …) on purpose — Show All Files exists to surface those, so the
 * floor must not prune them. Bypass still admits everything outside this set.
 */
const ALWAYS_SKIP_DIRS = new Set<string>([
  '.git',
  'node_modules',
  '.ok',
  '.open-knowledge',
  '.openknowledge',
  // Editor host dirs hold OK's skill projections — OK-managed tool artifacts,
  // never user content, kept out of even the Show All Files walk.
  '.claude',
  '.cursor',
  '.codex',
  '.agents',
  '.opencode',
]);

/**
 * True when any segment of `relativePath` is an always-skip directory. Called
 * before the `bypassFilters` early-return in every exclusion predicate so the
 * floor holds regardless of caller (including the `?showAll=true` disk walk).
 */
function pathHasAlwaysSkipSegment(relativePath: string): boolean {
  for (const segment of relativePath.split('/')) {
    if (ALWAYS_SKIP_DIRS.has(segment)) return true;
  }
  return false;
}

/**
 * The ONE carve-out from the blanket `.ok/` exclusion: project skills live at
 * `.ok/skills/<name>/**` and are real indexed content (skills-as-content). Every
 * `.ok` exclusion site consults these so skill files reach the index / tree /
 * asset serving, while the rest of `.ok/` stays hidden. Paths are contentDir-
 * relative, '/'-joined, no leading slash. Project scope only — global skills
 * live under `~/.ok/skills`, served by the dedicated global route, not the
 * content index. `SKILL_CONTENT_ROOT` is the shared `.ok/skills` constant from
 * core (single source of truth across app + server).
 */

/** True for a FILE under `.ok/skills/<name>/...` (at least one segment past the root). */
function isSkillContentFile(relativePath: string): boolean {
  return relativePath.startsWith(`${SKILL_CONTENT_ROOT}/`);
}

/**
 * True for the directories that must stay DESCENDABLE so a tree walk reaches
 * skill files: `.ok` itself (to get to `.ok/skills`), `.ok/skills`, and anything
 * under it. `.ok` is descendable but does NOT admit its other children — the
 * file-level predicates still exclude `.ok/local`, `.ok/templates`, etc.
 */
function isSkillContentAncestorDir(relativePath: string): boolean {
  return (
    relativePath === '.ok' ||
    relativePath === SKILL_CONTENT_ROOT ||
    relativePath.startsWith(`${SKILL_CONTENT_ROOT}/`)
  );
}

/**
 * True for a watcher-ignore glob that would stop the OS file-watcher from
 * seeing `.ok/skills/**`. The watcher-ignore list is glob-derived from
 * `.gitignore` / `.okignore` / `.git/info/exclude` (e.g. clone appends `.ok/`),
 * and the @parcel/watcher backend consults THESE globs — not the function
 * predicates (`isDirExcluded` / `isExcluded`) that carry the skills-as-content
 * carve-out and that the chokidar backend uses. So a blanket `.ok` ignore glob
 * makes parcel (the default backend on Linux) never deliver external edits to
 * project skills. Dropping the blanket-`.ok` globs lets the watcher reach
 * `.ok/skills`; the non-skill `.ok` children (`.ok/local`, `.ok/templates`, …)
 * are still pruned downstream by the function predicates in `handleRawEvents`,
 * so they never reach the index. A more specific glob like `.ok/local` does NOT
 * block the skill tree and is kept.
 */
function globBlocksSkillContent(pattern: string): boolean {
  const p = pattern.replace(/^\/+/, '').replace(/\/+$/, '').trim();
  return p === '.ok' || p === '.ok/**' || p === '**/.ok' || p === '**/.ok/**';
}

/**
 * File basenames that are pure OS-metadata junk — never user-authored content,
 * useful in no mode. The file-level analogue of `ALWAYS_SKIP_DIRS`: pruned even
 * under `bypassFilters: true`. The seeded `.gitignore` (`init-project.ts`)
 * already keeps these out of the normal index-backed sidebar, but the Show All
 * Files walk runs with `bypassFilters: true` — it skips `.gitignore` /
 * `.okignore` precisely so gitignored content (`dist/`, `build/`, …) surfaces —
 * which would otherwise re-surface `.DS_Store` as a sidebar `asset` row. macOS
 * is the only supported platform, so this is macOS Finder metadata.
 */
const BUILTIN_SKIP_FILES = new Set<string>(['.DS_Store', '.localized']);

/**
 * True when the basename of `relativePath` is an always-skip junk file. Checked
 * before the `bypassFilters` early-return in the file-level predicates so the
 * floor holds even for the `?showAll=true` disk walk. Basename-only (these are
 * always files, never directories), so a sibling dir of the same name — which
 * never occurs in practice — is left to the directory predicates.
 */
function isAlwaysSkipFile(relativePath: string): boolean {
  return BUILTIN_SKIP_FILES.has(relativePath.slice(relativePath.lastIndexOf('/') + 1));
}

/**
 * Directories that conventionally hold private keys / credentials. Pruned at
 * the always-skip floor (before any user gitignore rule and before the
 * `bypassFilters` early-return) so a user who hasn't gitignored their home
 * `.ssh/` after pointing OK at it never sees private-key names egress through
 * `/api/documents` or the search corpus. Body content is never read for these
 * — `kind:'file'` admission is name/path only — so the egress surface is the
 * name itself. Show All Files inherits the skip via `isExcluded` / `isDirExcluded`.
 */
const SECRET_BEARING_DIRS = new Set(['.ssh', '.aws', '.gnupg', '.kube', '.docker']);

/**
 * True when any segment of `relativePath` is a conventional secret-bearing
 * directory. Run alongside `pathHasAlwaysSkipSegment` in the always-skip floor
 * of `isExcluded` / `isDirExcluded` / `isPathIgnored`.
 */
function pathHasSecretBearingDirSegment(relativePath: string): boolean {
  // Case-insensitive for the same reason as isSecretBearingFile: a `.SSH` /
  // `.AWS` directory on a case-insensitive filesystem must still prune.
  for (const segment of relativePath.split('/')) {
    if (SECRET_BEARING_DIRS.has(segment.toLowerCase())) return true;
  }
  return false;
}

/**
 * True when the basename of `relativePath` matches a conventional secret-
 * bearing file pattern:
 *   - `.env` / `.env.<anything>`
 *   - SSH private keys: `id_rsa*` / `id_ed25519*` / `id_ecdsa*` / `id_dsa*`
 *     (any extension, including bare keys at root; the `.ssh` directory
 *     bucket above catches the conventional placement but a stray bare
 *     `id_ed25519` at the workspace root would otherwise leak)
 *   - AWS shared credentials: `credentials`
 *   - Common credential shapes: `.netrc`, `.npmrc`, `.pgpass`,
 *     `.git-credentials`
 *   - Cert/keystore suffixes: `.pem`, `.key`, `.p12`, `.pfx`, `.keystore`,
 *     `.jks`, `.ppk` (case-insensitive — agents may write `.PEM`)
 *
 * Defense-in-depth above user gitignore: an unconfigured workspace that
 * hasn't listed `.env` would otherwise leak the filename via
 * `/api/documents` and `/api/search` (the HTTP API is local +
 * unauthenticated; `host` is configurable). Bodies are never read for
 * `kind:'file'` entries, so the leak surface is the path itself — that is
 * what this floor closes.
 */
const SECRET_CREDENTIAL_BASENAMES = new Set([
  'credentials',
  '.netrc',
  '.npmrc',
  '.pgpass',
  '.git-credentials',
]);
const SECRET_KEY_SUFFIXES = ['.pem', '.key', '.p12', '.pfx', '.keystore', '.jks', '.ppk'] as const;
function isSecretBearingFile(relativePath: string): boolean {
  // Match case-insensitively throughout. On a case-insensitive filesystem
  // (default macOS) the watcher reports the on-disk casing, so a stray
  // `.ENV` / `ID_RSA` / `CREDENTIALS` would otherwise slip past these
  // basename checks and leak through `/api/documents` + `/api/search`.
  // `SECRET_CREDENTIAL_BASENAMES` / `SECRET_KEY_SUFFIXES` are already lowercase.
  const lower = relativePath.slice(relativePath.lastIndexOf('/') + 1).toLowerCase();
  if (lower === '.env' || lower.startsWith('.env.')) return true;
  if (SECRET_CREDENTIAL_BASENAMES.has(lower)) return true;
  if (
    lower.startsWith('id_rsa') ||
    lower.startsWith('id_ed25519') ||
    lower.startsWith('id_ecdsa') ||
    lower.startsWith('id_dsa')
  ) {
    return true;
  }
  for (const suffix of SECRET_KEY_SUFFIXES) {
    if (lower.endsWith(suffix)) return true;
  }
  return false;
}

/**
 * True when `relativeDir` is an ancestor directory of `singleDocRelPath` (or
 * is the target's own directory). Used by the single-file scope so traversal
 * descends only the chain of directories leading to the one admitted doc.
 * For a bare-basename target (`notes.md`) no directory is an ancestor, so
 * every subdirectory is pruned.
 */
function isSingleDocAncestorDir(relativeDir: string, singleDocRelPath: string): boolean {
  return singleDocRelPath === relativeDir || singleDocRelPath.startsWith(`${relativeDir}/`);
}

/** File names recognized as ignore-pattern sources, in load order. */
const IGNORE_FILE_NAMES = ['.gitignore', '.okignore'] as const;

/**
 * Resolve the patterns `git add` would honor *beyond* the project's
 * `.gitignore` tree: the per-clone `<git-common-dir>/info/exclude` (where
 * `ensureOkExcludedFromGit` itself writes `.ok/`), and the user's
 * `core.excludesfile` — or, when that is unset, git's documented
 * `$XDG_CONFIG_HOME/git/ignore` fallback.
 *
 * Mirroring these into `ContentFilter` keeps the sync walker and `git add`
 * agreed on scope (precedent #55). Without it, the walker can gather a
 * file `.git/info/exclude` already disqualifies, and the next push-cycle
 * `git add -- <path>` errors with `addIgnoredFile`.
 *
 * Gated on the `git rev-parse --git-common-dir` probe succeeding: when
 * `projectDir` isn't a git repo, `git add` is never called and there's no
 * symmetry to maintain — both `.git/info/exclude` AND the global
 * excludesfile are skipped, so non-git OK vaults aren't silently filtered
 * by the user's host-wide git rules.
 *
 * Returns the combined pattern list, or [] when none are reachable
 * (non-git dirs, `git` missing from PATH, files unreadable). All failures
 * are silent — the rest of the filter pipeline (project `.gitignore` +
 * `.okignore`) continues to apply.
 */
function loadGitExcludeSources(projectDir: string, bytesAcc: { value: number }): string[] {
  const commonDir = readGitCommonDirSync(projectDir);
  if (commonDir === null) return [];

  const patterns: string[] = [];
  appendExcludeFileIfExists(join(commonDir, 'info', 'exclude'), bytesAcc, patterns, 'info/exclude');

  const globalExcludePath = resolveGlobalExcludesfileSync(projectDir);
  if (globalExcludePath) {
    appendExcludeFileIfExists(globalExcludePath, bytesAcc, patterns, 'global excludesfile');
  }

  return patterns;
}

/**
 * Async sibling of `loadGitExcludeSources`. Uses `execFile`-via-Promise +
 * `readFileAsync` so callers inside `createContentFilterAsync` don't pay
 * `spawnSync`'s event-loop-blocking cost during boot.
 */
async function loadGitExcludeSourcesAsync(
  projectDir: string,
  bytesAcc: { value: number },
): Promise<string[]> {
  const commonDir = await readGitCommonDirAsync(projectDir);
  if (commonDir === null) return [];

  const patterns: string[] = [];
  await appendExcludeFileIfExistsAsync(
    join(commonDir, 'info', 'exclude'),
    bytesAcc,
    patterns,
    'info/exclude',
  );

  const globalExcludePath = await resolveGlobalExcludesfileAsync(projectDir);
  if (globalExcludePath) {
    await appendExcludeFileIfExistsAsync(
      globalExcludePath,
      bytesAcc,
      patterns,
      'global excludesfile',
    );
  }

  return patterns;
}

function readGitCommonDirSync(projectDir: string): string | null {
  const probe = spawnSync('git', ['rev-parse', '--git-common-dir'], {
    cwd: projectDir,
    encoding: 'utf-8',
    timeout: 5_000,
  });
  if (probe.status !== 0 || !probe.stdout) return null;
  return resolve(projectDir, probe.stdout.trim());
}

async function readGitCommonDirAsync(projectDir: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', '--git-common-dir'], {
      cwd: projectDir,
      encoding: 'utf-8',
      timeout: 5_000,
    });
    if (!stdout) return null;
    return resolve(projectDir, stdout.trim());
  } catch {
    return null;
  }
}

/**
 * Per git docs: when `core.excludesfile` is unset, git uses
 * `$XDG_CONFIG_HOME/git/ignore`, defaulting to `$HOME/.config/git/ignore`.
 *
 * `--type=path` asks git to apply its own path expansion (tilde forms only —
 * `~/foo` → `$HOME/foo`, `~user/foo` → user's home), matching git's
 * documented `core.excludesfile` semantics exactly. Available since Git 2.18.
 * Doing the expansion in JS would let a `$VAR` reference resolve here but
 * not in `git add` — re-introducing the very asymmetry this loader exists
 * to prevent.
 */
function resolveGlobalExcludesfileSync(projectDir: string): string | null {
  const configProbe = spawnSync('git', ['config', '--get', '--type=path', 'core.excludesfile'], {
    cwd: projectDir,
    encoding: 'utf-8',
    timeout: 5_000,
  });
  if (configProbe.status === 0 && configProbe.stdout) {
    const raw = configProbe.stdout.trim();
    if (raw) return raw;
  }
  return xdgGlobalIgnoreDefault();
}

async function resolveGlobalExcludesfileAsync(projectDir: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['config', '--get', '--type=path', 'core.excludesfile'],
      { cwd: projectDir, encoding: 'utf-8', timeout: 5_000 },
    );
    const raw = stdout.trim();
    if (raw) return raw;
  } catch {
    // Unset / non-zero exit: fall through to XDG default.
  }
  return xdgGlobalIgnoreDefault();
}

function xdgGlobalIgnoreDefault(): string {
  const xdg = process.env.XDG_CONFIG_HOME?.trim();
  const base = xdg && xdg.length > 0 ? xdg : join(homedir(), '.config');
  return join(base, 'git', 'ignore');
}

function appendExcludeFileIfExists(
  path: string,
  bytesAcc: { value: number },
  patterns: string[],
  label: string,
): void {
  if (!existsSync(path)) return;
  try {
    const content = readFileSync(path, 'utf-8');
    bytesAcc.value += content.length;
    patterns.push(...parseIgnorePatterns(content));
  } catch (err) {
    console.warn(`[content-filter] Failed to read ${label} at ${path}:`, err);
  }
}

async function appendExcludeFileIfExistsAsync(
  path: string,
  bytesAcc: { value: number },
  patterns: string[],
  label: string,
): Promise<void> {
  if (!existsSync(path)) return;
  try {
    const content = await readFileAsync(path, 'utf-8');
    bytesAcc.value += content.length;
    patterns.push(...parseIgnorePatterns(content));
  } catch (err) {
    console.warn(`[content-filter] Failed to read ${label} at ${path}:`, err);
  }
}

export interface ContentFilterOptions {
  /** Project root directory (where `.gitignore` / `.okignore` live). */
  projectDir: string;
  /** Content directory to serve files from (may equal projectDir). */
  contentDir: string;
  /**
   * Single-file content scope (no-project ephemeral mode). When set to a
   * contentDir-relative path, the filter admits ONLY that one document:
   * `isExcluded` returns `true` for every path except `singleDocRelPath`, and
   * `isDirExcluded` returns `true` for every directory that is not an ancestor
   * of the target (so the watcher/index walks prune the rest of the tree
   * instead of just per-entry filtering). The full-tree `populateDirCount`
   * walk is skipped entirely — its only purpose is sibling-asset admission,
   * which the single-file path seeds with a bounded one-dir scan instead.
   *
   * `isPathIgnored` is DELIBERATELY left unscoped (only the security-boundary
   * checks apply) so that `![](sibling.png)` / `![[sibling]]` assets the one
   * doc references still serve — the asset-serve middleware consults
   * `isPathIgnored`, not `isExcluded`.
   */
  singleDocRelPath?: string;
  /**
   * Optional callback fired AFTER a successful in-place rebuild via
   * `rebuildIgnorePatterns()`. The caller wires backlink-index and tag-index
   * `rebuildFromDisk()` / `init()` here so derived views re-derive against
   * the new visible set. ContentFilter intentionally does NOT import those
   * indexes — keeping the dependency arrow one-way.
   *
   * Throws from the callback are logged but do NOT roll back the rebuild.
   */
  onAfterRebuild?: () => void;
}

/**
 * Result of `rebuildIgnorePatterns()`. Discriminated by `ok`.
 *
 * Success branch carries bounded-cardinality counts the caller can forward to
 * span attributes / metrics. Error branch carries the message only — caller
 * (server boot wiring) is responsible for translating it into a CC1
 * `config-ignore-nested-error` payload + counter increment.
 */
export type RebuildResult =
  | {
      ok: true;
      /** Number of root-level patterns (`.gitignore` + root `.okignore`). */
      patternCount: number;
      /** Number of nested ignore files successfully loaded under contentDir. */
      nestedFileCount: number;
      /** Total bytes read across all loaded ignore files. */
      bytes: number;
      /** Wall-clock duration of the rebuild in milliseconds. */
      durationMs: number;
    }
  | {
      ok: false;
      error: { message: string };
    };

/**
 * Read-method opts shared by the three exclusion predicates. `bypassFilters:
 * true` skips user-configurable rules (`.gitignore` / `.okignore` /
 * `BUILTIN_SKIP_DIRS`) but PRESERVES the synthetic system + config doc gate
 * (STOP rule — even in bypass mode, `__system__` / `__config__` /
 * `__user__` / `__local__` doc names MUST stay hidden). Per-request use
 * only — backs the `?showAll=true` flag on `GET /api/documents`.
 */
interface ContentFilterReadOpts {
  bypassFilters?: boolean;
}

export interface ContentFilter {
  /** True if the file at relativePath should be excluded from the document system. */
  isExcluded(relativePath: string, opts?: ContentFilterReadOpts): boolean;
  /**
   * True if the directory at relativePath is excluded by ignore-file rules.
   * Used for traversal decisions.
   */
  isDirExcluded(relativePath: string, opts?: ContentFilterReadOpts): boolean;
  /**
   * True if the file at relativePath is excluded purely by user-configured
   * ignore-file rules (`.gitignore` / `.okignore`) or `BUILTIN_SKIP_DIRS`.
   *
   * Unlike `isExcluded`, this does NOT apply the sibling-asset admission
   * heuristic. Use this when the caller already knows a path is a
   * legitimate referenced asset and only needs the security boundary check
   * (for example `collectReferencedAssets` and `handleAsset`, which must
   * honor user-rejected paths but should not drop assets that live in a
   * directory without a sibling `.md` file).
   */
  isPathIgnored(relativePath: string, opts?: ContentFilterReadOpts): boolean;
  /** Relative glob patterns for @parcel/watcher ignore option (best-effort). */
  getWatcherIgnoreGlobs(): string[];
  /** Increment refcount for a directory containing an included .md file. */
  incrementMdDir(dir: string): void;
  /** Decrement refcount for a directory; removes key when count reaches 0. */
  decrementMdDir(dir: string): void;
  /**
   * Re-walk contentDir from scratch and rebuild the refcount map used by the
   * sibling-asset inclusion rule. Required after operations that mutate the
   * working tree without going through the file-watcher's `incrementMdDir` /
   * `decrementMdDir` path — most notably cross-branch `git checkout`, where
   * the head-watcher's `eventBuffer.splice` discards the create/delete events
   * that would have kept the count current.
   */
  rebuildDirCount(): void;
  /**
   * Re-read root + nested `.gitignore` / `.okignore` files and replace the
   * internal `ignore`-lib instance, watcher-glob list, and sibling-asset
   * refcount map IN PLACE on the existing object. Downstream consumers
   * (backlink-index, tag-index) hold live references to this filter and read
   * the freshly-rebuilt state on their next call without further wiring.
   *
   * Wraps the rebuild in a `config.ignore.rebuild` span with bounded-
   * cardinality attributes (`ok.ignore.pattern_count`,
   * `ok.ignore.nested_file_count`, `ok.ignore.bytes`).
   *
   * On any unforeseen error during the rebuild, rolls back to the previous
   * state and returns `{ ok: false }`. The caller decides whether to emit
   * CC1 / increment `ok.config.ignore.rejection_total`.
   *
   * Calls `onAfterRebuild` (if supplied at construction) only on success.
   */
  rebuildIgnorePatterns(): Promise<RebuildResult>;
}

/**
 * Create a ContentFilter that applies `.gitignore` + `.okignore` rules in a
 * single unified `ignore`-lib instance. Extensions are gated upstream by
 * `isSupportedDocFile()`; this filter handles only path-pattern exclusion plus
 * the sibling-asset rule that admits assets next to included `.md`.
 */
export function createContentFilter(opts: ContentFilterOptions): ContentFilter {
  const { projectDir, contentDir, onAfterRebuild, singleDocRelPath } = opts;

  // Precompute the contentDir-to-projectDir prefix for path conversion.
  // When contentDir is outside projectDir, the relative path starts with ".."
  // and the `ignore` library rejects such paths. Skip ignore-based exclusion
  // entirely in that case — ignore rules from projectDir do not apply.
  const contentRelPrefix = toPosix(relative(projectDir, contentDir));
  const contentOutsideProject = contentRelPrefix.startsWith('..');

  // --- Mutable per-build state ---
  // Captured by the closure-bound API below. Replaced atomically on
  // `rebuildIgnorePatterns()` so live references on consumers stay valid.
  let ig: Ignore;
  let rootIgnorePatterns: string[];
  let watcherIgnoreGlobs: string[];
  let lastPatternCount = 0;
  let lastNestedFileCount = 0;
  let lastBytes = 0;

  /**
   * Re-walk root + nested ignore files into a fresh state and atomically
   * swap it in. Called once at construction and again from
   * `rebuildIgnorePatterns()`. Returns the per-build counts for telemetry.
   *
   * Per-file read errors are silent-caught (matching the pre-rebuild boot
   * semantics so cold start never aborts on a single bad file).
   */
  function buildPatternState(): {
    patternCount: number;
    nestedFileCount: number;
    bytes: number;
  } {
    const newIg = ignore();

    // Always exclude .git directory itself
    newIg.add('.git');

    const newRootPatterns: string[] = [];
    let bytes = 0;
    let nestedFileCount = 0;

    // Pass 1: Bootstrap with root .gitignore + .okignore
    for (const name of IGNORE_FILE_NAMES) {
      const path = join(projectDir, name);
      if (!existsSync(path)) continue;
      try {
        const content = readFileSync(path, 'utf-8');
        bytes += content.length;
        const patterns = parseIgnorePatterns(content);
        newRootPatterns.push(...patterns);
        newIg.add(patterns);
      } catch (err) {
        console.warn(`[content-filter] Failed to read ${name} at ${path}:`, err);
      }
    }

    // Pass 2a: contentDir-level files when contentDir != projectDir
    if (contentRelPrefix && !contentOutsideProject) {
      for (const name of IGNORE_FILE_NAMES) {
        const path = join(contentDir, name);
        if (!existsSync(path)) continue;
        try {
          const content = readFileSync(path, 'utf-8');
          bytes += content.length;
          nestedFileCount++;
          const patterns = parseIgnorePatterns(content);
          const prefixed = patterns.map((p) => prefixPattern(p, contentRelPrefix));
          newIg.add(prefixed);
        } catch (err) {
          console.warn(`[content-filter] Failed to read ${name} at ${path}:`, err);
        }
      }
    }

    // Pass 2b: Recursive nested files
    const bytesAcc = { value: bytes };
    nestedFileCount += loadNestedIgnoreFiles(contentDir, projectDir, newIg, bytesAcc);
    bytes = bytesAcc.value;

    // Pass 3: per-clone `.git/info/exclude` + global excludesfile (XDG-default
    // fallback). Same admission set git itself consults; without them the
    // sync walker can hand `git add` paths the next stage will reject
    // (precedent #55).
    const gitExcludePatterns = loadGitExcludeSources(projectDir, bytesAcc);
    bytes = bytesAcc.value;
    if (gitExcludePatterns.length > 0) {
      newRootPatterns.push(...gitExcludePatterns);
      newIg.add(gitExcludePatterns);
    }

    // Watcher-ignore globs derived from root patterns (best-effort).
    // Skip negation (!) and comment (#) lines — they aren't directly usable
    // as fast-path globs for the OS watcher.
    const newWatcherGlobs = newRootPatterns.filter(
      (p) => p.length > 0 && !p.startsWith('!') && !p.startsWith('#') && !globBlocksSkillContent(p),
    );

    // Atomic swap.
    ig = newIg;
    rootIgnorePatterns = newRootPatterns;
    watcherIgnoreGlobs = newWatcherGlobs;
    lastPatternCount = newRootPatterns.length;
    lastNestedFileCount = nestedFileCount;
    lastBytes = bytes;

    return {
      patternCount: lastPatternCount,
      nestedFileCount: lastNestedFileCount,
      bytes: lastBytes,
    };
  }

  // Initial build at construction time.
  buildPatternState();

  const dirCount = new Map<string, number>();

  function isIgnored(relativePath: string): boolean {
    // When contentDir is outside projectDir, ignore rules from projectDir
    // do not apply — and the `ignore` library rejects paths starting with `..`.
    if (contentOutsideProject) return false;
    const projectRelPath = contentRelPrefix ? `${contentRelPrefix}/${relativePath}` : relativePath;
    return ig.ignores(projectRelPath);
  }

  // Single-file mode skips the full-tree refcount walk: it walks the ENTIRE
  // contentDir synchronously (a stall + privacy leak on a large parent like
  // `~/` or `~/Downloads`), and its only job — sibling-asset admission via
  // `dirCount` — is unreachable because `isExcluded` short-circuits before the
  // sibling-asset branch. The single-file path seeds embeds with a bounded
  // one-dir scan instead (see server-factory). Every refcount (re)build routes
  // through this guard so a runtime rebuild can't reintroduce the walk.
  const refreshDirCount = (): void => {
    if (singleDocRelPath !== undefined) return;
    populateDirCount(contentDir, '', isIgnored, dirCount);
  };

  refreshDirCount();

  // Synthetic system + config doc gate. ALWAYS enforced — never bypassed,
  // even in `?showAll=true` mode (STOP rule: `__system__` /
  // `__config__/project` / `__user__/config.yml` / `__local__/project` and
  // `__config__/okignore` MUST stay hidden regardless of user toggles).
  function isReservedDocName(relativePath: string): boolean {
    const docName = stripDocExtension(relativePath);
    // system + config + managed-artifact (skill/template) docs are all hidden
    // from the user tree/search. (Tree-exclusion axis only — managed-artifact
    // docs still get the observer bridge; that gate lives elsewhere.)
    return isReservedForUserTree(docName);
  }

  // User-configurable path rules — `BUILTIN_SKIP_DIRS` + `.gitignore` /
  // `.okignore`. Bypassable via `opts.bypassFilters: true` to support the
  // Show All Files toggle. Separated from `isReservedDocName`
  // so the STOP-rule gate stays untouchable.
  function isRejectedByConfigurableRules(relativePath: string): boolean {
    // BUILTIN_SKIP_DIRS — must mirror isDirExcluded. The seed walk skips
    // these dirs at boot, but watcher events for files born inside them
    // (e.g. MCP `write({ template })` creating `<folder>/.ok/templates/foo.md`)
    // reach classifyEvents and must be rejected here, otherwise they leak
    // into the file index and surface in the file tree.
    for (const segment of relativePath.split('/')) {
      if (BUILTIN_SKIP_DIRS.has(segment)) return true;
    }

    // User-configured `.gitignore` / `.okignore` patterns. Skipped when
    // contentDir is outside projectDir (test-isolation): ignore rules
    // anchored at projectDir don't apply, and the `ignore` library rejects
    // paths that traverse upward.
    if (contentOutsideProject) return false;
    return isIgnored(relativePath);
  }

  return {
    isExcluded(relativePath: string, opts?: ContentFilterReadOpts): boolean {
      // (0) STOP-rule gate — always enforced, even in bypass mode.
      if (isReservedDocName(relativePath)) return true;

      // (0a) Secret-bearing-file floor — `.env*` / `id_rsa*` / `credentials`
      // / `*.pem` / `*.key` / `*.p12` AND any path under `.ssh` / `.aws` /
      // `.gnupg` stay excluded even under bypass. Defense-in-depth above
      // user gitignore: the HTTP API is local + unauthenticated, but `host`
      // is configurable — bound to `0.0.0.0`, a filename like
      // `aws-prod-root-key.pem` becomes network-reachable via /api/documents
      // and /api/search. Bodies are never read for `kind:'file'`, so the
      // exposure is name/path; this floor closes that egress surface.
      //
      // MUST precede the skills carve-out below: `.key` is both a secret suffix
      // AND an Apple-Keynote asset extension, so a `.ok/skills/foo/server.key`
      // adopted into a skill dir would otherwise be admitted as a linkable asset
      // before this floor runs. The secret floor wins over every other rule.
      if (isSecretBearingFile(relativePath)) return true;
      if (pathHasSecretBearingDirSegment(relativePath)) return true;

      // (0b) Skills-as-content carve-out — project skill files under
      // `.ok/skills/**` are real content. Admit supported docs + linkable
      // assets (no sibling-`.md` requirement), overriding the blanket `.ok`
      // exclusion below (always-skip floor + `.ok/.gitignore` self-ignore).
      // Other files (scripts, etc.) stay out of the content index — the Skills
      // section enumerates the folder directly and serves them via the text
      // route. Must precede the always-skip floor (which excludes any `.ok`).
      // Gated on `!bypassFilters` to mirror `isDirExcluded`'s skill-ancestor
      // carve-out: Show All Files prunes `.ok` at the directory level, so the
      // file-level carve-out must defer to the always-skip floor under bypass
      // too — otherwise a caller passing `bypassFilters` straight to `isExcluded`
      // on a `.ok/skills/...` path would get inconsistent admission.
      if (!opts?.bypassFilters && isSkillContentFile(relativePath)) {
        if (singleDocRelPath !== undefined) return relativePath !== singleDocRelPath;
        if (isSupportedDocFile(relativePath)) return false;
        const ext = extname(relativePath).slice(1).toLowerCase();
        return !LINKABLE_ASSET_EXTENSIONS.has(ext);
      }

      // (0c) Always-skip floor — VCS / dependency / OK-state dirs stay
      // excluded even under bypass. Defense-in-depth: the showAll walk gates
      // directories via `isDirExcluded`, but any caller enumerating files
      // directly must not admit `.git/` / `node_modules/` / `.ok/` content.
      if (pathHasAlwaysSkipSegment(relativePath)) return true;

      // (0c') Junk-file floor — `.DS_Store` / `.localized` stay excluded even
      // under bypass, so Show All Files never surfaces OS Finder metadata.
      if (isAlwaysSkipFile(relativePath)) return true;

      // (0d) Single-file scope — admit ONLY the one target doc, everything else
      // excluded. Placed before the bypass branch so the scope holds even under
      // `?showAll=true`. In ephemeral mode `contentOutsideProject` is true (the
      // temp projectDir sits elsewhere), so the ignore-based logic below is
      // inert anyway — this short-circuit is the sole admission gate.
      if (singleDocRelPath !== undefined) return relativePath !== singleDocRelPath;

      // (B) Bypass mode admits everything else (.gitignore + .okignore +
      // remaining BUILTIN_SKIP_DIRS skipped; extension + sibling-asset gates
      // also skipped so non-md/non-asset files like `package.json` / `LICENSE`
      // surface in the sidebar's Show All Files mode).
      if (opts?.bypassFilters) return false;

      // (1) Configurable path rules — BUILTIN_SKIP_DIRS + ignore patterns.
      if (isRejectedByConfigurableRules(relativePath)) return true;

      // (2) Supported doc extension → include.
      //     `isSupportedDocFile` is the upstream extension gate (`.md`/`.mdx`).
      //     Callers like file-watcher.ts already pre-filter, but cover it here
      //     so this filter behaves correctly when called in isolation.
      if (isSupportedDocFile(relativePath)) return false;

      // (3) Sibling-asset rule: extension in LINKABLE_ASSET_EXTENSIONS AND dir has an included doc.
      const ext = extname(relativePath).slice(1).toLowerCase();
      if (LINKABLE_ASSET_EXTENSIONS.has(ext)) {
        const dir = dirname(relativePath);
        const normalizedDir = dir === '.' ? '' : dir;
        if ((dirCount.get(normalizedDir) ?? 0) > 0) return false;
      }

      // (4) Default → exclude.
      return true;
    },

    isDirExcluded(relativePath: string, opts?: ContentFilterReadOpts): boolean {
      // Secret-bearing dir floor — `.ssh` / `.aws` / `.gnupg` are pruned at
      // the directory boundary so the watcher doesn't even descend into them,
      // independent of user gitignore. Mirrors the file-level secret floor;
      // without this, descending the dir still inserts file rows that the
      // file-level floor would later need to filter row-by-row. MUST precede the
      // skills carve-out: a secret dir nested under a skill (`.ok/skills/x/.ssh`)
      // would otherwise be kept descendable by the ancestor carve-out.
      if (pathHasSecretBearingDirSegment(relativePath)) return true;
      // Skills-as-content: keep `.ok`, `.ok/skills`, and `.ok/skills/**`
      // descendable so the NORMAL index walk reaches skill files; the file-level
      // predicates keep the rest of `.ok/` excluded. Gated on `!bypassFilters`:
      // under Show All Files the always-skip floor below must still prune `.ok`
      // (it's an internal dir, not user content — surfacing it as a folder broke
      // the showAll folder-listing contract and the hasFolders gate).
      if (!opts?.bypassFilters && isSkillContentAncestorDir(relativePath)) return false;
      // Always-skip floor — prune VCS / dependency / OK-state dirs even under
      // bypass. Show All Files must never descend into `.git/`, `node_modules/`,
      // or `.ok/`: on a repo-root content dir those trees (a multi-GB `.git`,
      // thousands of `node_modules`) make the recursive walk unbounded and
      // exhaust the heap. This single prune is the load-bearing OOM fix —
      // traversal, not file admission, is what blows up.
      if (pathHasAlwaysSkipSegment(relativePath)) return true;
      // Single-file scope — descend only the chain of directories leading to
      // the one admitted doc; prune everything else so the watcher seed +
      // index walks never enumerate siblings. Before the bypass branch so the
      // scope is absolute (the single-file sidebar is hidden, but defense in
      // depth keeps showAll honest).
      if (singleDocRelPath !== undefined) {
        return !isSingleDocAncestorDir(relativePath, singleDocRelPath);
      }
      // Bypass then admits every OTHER directory (Show All Files still surfaces
      // .gitignored content like `dist/` / `build/`). System-reserved doc names
      // never appear as real disk directories, so there's no parallel STOP-rule
      // gate here — the file-level `isReservedDocName` catches any leak at the
      // file (Hocuspocus document) admission boundary.
      if (opts?.bypassFilters) return false;
      // Fast-path: built-in skips are always excluded regardless of ignore-file config.
      // Check ALL path segments, not just the top — handles nested `.ok/` (per-folder
      // metadata directories), nested `node_modules/`, nested `dist/`, etc.
      for (const segment of relativePath.split('/')) {
        if (BUILTIN_SKIP_DIRS.has(segment)) return true;
      }
      if (contentOutsideProject) return false;
      const projectRelPath = contentRelPrefix
        ? `${contentRelPrefix}/${relativePath}`
        : relativePath;
      return ig.ignores(projectRelPath) || ig.ignores(`${projectRelPath}/`);
    },

    isPathIgnored(relativePath: string, opts?: ContentFilterReadOpts): boolean {
      // Same shape as `isExcluded` for the STOP gate + bypass branch but
      // without the sibling-asset admission step — admits referenced assets
      // in directories that happen to have no sibling `.md`.
      if (isReservedDocName(relativePath)) return true;
      // Secret-bearing floor — see `isExcluded` for rationale. Mirrored here
      // because `kind:'file'` admission flows through this predicate (the
      // asset-serve middleware gates on it), so missing it would make a secret
      // under a skill dir network-servable and leak secret filenames into the
      // all-files search corpus + `/api/documents`. MUST precede the skills
      // carve-out below (`.key` is both a secret suffix and an asset extension).
      if (isSecretBearingFile(relativePath)) return true;
      if (pathHasSecretBearingDirSegment(relativePath)) return true;
      // Skills-as-content: project skill files under `.ok/skills/**` are
      // servable content (asset-serve consults `isPathIgnored`). Admit them
      // before the `.ok` always-skip floor.
      if (isSkillContentFile(relativePath)) return false;
      if (pathHasAlwaysSkipSegment(relativePath)) return true;
      if (isAlwaysSkipFile(relativePath)) return true;
      if (opts?.bypassFilters) return false;
      return isRejectedByConfigurableRules(relativePath);
    },

    getWatcherIgnoreGlobs(): string[] {
      return watcherIgnoreGlobs;
    },

    incrementMdDir(dir: string): void {
      const normalizedDir = dir === '.' ? '' : dir;
      dirCount.set(normalizedDir, (dirCount.get(normalizedDir) ?? 0) + 1);
    },

    decrementMdDir(dir: string): void {
      const normalizedDir = dir === '.' ? '' : dir;
      const current = dirCount.get(normalizedDir) ?? 0;
      if (current <= 1) {
        dirCount.delete(normalizedDir);
      } else {
        dirCount.set(normalizedDir, current - 1);
      }
    },

    rebuildDirCount(): void {
      // Snapshot prior counts and restore on re-walk failure rather than
      // leaving dirCount empty — same defensive shape as the rollback
      // path below. Cross-branch checkout is the canonical caller and
      // can race with FS-level changes during the walk.
      const prev = new Map(dirCount);
      dirCount.clear();
      try {
        refreshDirCount();
      } catch (err) {
        for (const [k, v] of prev) dirCount.set(k, v);
        getLogger('content-filter').warn(
          { err: err instanceof Error ? err : new Error(String(err)) },
          'content-filter rebuildDirCount walk failed — retaining previous counts',
        );
      }
    },

    async rebuildIgnorePatterns(): Promise<RebuildResult> {
      const log = getLogger('content-filter');

      // Snapshot for rollback. dirCount is too large to snapshot — we re-walk
      // it from the rolled-back ig instance if rebuild fails partway.
      const prevIg = ig;
      const prevRootPatterns = rootIgnorePatterns;
      const prevWatcherGlobs = watcherIgnoreGlobs;
      const prevPatternCount = lastPatternCount;
      const prevNestedFileCount = lastNestedFileCount;
      const prevBytes = lastBytes;

      const startedAt = Date.now();

      return withSpan('config.ignore.rebuild', { attributes: {} }, async (span) => {
        try {
          const counts = buildPatternState();
          // Refresh sibling-asset counts against the new ignore rules.
          dirCount.clear();
          refreshDirCount();

          const durationMs = Date.now() - startedAt;
          span.setAttributes({
            'ok.ignore.pattern_count': counts.patternCount,
            'ok.ignore.nested_file_count': counts.nestedFileCount,
            'ok.ignore.bytes': counts.bytes,
          });
          log.info(
            {
              patternCount: counts.patternCount,
              nestedFileCount: counts.nestedFileCount,
              bytes: counts.bytes,
              durationMs,
            },
            'content-filter rebuild succeeded',
          );

          if (onAfterRebuild) {
            try {
              onAfterRebuild();
            } catch (err) {
              log.warn(
                { err: err instanceof Error ? err : new Error(String(err)) },
                'content-filter onAfterRebuild callback threw — derived views may be stale',
              );
            }
          }

          return {
            ok: true as const,
            patternCount: counts.patternCount,
            nestedFileCount: counts.nestedFileCount,
            bytes: counts.bytes,
            durationMs,
          };
        } catch (err) {
          // Roll back to previous state. The mutable bindings inside the
          // closure are restored so subsequent isExcluded / isDirExcluded
          // calls behave as if the rebuild never happened.
          ig = prevIg;
          rootIgnorePatterns = prevRootPatterns;
          watcherIgnoreGlobs = prevWatcherGlobs;
          lastPatternCount = prevPatternCount;
          lastNestedFileCount = prevNestedFileCount;
          lastBytes = prevBytes;
          // Re-derive dirCount from the rolled-back ig. If the re-walk
          // throws (e.g. contentDir went away between buildPatternState
          // failure and rollback), warn and continue — leaving dirCount
          // empty would cause every asset to read excluded via the
          // sibling-asset rule (children-count reads 0). Stale counts
          // until the next rebuild are strictly better than silently
          // hiding every image.
          dirCount.clear();
          try {
            refreshDirCount();
          } catch (rollbackErr) {
            log.warn(
              {
                err: rollbackErr instanceof Error ? rollbackErr : new Error(String(rollbackErr)),
              },
              'content-filter rollback dirCount re-walk failed — sibling-asset counts may be stale until next rebuild',
            );
          }

          const message = err instanceof Error ? err.message : String(err);
          log.warn(
            { err: err instanceof Error ? err : new Error(message) },
            'content-filter rebuild failed — rolled back to previous state',
          );
          return { ok: false as const, error: { message } };
        }
      });
    },
  };
}

/**
 * Walk contentDir to count included `.md`/`.mdx` files per directory.
 * Populates the refcount map used by the sibling-asset inclusion rule.
 */
function populateDirCount(
  dir: string,
  relPath: string,
  isIgnored: (path: string) => boolean,
  dirCount: Map<string, number>,
): void {
  let entries: import('node:fs').Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    // Mirror the diagnostic surface of `loadNestedIgnoreFiles` for the same
    // failure mode: silent skip would leave the sibling-asset refcount
    // under-counted with no operator trail.
    console.warn(`[content-filter] Failed to read directory for dir-count: ${dir}`, err);
    return;
  }
  for (const entry of entries) {
    const childRel = relPath ? `${relPath}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (BUILTIN_SKIP_DIRS.has(entry.name)) continue;
      if (isIgnored(childRel) || isIgnored(`${childRel}/`)) continue;
      populateDirCount(join(dir, entry.name), childRel, isIgnored, dirCount);
    } else if (entry.isFile() && isSupportedDocFile(entry.name) && !isIgnored(childRel)) {
      dirCount.set(relPath, (dirCount.get(relPath) ?? 0) + 1);
    }
  }
}

/**
 * Parse a `.gitignore`/`.okignore` file into an array of non-empty,
 * non-comment patterns. Whitespace trimmed; CRLF-safe via `split('\n')`
 * + `trim()`.
 */
function parseIgnorePatterns(content: string): string[] {
  return content
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));
}

/**
 * Re-anchor one nested ignore-file pattern into project-root-relative form for
 * the single flattened `ignore` matcher, preserving gitignore depth semantics.
 *
 * gitignore scoping: a bare basename (no leading or embedded slash; an optional
 * trailing `/` doesn't count) matches at ANY depth below the ignore file's
 * directory, while a pattern with a leading or embedded slash is anchored to
 * that directory. A naive `${relPrefix}/${pattern}` always injects an embedded
 * slash, which the `ignore` library reads as root-anchored — silently
 * collapsing an any-depth rule to "this exact level only." That made nested
 * `.blob-storage/` match `<dir>/.blob-storage` but miss `<dir>/agents-api/.blob-storage`,
 * so the sync walker handed `git add` a path git rejects with `addIgnoredFile`
 * (the predicate-symmetry break precedent #55 guards against). Non-anchored
 * patterns therefore get a globstar segment (`relPrefix` + slash + `**` + slash)
 * so they keep matching at any depth.
 */
function prefixPattern(pattern: string, relPrefix: string): string {
  const negated = pattern.startsWith('!');
  const body = negated ? pattern.slice(1) : pattern;
  const core = body.startsWith('/') ? body.slice(1) : body;
  const withoutTrailingSlash = core.endsWith('/') ? core.slice(0, -1) : core;
  const anchored = body.startsWith('/') || withoutTrailingSlash.includes('/');
  const reanchored = anchored ? `${relPrefix}/${core}` : `${relPrefix}/**/${core}`;
  return negated ? `!${reanchored}` : reanchored;
}

/**
 * Recursively walk a directory looking for nested `.gitignore` / `.okignore`
 * files. Skips directories the ignore instance already excludes plus
 * `BUILTIN_SKIP_DIRS`. Adds found patterns to the ignore instance with
 * correct relative path prefixes.
 *
 * Returns the count of successfully loaded nested files. Accumulates the
 * total bytes read into `bytesAcc.value`. Per-file read errors are silent-
 * caught (matching boot semantics so a single bad file doesn't abort the
 * walk); the caller that wants to surface them must use a different seam.
 */
function loadNestedIgnoreFiles(
  dir: string,
  projectDir: string,
  ig: Ignore,
  bytesAcc: { value: number },
): number {
  let entries: import('node:fs').Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    console.warn(`[content-filter] Failed to read directory ${dir}:`, err);
    return 0;
  }

  let count = 0;

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    if (BUILTIN_SKIP_DIRS.has(entry.name)) continue;

    const dirPath = join(dir, entry.name);
    const relToProject = toPosix(relative(projectDir, dirPath));

    // Skip directories outside projectDir — the `ignore` library rejects
    // path.relative paths that start with "..".
    if (relToProject.startsWith('..')) continue;

    // Skip directories that are already excluded by the bootstrap filter
    if (ig.ignores(relToProject) || ig.ignores(`${relToProject}/`)) continue;

    for (const name of IGNORE_FILE_NAMES) {
      const filePath = join(dirPath, name);
      if (!existsSync(filePath)) continue;
      try {
        const content = readFileSync(filePath, 'utf-8');
        bytesAcc.value += content.length;
        const patterns = parseIgnorePatterns(content);
        const prefixed = patterns.map((p) => prefixPattern(p, relToProject));
        ig.add(prefixed);
        count++;
      } catch (err) {
        console.warn(`[content-filter] Failed to read nested ${name} at ${filePath}:`, err);
      }
    }

    // Recurse into subdirectory
    count += loadNestedIgnoreFiles(dirPath, projectDir, ig, bytesAcc);
  }

  return count;
}

/**
 * Async variant of initContentDirState. Uses `readdir` (from `node:fs/promises`)
 * so each directory read yields the event loop, preventing the startup walk from
 * blocking the server for the full traversal duration on large content trees.
 *
 * Traversal is sequential (not parallel across siblings) to keep the `ig`
 * mutations — loading nested .gitignore/.okignore patterns — deterministic:
 * each directory's ignore file is added to `ig` before its own subtree is
 * entered, matching the sync variant's ordering guarantee.
 */
async function initContentDirStateAsync(
  dir: string,
  relPath: string,
  projectDir: string,
  ig: Ignore,
  contentRelPrefix: string,
  contentOutsideProject: boolean,
  dirCount: Map<string, number>,
): Promise<void> {
  let entries: import('node:fs').Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    console.warn(`[content-filter] Failed to read directory ${dir}:`, err);
    return;
  }

  for (const entry of entries) {
    const childRel = relPath ? `${relPath}/${entry.name}` : entry.name;

    if (entry.isDirectory()) {
      if (BUILTIN_SKIP_DIRS.has(entry.name)) continue;

      const dirPath = join(dir, entry.name);

      if (!contentOutsideProject) {
        const relToProject = toPosix(relative(projectDir, dirPath));
        if (relToProject.startsWith('..')) continue;
        if (ig.ignores(relToProject) || ig.ignores(`${relToProject}/`)) continue;

        // Load ignore files before recursing — same ordering guarantee as the sync variant.
        for (const name of IGNORE_FILE_NAMES) {
          const filePath = join(dirPath, name);
          if (!existsSync(filePath)) continue;
          try {
            const patterns = parseIgnorePatterns(await readFileAsync(filePath, 'utf-8'));
            ig.add(patterns.map((p) => prefixPattern(p, relToProject)));
          } catch (err) {
            console.warn(`[content-filter] Failed to read nested ${name} at ${filePath}:`, err);
          }
        }
      }

      // Sequential recursion — keeps ig mutations in traversal order.
      await initContentDirStateAsync(
        dirPath,
        childRel,
        projectDir,
        ig,
        contentRelPrefix,
        contentOutsideProject,
        dirCount,
      );
    } else if (entry.isFile() && isSupportedDocFile(entry.name)) {
      if (!contentOutsideProject) {
        const projectRelPath = contentRelPrefix ? `${contentRelPrefix}/${childRel}` : childRel;
        if (ig.ignores(projectRelPath)) continue;
      }
      dirCount.set(relPath, (dirCount.get(relPath) ?? 0) + 1);
    }
  }
}

/**
 * Async variant of `createContentFilter`. Produces an identical ContentFilter
 * but uses `readdir` (from `node:fs/promises`) for the content-tree walk, so
 * the event loop is not blocked for the duration of the traversal on large
 * content directories.
 *
 * Prefer this in async boot paths (e.g., server initAsync). Use the synchronous
 * `createContentFilter` when the caller must remain synchronous.
 */
export async function createContentFilterAsync(opts: ContentFilterOptions): Promise<ContentFilter> {
  const { projectDir, contentDir, onAfterRebuild, singleDocRelPath } = opts;

  const contentRelPrefix = toPosix(relative(projectDir, contentDir));
  const contentOutsideProject = contentRelPrefix.startsWith('..');

  // Mutable bindings — swapped atomically by rebuildIgnorePatterns().
  let ig = ignore();
  let watcherIgnoreGlobs: string[] = [];

  const dirCount = new Map<string, number>();

  // Single-file scope guard for the refcount walk — see the sync variant's
  // `refreshDirCount` for the full rationale (boot-stall + privacy on a large
  // parent dir; sibling-asset admission is unreachable in single-file mode).
  const refreshDirCount = (): void => {
    if (singleDocRelPath !== undefined) return;
    populateDirCount(contentDir, '', isIgnored, dirCount);
  };

  function isIgnored(relativePath: string): boolean {
    if (contentOutsideProject) return false;
    const projectRelPath = contentRelPrefix ? `${contentRelPrefix}/${relativePath}` : relativePath;
    return ig.ignores(projectRelPath);
  }

  // Mirror of the sync variant's STOP-rule + configurable-rules split.
  // Keeping the two predicates separated here lets `isExcluded` /
  // `isPathIgnored` short-circuit safely in bypass mode without ever
  // skipping the system-doc gate.
  function isReservedDocName(relativePath: string): boolean {
    const docName = stripDocExtension(relativePath);
    // system + config + managed-artifact (skill/template) docs are all hidden
    // from the user tree/search. (Tree-exclusion axis only — managed-artifact
    // docs still get the observer bridge; that gate lives elsewhere.)
    return isReservedForUserTree(docName);
  }
  function isRejectedByConfigurableRules(relativePath: string): boolean {
    for (const segment of relativePath.split('/')) {
      if (BUILTIN_SKIP_DIRS.has(segment)) return true;
    }
    if (contentOutsideProject) return false;
    return isIgnored(relativePath);
  }

  async function buildAndSwapPatternState(): Promise<void> {
    const newIg = ignore();
    newIg.add('.git');
    const newRootPatterns: string[] = [];

    // Root patterns — use async read for consistency with nested patterns.
    for (const name of IGNORE_FILE_NAMES) {
      const path = join(projectDir, name);
      if (!existsSync(path)) continue;
      try {
        const patterns = parseIgnorePatterns(await readFileAsync(path, 'utf-8'));
        newRootPatterns.push(...patterns);
        newIg.add(patterns);
      } catch (err) {
        console.warn(`[content-filter] Failed to read ${name} at ${path}:`, err);
      }
    }

    if (contentRelPrefix && !contentOutsideProject) {
      for (const name of IGNORE_FILE_NAMES) {
        const path = join(contentDir, name);
        if (!existsSync(path)) continue;
        try {
          const patterns = parseIgnorePatterns(await readFileAsync(path, 'utf-8'));
          newIg.add(patterns.map((p) => prefixPattern(p, contentRelPrefix)));
        } catch (err) {
          console.warn(`[content-filter] Failed to read ${name} at ${path}:`, err);
        }
      }
    }

    // Per-clone `.git/info/exclude` + global excludesfile — same rationale
    // as the sync factory; see `loadGitExcludeSources` doc. Async variant
    // here because `createContentFilterAsync` is async by contract — the
    // sync `spawnSync` would block the event loop on boot. Loaded BEFORE
    // `initContentDirStateAsync` so `newDirCount` is computed against the
    // full `ignore` instance (matches the sync variant's ordering).
    const bytesAcc = { value: 0 };
    const gitExcludePatterns = await loadGitExcludeSourcesAsync(projectDir, bytesAcc);
    if (gitExcludePatterns.length > 0) {
      newRootPatterns.push(...gitExcludePatterns);
      newIg.add(gitExcludePatterns);
    }

    const newDirCount = new Map<string, number>();
    // Single-file scope skips the full-tree refcount walk (boot stall + privacy
    // leak on a large parent); the bounded one-dir embed seed lives in
    // server-factory. Mirrors the sync factory's `refreshDirCount` guard.
    if (singleDocRelPath === undefined) {
      await initContentDirStateAsync(
        contentDir,
        '',
        projectDir,
        newIg,
        contentRelPrefix,
        contentOutsideProject,
        newDirCount,
      );
    }

    // Atomic swap.
    ig = newIg;
    watcherIgnoreGlobs = newRootPatterns.filter(
      (p) => p.length > 0 && !p.startsWith('!') && !p.startsWith('#') && !globBlocksSkillContent(p),
    );
    dirCount.clear();
    for (const [k, v] of newDirCount) dirCount.set(k, v);
  }

  // Initial build.
  await buildAndSwapPatternState();

  return {
    isExcluded(relativePath: string, opts?: ContentFilterReadOpts): boolean {
      if (isReservedDocName(relativePath)) return true;
      // Secret-bearing floor — `.env*` / private keys / `.ssh` / `.aws` /
      // `.gnupg` (see sync variant). Mirrored here so the async factory's
      // egress posture matches the sync factory's; an inconsistent floor
      // between factories would leak secrets on `?async=true` callers. MUST
      // precede the skills carve-out (`.key` is both a secret suffix and an
      // asset extension), so the floor wins over skill-asset admission.
      if (isSecretBearingFile(relativePath)) return true;
      if (pathHasSecretBearingDirSegment(relativePath)) return true;
      // Skills-as-content carve-out — admit project skill docs + linkable assets
      // under `.ok/skills/**` (see sync variant for rationale, incl. the
      // `!bypassFilters` gate that mirrors `isDirExcluded`).
      if (!opts?.bypassFilters && isSkillContentFile(relativePath)) {
        if (singleDocRelPath !== undefined) return relativePath !== singleDocRelPath;
        if (isSupportedDocFile(relativePath)) return false;
        const skillExt = extname(relativePath).slice(1).toLowerCase();
        return !LINKABLE_ASSET_EXTENSIONS.has(skillExt);
      }
      // Always-skip floor — survives bypass (see sync variant for rationale).
      if (pathHasAlwaysSkipSegment(relativePath)) return true;
      // Junk-file floor — `.DS_Store` / `.localized` survive bypass too.
      if (isAlwaysSkipFile(relativePath)) return true;
      // Single-file scope — admit ONLY the one target doc (see sync variant).
      if (singleDocRelPath !== undefined) return relativePath !== singleDocRelPath;
      if (opts?.bypassFilters) return false;
      if (isRejectedByConfigurableRules(relativePath)) return true;
      if (isSupportedDocFile(relativePath)) return false;
      const ext = extname(relativePath).slice(1).toLowerCase();
      if (LINKABLE_ASSET_EXTENSIONS.has(ext)) {
        const dir = dirname(relativePath);
        const normalizedDir = dir === '.' ? '' : dir;
        if ((dirCount.get(normalizedDir) ?? 0) > 0) return false;
      }
      return true;
    },

    isDirExcluded(relativePath: string, opts?: ContentFilterReadOpts): boolean {
      // Secret-bearing dir floor — `.ssh` / `.aws` / `.gnupg` (see sync variant).
      // MUST precede the skills carve-out so a secret dir nested under a skill
      // (`.ok/skills/x/.ssh`) isn't kept descendable by the ancestor carve-out.
      if (pathHasSecretBearingDirSegment(relativePath)) return true;
      // Skills-as-content: keep `.ok` / `.ok/skills` / `.ok/skills/**`
      // descendable for the NORMAL index walk only (see sync variant); under
      // bypass the always-skip floor below keeps `.ok` pruned.
      if (!opts?.bypassFilters && isSkillContentAncestorDir(relativePath)) return false;
      // Always-skip floor — survives bypass; load-bearing OOM fix for the
      // `?showAll=true` walk (see sync variant for rationale).
      if (pathHasAlwaysSkipSegment(relativePath)) return true;
      // Single-file scope — prune every dir that isn't an ancestor of the one
      // admitted doc (see sync variant).
      if (singleDocRelPath !== undefined) {
        return !isSingleDocAncestorDir(relativePath, singleDocRelPath);
      }
      if (opts?.bypassFilters) return false;
      for (const segment of relativePath.split('/')) {
        if (BUILTIN_SKIP_DIRS.has(segment)) return true;
      }
      if (contentOutsideProject) return false;
      const projectRelPath = contentRelPrefix
        ? `${contentRelPrefix}/${relativePath}`
        : relativePath;
      return ig.ignores(projectRelPath) || ig.ignores(`${projectRelPath}/`);
    },

    isPathIgnored(relativePath: string, opts?: ContentFilterReadOpts): boolean {
      if (isReservedDocName(relativePath)) return true;
      // Secret-bearing floor (see sync variant). Mirrored so `kind:'file'`
      // admission going through the async factory inherits the same egress
      // gate as the sync factory. MUST precede the skills carve-out — the
      // asset-serve middleware gates on this predicate, so a secret under a
      // skill dir would otherwise be network-servable.
      if (isSecretBearingFile(relativePath)) return true;
      if (pathHasSecretBearingDirSegment(relativePath)) return true;
      // Skills-as-content: project skill files under `.ok/skills/**` are
      // servable content (asset-serve consults `isPathIgnored`). Admit them
      // before the `.ok` always-skip floor.
      if (isSkillContentFile(relativePath)) return false;
      if (pathHasAlwaysSkipSegment(relativePath)) return true;
      if (isAlwaysSkipFile(relativePath)) return true;
      if (opts?.bypassFilters) return false;
      return isRejectedByConfigurableRules(relativePath);
    },

    getWatcherIgnoreGlobs(): string[] {
      return watcherIgnoreGlobs;
    },

    incrementMdDir(dir: string): void {
      const normalizedDir = dir === '.' ? '' : dir;
      dirCount.set(normalizedDir, (dirCount.get(normalizedDir) ?? 0) + 1);
    },

    decrementMdDir(dir: string): void {
      const normalizedDir = dir === '.' ? '' : dir;
      const current = dirCount.get(normalizedDir) ?? 0;
      if (current <= 1) {
        dirCount.delete(normalizedDir);
      } else {
        dirCount.set(normalizedDir, current - 1);
      }
    },

    rebuildDirCount(): void {
      const prev = new Map(dirCount);
      dirCount.clear();
      try {
        refreshDirCount();
      } catch (err) {
        for (const [k, v] of prev) dirCount.set(k, v);
        getLogger('content-filter').warn(
          { err: err instanceof Error ? err : new Error(String(err)) },
          'content-filter rebuildDirCount walk failed — retaining previous counts',
        );
      }
    },

    async rebuildIgnorePatterns(): Promise<RebuildResult> {
      const log = getLogger('content-filter');
      const prevIg = ig;
      const prevWatcherGlobs = watcherIgnoreGlobs;
      const prevDirCount = new Map(dirCount);
      const startedAt = Date.now();

      return withSpan('config.ignore.rebuild', { attributes: {} }, async (span) => {
        try {
          await buildAndSwapPatternState();
          const durationMs = Date.now() - startedAt;
          span.setAttributes({
            'ok.ignore.pattern_count': watcherIgnoreGlobs.length,
            'ok.ignore.nested_file_count': 0,
            'ok.ignore.bytes': 0,
          });
          log.info({ durationMs }, 'content-filter async rebuild succeeded');

          if (onAfterRebuild) {
            try {
              onAfterRebuild();
            } catch (err) {
              log.warn(
                { err: err instanceof Error ? err : new Error(String(err)) },
                'content-filter onAfterRebuild callback threw — derived views may be stale',
              );
            }
          }

          return {
            ok: true as const,
            patternCount: watcherIgnoreGlobs.length,
            nestedFileCount: 0,
            bytes: 0,
            durationMs,
          };
        } catch (err) {
          ig = prevIg;
          watcherIgnoreGlobs = prevWatcherGlobs;
          dirCount.clear();
          for (const [k, v] of prevDirCount) dirCount.set(k, v);
          const message = err instanceof Error ? err.message : String(err);
          log.warn(
            { err: err instanceof Error ? err : new Error(message) },
            'content-filter async rebuild failed — rolled back',
          );
          return { ok: false as const, error: { message } };
        }
      });
    },
  };
}
