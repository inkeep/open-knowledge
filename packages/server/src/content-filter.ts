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
import {
  DEFAULT_ATTACHMENT_FOLDER_PATH,
  isValidAttachmentFolderPath,
  LEGACY_SKILL_STORE_ROOT,
  LINKABLE_ASSET_EXTENSIONS,
  normalizeAttachmentFolderPath,
  OK_DIR,
} from '@inkeep/open-knowledge-core';
import ignore, { type Ignore } from 'ignore';
import { isReservedForUserTree } from './cc1-broadcast.ts';
import { withHiddenWindowsConsole } from './child-process-windows-hide.ts';
import { isSupportedDocFile, stripDocExtension } from './doc-extensions.ts';
import { getLogger } from './logger.ts';
import { toPosix } from './path-utils.ts';
import { withSpan } from './telemetry.ts';

const log = getLogger('content-filter');

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
const EDITOR_HOST_DIRS = ['.claude', '.cursor', '.codex', '.agents', '.opencode', '.pi'] as const;

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
  ...EDITOR_HOST_DIRS,
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
  ...EDITOR_HOST_DIRS,
]);

/**
 * `.ok` children that stay on the always-skip floor even under `showOk`:
 * `worktrees/` can hold full repo-scale git checkouts (the same unbounded-
 * traversal hazard the floor exists to prevent) and `local/` is per-machine
 * runtime state — locks, caches, error logs carrying hostnames and absolute
 * paths.
 */
const OK_ALWAYS_SKIP_CHILDREN = new Set(['worktrees', 'local']);

type AttachmentFolderShape =
  | { kind: 'sibling' }
  | { kind: 'content-root' }
  | { kind: 'fixed'; path: string }
  | { kind: 'doc-relative'; path: string };

function attachmentFolderShape(value: string): AttachmentFolderShape {
  const normalized = normalizeAttachmentFolderPath(value);
  if (!isValidAttachmentFolderPath(normalized)) {
    throw new Error('Invalid attachment folder path');
  }
  if (normalized === './') return { kind: 'sibling' };
  if (normalized === '/' || normalized === '.') return { kind: 'content-root' };

  const docRelative = normalized.startsWith('./');
  const path = (docRelative ? normalized.slice(2) : normalized)
    .split('/')
    .filter((segment) => segment !== '' && segment !== '.')
    .join('/');
  if (path === '') return docRelative ? { kind: 'sibling' } : { kind: 'content-root' };
  return { kind: docRelative ? 'doc-relative' : 'fixed', path };
}

/**
 * Exhaustiveness guard for `AttachmentFolderShape` dispatch. A new variant
 * must produce a TypeScript error here rather than silently inheriting the
 * doc-relative sliding-window logic as a fall-through.
 */
function assertNeverAttachmentShape(shape: never): never {
  throw new Error(`[AttachmentFolderShape] unhandled variant: ${JSON.stringify(shape)}`);
}

function isConfiguredAttachmentAsset(
  relativePath: string,
  shape: AttachmentFolderShape,
  hasDocumentInDir: (dir: string) => boolean,
): boolean {
  const ext = extname(relativePath).slice(1).toLowerCase();
  if (!LINKABLE_ASSET_EXTENSIONS.has(ext) || shape.kind === 'sibling') return false;

  const lastSlash = relativePath.lastIndexOf('/');
  const fileDir = lastSlash === -1 ? '' : relativePath.slice(0, lastSlash);
  if (shape.kind === 'content-root') return fileDir === '';
  if (shape.kind === 'fixed') {
    return fileDir === shape.path || fileDir.startsWith(`${shape.path}/`);
  }
  if (shape.kind === 'doc-relative') {
    const dirSegments = fileDir === '' ? [] : fileDir.split('/');
    const shapeSegments = shape.path.split('/');
    for (let start = 0; start <= dirSegments.length - shapeSegments.length; start++) {
      if (!shapeSegments.every((segment, offset) => dirSegments[start + offset] === segment)) {
        continue;
      }
      const parentDir = dirSegments.slice(0, start).join('/');
      if (hasDocumentInDir(parentDir)) return true;
    }
    return false;
  }
  return assertNeverAttachmentShape(shape);
}

/**
 * True when any segment of `relativePath` is an always-skip directory. Called
 * before the `bypassFilters` early-return in every exclusion predicate so the
 * floor holds regardless of caller (including the `?showAll=true` disk walk).
 * `showOk` admits `.ok` segments — unless the next segment is an
 * `OK_ALWAYS_SKIP_CHILDREN` member — so the tree-listing walk can reveal
 * `.ok` content on request; every other floor member is unconditional.
 * The child lookahead matches case-insensitively for the same reason as
 * `isSecretBearingFile`: on the default case-insensitive macOS filesystem
 * an externally-created `.ok/Local` IS `.ok/local`, and the walk sees the
 * on-disk casing.
 */
function pathHasAlwaysSkipSegment(relativePath: string, showOk?: boolean): boolean {
  const segments = relativePath.split('/');
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    const canonicalSegment = segment.toLowerCase() === OK_DIR ? OK_DIR : segment;
    if (!ALWAYS_SKIP_DIRS.has(canonicalSegment)) continue;
    if (
      showOk &&
      canonicalSegment === OK_DIR &&
      !OK_ALWAYS_SKIP_CHILDREN.has((segments[i + 1] ?? '').toLowerCase())
    ) {
      continue;
    }
    return true;
  }
  return false;
}

/**
 * The ONE carve-out from the blanket `.ok/` exclusion, and it is deliberate
 * rather than residue from the retired store.
 *
 * Skills now live IN PLACE (`.claude/skills/<name>`, the `.agents/skills` hub, a
 * custom root); `.ok/skills` is an ordinary custom root you may still place at,
 * plus whatever has not drained. But it is the ONE skill root that sits inside
 * `.ok/`, which OK hides from git wholesale in local-only mode. Git will not
 * re-include a path whose parent is excluded, so the sharing feature replaces
 * that blanket with a children-exclude plus a `!**\/.ok/skills/` re-include
 * (`cli/src/sharing/git-exclude.ts`).
 *
 * This carve-out is the index-side half of that: without it, a skill sitting at
 * `.ok/skills` in a local-only project would be admitted by neither the ignore
 * rules nor the in-place allow-list, and would silently vanish from the UI while
 * still being on disk. Removing it to make the root "ordinary" would hide
 * people's skills, so it stays — and it is the reason `.ok/skills` can never be
 * QUITE as ordinary as `.tim/skills`, which git never hid in the first place.
 *
 * Paths are contentDir-relative, '/'-joined, no leading slash. Project scope
 * only — global skills are served by the dedicated global route, not the content
 * index.
 */

/** True for a FILE under `.ok/skills/<name>/...` (at least one segment past the root). */
function isSkillContentFile(relativePath: string): boolean {
  return relativePath.startsWith(`${LEGACY_SKILL_STORE_ROOT}/`);
}

/**
 * True for the directories that must stay DESCENDABLE so a tree walk reaches
 * skill files: `.ok` itself (to get to `.ok/skills`), `.ok/skills`, and anything
 * under it. `.ok` is descendable but does NOT admit its other children — the
 * file-level predicates still exclude `.ok/local`, config, etc. (Templates under
 * `.ok/templates` are admitted, but by their own segment-shaped carve-out.)
 */
function isSkillContentAncestorDir(relativePath: string): boolean {
  return (
    relativePath === '.ok' ||
    relativePath === LEGACY_SKILL_STORE_ROOT ||
    relativePath.startsWith(`${LEGACY_SKILL_STORE_ROOT}/`)
  );
}

/**
 * True for a watcher-ignore glob that would stop the OS file-watcher from
 * seeing `.ok/` content the carve-outs admit: `.ok/skills/**`, the template
 * leaves under any `<folder>/.ok/templates/`, and the shareable sync
 * artifacts (`.ok/config.yml`, `.ok/.gitignore`, `.ok/schemas/*.json`, folder
 * `frontmatter.yml`). The watcher-ignore list is glob-derived from
 * `.gitignore` / `.okignore` / `.git/info/exclude` (e.g. clone appends
 * `.ok/`), and it is consulted INSTEAD of the function predicates
 * (`isDirExcluded` / `isExcluded`) that carry the carve-outs and that the
 * chokidar backend uses. So a blanket `.ok` ignore glob would make a watcher
 * reading this list never deliver external edits to project skills, templates,
 * or the shareable artifacts. Dropping the
 * blanket-`.ok` globs lets the watcher reach them; `.ok` children still never
 * reach the file index — `handleRawEvents` consults the unscoped predicates,
 * which admit only the skill/template leaves and keep pruning `.ok/local`,
 * config, and the rest (the shareable artifacts are a sync-scope carve-out,
 * not an index one: staging walks them directly under `syncScope` rather
 * than riding watcher events). The `.ok` children-exclude forms are dropped
 * too: the skills-sharing carve in the CLI's git-exclude replaces the blanket
 * with a children-exclude (`OK_CARVE_CHILDREN`) plus a skills re-include
 * (`OK_CARVE_SKILLS_REINCLUDE`), and negation lines never survive into this
 * list — a surviving children-exclude would prune the re-included skills tree
 * (and the admitted template/config leaves) with nothing left to re-admit
 * them. Sanitization probes the managed roots directly. Ordinary user
 * exclusions are retained on the list so a watcher backend that can safely
 * apply them has them available.
 *
 * Today's only consumer, `toParcelIgnorePaths` in `file-watcher.ts`, applies
 * just the `WATCHER_STRUCTURAL_IGNORE_DIRS` subset: @parcel/watcher matches a
 * glob with a recursive `std::regex` that overruns its thread stack on a long
 * path, so nothing pattern-shaped may be handed to it. The retention and
 * sanitization here therefore constrain a list that is narrowed again before
 * use — kept because it is what makes the list safe to widen from.
 */

const WATCHER_CARVE_OUT_CAPABLE_DIRS = new Set<string>([OK_DIR, ...EDITOR_HOST_DIRS]);
const WATCHER_SAFE_BUILTIN_SKIP_DIRS = new Set(
  [...BUILTIN_SKIP_DIRS].filter((dir) => !WATCHER_CARVE_OUT_CAPABLE_DIRS.has(dir)),
);

/**
 * The directory roots whose ENTIRE subtree the content predicates reject with
 * no carve-out reachable inside — `.ok`'s two always-skip children rather than
 * `.ok` itself, which does admit skills, templates, and the shareable sync
 * artifacts.
 *
 * That unconditional-rejection property is what lets a consumer treat one of
 * these as a PREFIX (everything at or below it is ignorable), which is
 * stronger than the per-path glob match below and is not true of the ordinary
 * user exclusions the list is otherwise built from. `toParcelIgnorePaths` in
 * `file-watcher.ts` depends on it.
 */
export const WATCHER_STRUCTURAL_IGNORE_DIRS = [
  '.git',
  'node_modules',
  '.ok/local',
  '.ok/worktrees',
] as const;

const WATCHER_STRUCTURAL_IGNORE_GLOBS = WATCHER_STRUCTURAL_IGNORE_DIRS.flatMap((dir) => [
  dir,
  `${dir}/**`,
  `**/${dir}`,
  `**/${dir}/**`,
]);

function watcherPatternIsConfinedToAlwaysSkippedTree(pattern: string): boolean {
  const segments = pattern.replace(/^\/+/, '').replace(/\/+$/, '').split('/');
  if (segments.includes('..')) return false;

  // An exact watcher-safe skip segment bounds every match beneath a tree the
  // content predicates reject without carve-outs. Wildcard lookalikes are not
  // enough: `dist*` could also match a normal user folder.
  if (segments.some((segment) => WATCHER_SAFE_BUILTIN_SKIP_DIRS.has(segment))) {
    return true;
  }

  // `.ok` as a whole contains admitted leaves, but its runtime and worktree
  // children never do. Case-fold these two names because the skip floor does
  // the same for case-preserved paths on case-insensitive filesystems.
  return segments.some(
    (segment, index) =>
      segment.toLowerCase() === OK_DIR &&
      OK_ALWAYS_SKIP_CHILDREN.has((segments[index + 1] ?? '').toLowerCase()),
  );
}

const WATCHER_MANAGED_CONTENT_PROBES = [
  '.gitignore',
  '.ok',
  '.ok/config.yml',
  '.ok/.gitignore',
  '.ok/schemas/frontmatter.json',
  '.ok/templates/example.md',
  '.ok/skills/example/SKILL.md',
  'docs/.ok',
  'docs/.ok/frontmatter.yml',
  'docs/.ok/templates/example.md',
  ...EDITOR_HOST_DIRS.flatMap((dir) => [dir, `${dir}/skills/example/SKILL.md`]),
] as const;

function patternIsUnsafeForWatcherIgnore(pattern: string): boolean {
  const candidate = pattern.trim();
  if (!candidate || candidate.startsWith('!') || candidate.startsWith('#')) return false;
  const segments = candidate.replace(/^\/+/, '').replace(/\/+$/, '').split('/');
  if (segments.includes('..')) return true;
  if (watcherPatternIsConfinedToAlwaysSkippedTree(candidate)) return false;
  if (segments.some((segment) => WATCHER_CARVE_OUT_CAPABLE_DIRS.has(segment))) return true;

  try {
    const matcher = ignore().add(candidate);
    return WATCHER_MANAGED_CONTENT_PROBES.some((path) => matcher.ignores(path));
  } catch {
    // Parcel and node-ignore need not reject malformed glob syntax in the
    // same way. Omitting an ambiguous fast-path rule preserves correctness;
    // the content predicates still enforce it after an event arrives.
    return true;
  }
}

function buildWatcherIgnoreGlobs(patterns: readonly string[]): string[] {
  const retained = patterns.filter(
    (pattern) =>
      pattern.length > 0 &&
      !pattern.startsWith('!') &&
      !pattern.startsWith('#') &&
      !patternIsUnsafeForWatcherIgnore(pattern),
  );
  return [...new Set([...retained, ...WATCHER_STRUCTURAL_IGNORE_GLOBS])];
}

/*
 * Template carve-out family (the three predicates below). Templates are
 * ordinary content docs at `<folder>/.ok/templates/<name>.md` for any folder
 * depth, so — unlike the root-anchored `.ok/skills` carve-out — the predicates
 * are SEGMENT-shaped: a `.ok` segment immediately followed by `templates`. A
 * `startsWith` twin would silently miss every nested-folder template. The shape
 * match alone is NOT sufficient: these predicates run before the always-skip and
 * configurable-rules floors, and `isExcluded` / `isPathIgnored` are consulted
 * per raw watcher event on the full path (not only via the top-down walk that
 * prunes skip-dir roots first), so a template tail vendored under
 * `node_modules` / `dist` / a gitignored tree would leak in.
 * `templateFolderPrefixIsSkipped` bounds the carve-out below the skip-dir floor.
 */

/**
 * True when a template-shaped path sits under a `BUILTIN_SKIP_DIRS` ancestor.
 * Only the folder prefix strictly above the template's `.ok` is checked — the
 * `.ok` segment is itself a skip dir by design and must not self-reject the
 * template. `okIndex` is the position of that `.ok` segment.
 */
function templateFolderPrefixIsSkipped(segments: string[], okIndex: number): boolean {
  for (let i = 0; i < okIndex; i++) {
    if (BUILTIN_SKIP_DIRS.has(segments[i]) || segments[i].toLowerCase() === OK_DIR) return true;
  }
  return false;
}

/**
 * True for a single `.md` template leaf directly under any
 * `<folder>/.ok/templates/`. `.md` ONLY — a `.mdx` (or any other extension)
 * under `.ok/templates` is not a template and stays excluded. A leaf inside a
 * subdirectory (`.ok/templates/sub/x.md`) is rejected: templates are flat, one
 * leaf per dir.
 */
function isTemplateContentFile(relativePath: string): boolean {
  const segments = relativePath.split('/');
  const n = segments.length;
  if (n < 3) return false;
  if (
    segments[n - 3] !== OK_DIR ||
    segments[n - 2] !== 'templates' ||
    extname(segments[n - 1]) !== '.md'
  ) {
    return false;
  }
  return !templateFolderPrefixIsSkipped(segments, n - 3);
}

/**
 * True for the directories that must stay DESCENDABLE so the normal index walk
 * reaches template leaves at any depth: a `<folder>/.ok` (to reach its
 * `templates` child) and a `<folder>/.ok/templates` (to reach the leaves). A
 * subdirectory under `.ok/templates` is NOT an ancestor — templates are flat,
 * so it falls through to the always-skip floor and stays pruned, keeping the
 * walk bounded.
 */
function isTemplateContentAncestorDir(relativePath: string): boolean {
  const segments = relativePath.split('/');
  const n = segments.length;
  if (segments[n - 1] === OK_DIR) {
    return !templateFolderPrefixIsSkipped(segments, n - 1);
  }
  if (n >= 2 && segments[n - 1] === 'templates' && segments[n - 2] === OK_DIR) {
    return !templateFolderPrefixIsSkipped(segments, n - 2);
  }
  return false;
}

/*
 * Shareable `.ok` artifact family (the two predicates below). Team-shareable
 * OK state — project `config.yml`, the seeded `.ok/.gitignore`, frontmatter
 * lint schemas, note templates, folder `frontmatter.yml` — must reach the git
 * auto-sync engine's staging and deletion-tracking walks, while the
 * index-facing consumers keep hiding every member except templates, which are
 * already ordinary index content via their own carve-out (consulted first in
 * `isExcluded`, so the sync-scope block never sees them). Admission is
 * therefore gated on the `syncScope` read-opt; without the opt the
 * non-template members keep their normal exclusion. The list is POSITIVE and
 * exact: ContentFilter deliberately never loads `.ok/.gitignore` (the `.ok`
 * dir is skipped before nested ignore files are read), so a subtractive ".ok
 * minus its self-ignored children" shape would gather paths that file tells
 * `git add` to refuse.
 */

/**
 * True for a FILE on the shareable `.ok` artifact allow-list:
 *   - `.ok/config.yml` and `.ok/.gitignore`, project root only
 *   - `.ok/schemas/<name>.json`, project root only, flat — `.json` matched
 *     case-insensitively like the schema enumerator's filter
 *   - `<folder>/.ok/templates/<name>.md` at any depth, root included
 *   - `<folder>/.ok/frontmatter.yml` at any depth — root included, because
 *     the project root's own folder metadata lives at `.ok/frontmatter.yml`
 *
 * The folder-scoped shapes inherit the templates family's skip-dir bound:
 * these predicates are consulted on flat full paths (head listings, raw
 * watcher events), not only via the top-down walk that prunes skip-dir roots
 * first, so a `frontmatter.yml` vendored under `node_modules/` — or inside
 * `.ok/worktrees/<wt>/…`, whose prefix contains the skip-dir `.ok` — must
 * not leak in.
 */
function isShareableOkArtifact(relativePath: string): boolean {
  const segments = relativePath.split('/');
  const n = segments.length;
  if (segments[0] === OK_DIR) {
    if (n === 2 && (segments[1] === 'config.yml' || segments[1] === '.gitignore')) return true;
    if (n === 3 && segments[1] === 'schemas' && segments[2].toLowerCase().endsWith('.json')) {
      return true;
    }
  }
  if (isTemplateContentFile(relativePath)) return true;
  if (n >= 2 && segments[n - 1] === 'frontmatter.yml' && segments[n - 2] === OK_DIR) {
    return !templateFolderPrefixIsSkipped(segments, n - 2);
  }
  return false;
}

/**
 * True for the directories that must stay DESCENDABLE under `syncScope` so a
 * walk reaches every shareable artifact: `.ok` itself, the flat
 * `.ok/schemas`, and — delegated to the template ancestors — any bounded
 * `<folder>/.ok` (also where `frontmatter.yml` leaves sit) plus
 * `<folder>/.ok/templates`. A subdirectory under `.ok/schemas` is NOT an
 * ancestor: schemas are flat, so the walk stays bounded.
 */
function isShareableOkArtifactAncestorDir(relativePath: string): boolean {
  if (relativePath === OK_DIR || relativePath === `${OK_DIR}/schemas`) return true;
  return isTemplateContentAncestorDir(relativePath);
}

/**
 * In-place skill admission (spec: in-place skill versioning). Unlike the
 * `.ok/skills` carve-out (a fixed prefix), in-place skills live in the various
 * editor host dirs (`.claude/skills/<name>`, `.codex/skills/<name>`, …), which
 * are otherwise wholesale-skipped. So admission is a registry-driven ALLOW-LIST
 * keyed on the exact canonical bundle dirs, NOT a path prefix — copies and
 * conflicts are absent from the set and stay excluded. `dirs` are contentDir-
 * relative, '/'-joined, no leading/trailing slash.
 */

/**
 * True for a path under a KNOWN skill root (`.claude/skills`, `.github/skills`,
 * `.agents/skills`, a ledger custom root, …). Roots arrive from the same
 * registry the scanner uses, never a literal list here — hosts get added and
 * users configure custom roots, and a hand-maintained copy in this file has
 * already drifted once: every editor dotdir was skipped wholesale EXCEPT
 * `.github`, so Copilot's projection was swept in as ordinary content and every
 * skill rendered twice in the graph.
 *
 * Scoped to the ROOT PATH (`.github/skills`), never the host dotdir
 * (`.github`) — segment-matching the dotdir would also bury real content that
 * lives beside the projection (`.github/CI_RUNBOOK.md` and friends).
 *
 * Admission is unchanged: a bundle still enters only via the elected-canonical
 * allow-list, which is a per-SKILL election. One skill can be canonical in
 * `.github` while the next is canonical in `.cursor`; no root is privileged.
 */
function isUnderSkillRoot(relativePath: string, roots: ReadonlySet<string>): boolean {
  for (const root of roots) {
    if (relativePath === root || relativePath.startsWith(`${root}/`)) return true;
  }
  return false;
}

/** True for a FILE under one of the admitted in-place skill bundle dirs. */
function isInPlaceSkillFile(relativePath: string, dirs: ReadonlySet<string>): boolean {
  if (dirs.size === 0) return false;
  for (const d of dirs) {
    if (relativePath.startsWith(`${d}/`)) return true;
  }
  return false;
}

/**
 * True for a DIR that must stay descendable to reach an admitted in-place skill
 * bundle: the bundle dir itself, anything under it, and every ancestor on the way
 * (`.claude`, `.claude/skills`) so the walk can descend to it. Ancestors admit
 * only the descent — the file-level predicates + secret/always-skip floors keep
 * every non-skill editor child (`.claude/plugins`, config, secrets) excluded.
 */
function isInPlaceSkillAncestorDir(relativePath: string, dirs: ReadonlySet<string>): boolean {
  if (dirs.size === 0) return false;
  for (const d of dirs) {
    if (
      d === relativePath ||
      d.startsWith(`${relativePath}/`) ||
      relativePath.startsWith(`${d}/`)
    ) {
      return true;
    }
  }
  return false;
}

/**
 * File basenames that are pure OS-metadata junk — never user-authored content,
 * useful in no mode. The file-level analogue of `ALWAYS_SKIP_DIRS`: pruned even
 * under `bypassFilters: true`. The seeded `.gitignore` (`init-project.ts`)
 * already keeps these out of the normal index-backed sidebar, but the Show All
 * Files walk bypasses `.gitignore` and built-in content rules so gitignored
 * content (`dist/`, `build/`, …) surfaces. Without this floor it would also
 * re-surface `.DS_Store` as a sidebar `asset` row. macOS is the only supported
 * platform, so this is macOS Finder metadata.
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
  const probe = spawnSync(
    'git',
    ['rev-parse', '--git-common-dir'],
    withHiddenWindowsConsole({
      cwd: projectDir,
      encoding: 'utf-8',
      timeout: 5_000,
    }),
  );
  if (probe.status !== 0 || !probe.stdout) return null;
  return resolve(projectDir, probe.stdout.trim());
}

async function readGitCommonDirAsync(projectDir: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['rev-parse', '--git-common-dir'],
      withHiddenWindowsConsole({
        cwd: projectDir,
        encoding: 'utf-8',
        timeout: 5_000,
      }),
    );
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
  const configProbe = spawnSync(
    'git',
    ['config', '--get', '--type=path', 'core.excludesfile'],
    withHiddenWindowsConsole({
      cwd: projectDir,
      encoding: 'utf-8',
      timeout: 5_000,
    }),
  );
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
      withHiddenWindowsConsole({ cwd: projectDir, encoding: 'utf-8', timeout: 5_000 }),
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
    log.warn({ path, err }, `Failed to read ${label} at ${path}`);
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
    log.warn({ path, err }, `Failed to read ${label} at ${path}`);
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
   * Resolved `content.attachmentFolderPath`. Linkable assets inside this
   * explicit destination are content even when the directory has no markdown
   * sibling. Omitted uses the historical `./` sibling placement.
   */
  attachmentFolderPath?: string;
  /**
   * In-place skill admission (spec: in-place skill versioning). The set of
   * contentDir-relative CANONICAL skill bundle dirs (`<editor>/skills/<name>`)
   * to admit as content. A gitignored bundle is NOT admitted: the user has said
   * that path stays out of git, and admitting it makes the sync engine try to
   * commit an ignored path, which git refuses and which strands sync offline.
   * Such a bundle still LISTS as its own skill row (the scan is independent of
   * admission) — it is readable and comparable, just not a tracked content doc.
   * An ALLOW-LIST:
   * only these exact bundle dirs (and their ancestor chain, so the walk descends
   * to reach them) are admitted out of the otherwise-skipped editor host dirs;
   * copies + conflicts are simply absent, so never admitted. Empty / omitted =
   * feature off (editor host dirs stay fully skipped, current behavior). The
   * secret floor still runs first, so secrets under a skill dir stay excluded.
   */
  inPlaceSkillDirs?: ReadonlySet<string>;
  /**
   * Known skill ROOT paths for this content dir (contentDir-relative, e.g.
   * `.claude/skills`, `.github/skills`, `.tim/skills`). A non-canonical
   * projection under one of these is excluded; the elected canonical bundle is
   * re-admitted by `inPlaceSkillDirs`. Empty / omitted = feature off.
   */
  skillRootPaths?: ReadonlySet<string>;
  /**
   * Optional provider re-run inside `rebuildIgnorePatterns()` to refresh the
   * in-place skill allow-list (live re-scan on skill add/remove). Throws are
   * swallowed — the previous set is kept. Absent = the construction-time set
   * is permanent.
   */
  rescanInPlaceSkillDirs?: () => ReadonlySet<string>;
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

/** Options shared by ordinary, bypass, and sync-scoped filter reads. */
interface ContentFilterCommonReadOpts {
  /**
   * Keep `.okignore` rules active while bypassing `.gitignore` and
   * `BUILTIN_SKIP_DIRS`. Used by the all-files sidebar: files normally hidden
   * by Git/build defaults surface, while the user's explicit OK hide list
   * remains authoritative.
   */
  respectOkignore?: boolean;
  /**
   * Admit `.ok`-segment paths through the always-skip floor — `isExcluded` /
   * `isDirExcluded` only; `isPathIgnored` (the asset-serve gate) keeps the
   * absolute floor so serving never widens. `.ok/worktrees` and `.ok/local`
   * stay pruned at every depth (see `OK_ALWAYS_SKIP_CHILDREN`). Lifts only
   * the floor: without `bypassFilters` the configurable `BUILTIN_SKIP_DIRS`
   * rule still hides non-skill `.ok` content. Per-request use only — backs
   * the `?showOk=true` tree-listing flag on `GET /api/documents`; no other
   * caller may pass it.
   */
  showOk?: boolean;
}

/**
 * Ordinary reads plus the Show All Files bypass. `syncScope?: never` keeps the
 * bypass and sync capabilities mutually exclusive at the call boundary.
 */
type ContentFilterOrdinaryReadOpts = ContentFilterCommonReadOpts & {
  bypassFilters?: boolean;
  syncScope?: never;
};

/**
 * Sync-engine-only admission. The bypass capability is deliberately absent:
 * combining the two would make the allow-list's effective boundary depend on
 * branch order inside the predicates instead of the type contract.
 */
type ContentFilterSyncReadOpts = ContentFilterCommonReadOpts & {
  bypassFilters?: never;
  /**
   * Admit the shareable `.ok` artifact allow-list (`isShareableOkArtifact`)
   * so the sync engine can stage and deletion-track team-shareable OK state
   * — `isExcluded` / `isDirExcluded` only; `isPathIgnored` (the asset-serve
   * gate) keeps the absolute floor, so sync admission never makes these
   * paths HTTP-servable. Paths the unified ignore rules reject stay refused
   * even with the scope: the gather walk and `git add` must agree on every
   * path (precedent #55), and a local-only project's blanket `.ok/` exclude
   * covers exactly this set. Sync-engine staging + head-listing use only —
   * index, sidebar, watcher-event, and conflict-partition callers must not
   * pass it, so these artifacts never surface as documents and their merge
   * conflicts keep the non-content auto-resolve class. Independent of
   * `showOk`. The type contract prevents combining this capability with
   * `bypassFilters`.
   */
  syncScope: { pathBase: 'content' | 'project' };
};

type ContentFilterReadOpts = ContentFilterOrdinaryReadOpts | ContentFilterSyncReadOpts;

/** Asset-serve reads never accept the sync-only admission capability. */
type ContentFilterPathReadOpts = Omit<ContentFilterOrdinaryReadOpts, 'syncScope'>;

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
  isPathIgnored(relativePath: string, opts?: ContentFilterPathReadOpts): boolean;
  /**
   * Relative patterns a file-watcher backend MAY pre-filter on (best-effort;
   * the predicates above stay authoritative). Not passed to a backend as-is —
   * `toParcelIgnorePaths` narrows this to the prefix-shaped subset, because
   * @parcel/watcher matches a pattern with a recursive `std::regex` that
   * overruns its thread stack on a long path.
   */
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
   * Apply the live project attachment destination without rebuilding the
   * filter. Throws `Invalid attachment folder path` on a value that fails
   * attachment-path validation, leaving the previous admission shape in
   * place — callers applying untrusted config must guard.
   */
  setAttachmentFolderPath(value: string): void;
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
  // Registry-driven allow-list of canonical in-place skill bundle dirs. Empty =
  // feature off (editor host dirs stay fully skipped). Refreshed per rebuild
  // via `rescanInPlaceSkillDirs` when provided (live re-scan).
  let inPlaceSkillDirs: ReadonlySet<string> = opts.inPlaceSkillDirs ?? new Set();
  let configuredAttachmentFolder = attachmentFolderShape(
    opts.attachmentFolderPath ?? DEFAULT_ATTACHMENT_FOLDER_PATH,
  );
  const skillRootPaths: ReadonlySet<string> = opts.skillRootPaths ?? new Set();

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
  let okignoreIg: Ignore;
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
    const newOkignoreIg = ignore();

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
        if (name === '.okignore') newOkignoreIg.add(patterns);
      } catch (err) {
        log.warn({ path, err }, `Failed to read ${name} at ${path}`);
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
          if (name === '.okignore') newOkignoreIg.add(prefixed);
        } catch (err) {
          log.warn({ path, err }, `Failed to read ${name} at ${path}`);
        }
      }
    }

    // Pass 2b: Recursive nested files
    const bytesAcc = { value: bytes };
    nestedFileCount += loadNestedIgnoreFiles(
      contentDir,
      projectDir,
      newIg,
      newOkignoreIg,
      bytesAcc,
    );
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
    const newWatcherGlobs = buildWatcherIgnoreGlobs(newRootPatterns);

    // Atomic swap.
    ig = newIg;
    okignoreIg = newOkignoreIg;
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

  function isIgnored(
    relativePath: string,
    syncScope?: ContentFilterReadOpts['syncScope'],
  ): boolean {
    // Unscoped paths and content-based sync walks are contentDir-relative;
    // the project-root sync walk is already project-relative. Converting at
    // this boundary keeps root-anchored ignore rules in git's coordinates.
    if (contentOutsideProject && syncScope?.pathBase !== 'project') return false;
    const projectRelPath =
      syncScope?.pathBase === 'project' || !contentRelPrefix
        ? relativePath
        : `${contentRelPrefix}/${relativePath}`;
    if (projectRelPath.startsWith('..')) return false;
    return ig.ignores(projectRelPath);
  }

  function syncProjectRelPath(
    relativePath: string,
    syncScope: NonNullable<ContentFilterReadOpts['syncScope']>,
  ): string {
    return syncScope.pathBase === 'project' || !contentRelPrefix
      ? relativePath
      : `${contentRelPrefix}/${relativePath}`;
  }

  function isOkIgnored(relativePath: string): boolean {
    if (contentOutsideProject) return false;
    const projectRelPath = contentRelPrefix ? `${contentRelPrefix}/${relativePath}` : relativePath;
    return okignoreIg.ignores(projectRelPath);
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
    // (e.g. a file written into `node_modules/`, or a non-carve-out `.ok`
    // child like `.ok/local/`) reach classifyEvents and must be rejected here,
    // otherwise they leak into the file index and surface in the file tree.
    // The `.ok/skills` and `.ok/templates` carve-outs run earlier in
    // `isExcluded`, so admitted skill/template leaves never reach this check.
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

      // A file under a known skill root that the canonical election did NOT
      // admit is a duplicate projection of a skill already represented by its
      // canonical bundle. Excluded ahead of that carve-out so it cannot be
      // re-admitted as ordinary content — the leak that made one skill render
      // once per editor dir it happened to be projected into.
      if (
        !opts?.bypassFilters &&
        isUnderSkillRoot(relativePath, skillRootPaths) &&
        !isInPlaceSkillFile(relativePath, inPlaceSkillDirs)
      ) {
        return true;
      }

      if (
        !opts?.bypassFilters &&
        (isSkillContentFile(relativePath) ||
          (isInPlaceSkillFile(relativePath, inPlaceSkillDirs) && !isIgnored(relativePath)))
      ) {
        if (singleDocRelPath !== undefined) return relativePath !== singleDocRelPath;
        if (isSupportedDocFile(relativePath)) return false;
        const ext = extname(relativePath).slice(1).toLowerCase();
        return !LINKABLE_ASSET_EXTENSIONS.has(ext);
      }

      // (0b') Template-as-content carve-out — a `.md` template leaf under any
      // `<folder>/.ok/templates/` is a content doc. Unlike skills, ONLY the
      // `.md` leaf is admitted (no linkable assets, no subdirectories). Same
      // `!bypassFilters` gate as the skills carve-out so Show All Files defers
      // to the always-skip floor; the single-file scope obligation is inherited
      // (omitting it would admit every template under `?docPath=`). Must precede
      // the always-skip floor, which prunes any `.ok` segment.
      if (!opts?.bypassFilters && isTemplateContentFile(relativePath)) {
        if (singleDocRelPath !== undefined) return relativePath !== singleDocRelPath;
        return false;
      }

      // (0b'') Shareable `.ok` artifacts, sync scope only — project config,
      // `.ok/.gitignore`, schemas, folder `frontmatter.yml` stage and
      // deletion-track so team-shareable state propagates. (Template leaves
      // are shareable too, but the ignore-blind carve-out above already
      // returned for them — they never reach this block, and in a local-only
      // project the sync engine's git-side staging probe, not this filter,
      // keeps the gathered templates out of `git add`.) Admission is
      // by allow-list membership alone: `.yml` / `.json` / `.gitignore`
      // leaves pass neither the doc-extension gate nor the sibling-asset
      // rule below. The `!isIgnored` conjunct keeps the gather walk and
      // `git add` agreed (precedent #55): under a local-only project's
      // blanket `.ok/` exclude these paths are git-refused, so gathering
      // them would strand the push. Without `syncScope` they fall to the
      // always-skip floor — the index and sidebar never see them.
      if (
        !opts?.bypassFilters &&
        opts?.syncScope !== undefined &&
        isShareableOkArtifact(syncProjectRelPath(relativePath, opts.syncScope)) &&
        !isIgnored(relativePath, opts.syncScope)
      ) {
        if (singleDocRelPath !== undefined) return relativePath !== singleDocRelPath;
        return false;
      }

      // (0c) Always-skip floor — VCS / dependency / OK-state dirs stay
      // excluded even under bypass. Defense-in-depth: the showAll walk gates
      // directories via `isDirExcluded`, but any caller enumerating files
      // directly must not admit `.git/` / `node_modules/` / `.ok/` content.
      // `showOk` re-admits `.ok` minus `worktrees`/`local` for the
      // tree-listing reveal.
      if (pathHasAlwaysSkipSegment(relativePath, opts?.showOk)) return true;

      // (0c') Junk-file floor — `.DS_Store` / `.localized` stay excluded even
      // under bypass, so Show All Files never surfaces OS Finder metadata.
      if (isAlwaysSkipFile(relativePath)) return true;

      // (0d) Single-file scope — admit ONLY the one target doc, everything else
      // excluded. Placed before the bypass branch so the scope holds even under
      // `?showAll=true`. In ephemeral mode `contentOutsideProject` is true (the
      // temp projectDir sits elsewhere), so the ignore-based logic below is
      // inert anyway — this short-circuit is the sole admission gate.
      if (singleDocRelPath !== undefined) return relativePath !== singleDocRelPath;

      // (B) Bypass mode admits everything else. The all-files sidebar keeps
      // `.okignore` active while bypassing Git/build defaults; other bypass
      // callers retain the original full-bypass behavior.
      if (opts?.bypassFilters) {
        return opts.respectOkignore === true && isOkIgnored(relativePath);
      }

      // (1) Configurable path rules — BUILTIN_SKIP_DIRS + ignore patterns.
      if (isRejectedByConfigurableRules(relativePath)) return true;

      // (2) Supported doc extension → include.
      //     `isSupportedDocFile` is the upstream extension gate (`.md`/`.mdx`).
      //     Callers like file-watcher.ts already pre-filter, but cover it here
      //     so this filter behaves correctly when called in isolation.
      if (isSupportedDocFile(relativePath)) return false;

      // (2a) Explicit attachment destination. A configured folder is itself
      // the evidence that these linkable assets belong to the project; it does
      // not need a markdown sibling. Configurable ignore rules already ran, so
      // `.gitignore` / `.okignore` and built-in boundaries still win.
      if (
        isConfiguredAttachmentAsset(
          relativePath,
          configuredAttachmentFolder,
          (dir) => (dirCount.get(dir) ?? 0) > 0,
        )
      )
        return false;

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
      // Skills- and templates-as-content: keep `.ok`, `.ok/skills[/**]`, and
      // any `<folder>/.ok/templates` descendable so the NORMAL index walk
      // reaches skill + template leaves; the file-level predicates keep the rest
      // of `.ok/` excluded. Gated on `!bypassFilters`: under Show All Files the
      // always-skip floor below must still prune `.ok` (it's an internal dir,
      // not user content — surfacing it as a folder broke the showAll
      // folder-listing contract and the hasFolders gate). Under `syncScope`
      // the flat `.ok/schemas` joins the descendable set so the sync gather
      // reaches schema leaves.
      if (
        !opts?.bypassFilters &&
        (isSkillContentAncestorDir(relativePath) ||
          isTemplateContentAncestorDir(relativePath) ||
          (opts?.syncScope !== undefined &&
            isShareableOkArtifactAncestorDir(syncProjectRelPath(relativePath, opts.syncScope))) ||
          isInPlaceSkillAncestorDir(relativePath, inPlaceSkillDirs))
      )
        return false;
      // Always-skip floor — prune VCS / dependency / OK-state dirs even under
      // bypass. Show All Files must never descend into `.git/`, `node_modules/`,
      // or `.ok/`: on a repo-root content dir those trees (a multi-GB `.git`,
      // thousands of `node_modules`) make the recursive walk unbounded and
      // exhaust the heap. This single prune is the load-bearing OOM fix —
      // traversal, not file admission, is what blows up. `showOk` re-admits
      // `.ok` for the tree-listing reveal while `worktrees`/`local` — the two
      // children that can be repo-scale — stay pruned, keeping the guard
      // honest.
      if (pathHasAlwaysSkipSegment(relativePath, opts?.showOk)) return true;
      // Single-file scope — descend only the chain of directories leading to
      // the one admitted doc; prune everything else so the watcher seed +
      // index walks never enumerate siblings. Before the bypass branch so the
      // scope is absolute (the single-file sidebar is hidden, but defense in
      // depth keeps showAll honest).
      if (singleDocRelPath !== undefined) {
        return !isSingleDocAncestorDir(relativePath, singleDocRelPath);
      }
      // Bypass then admits every OTHER directory. The all-files sidebar keeps
      // `.okignore` active while still surfacing `.gitignored` content like
      // `dist/` / `build/`.
      if (opts?.bypassFilters) {
        return (
          opts.respectOkignore === true &&
          (isOkIgnored(relativePath) || isOkIgnored(`${relativePath}/`))
        );
      }
      // Fast-path: built-in skips are always excluded regardless of ignore-file config.
      // Check ALL path segments, not just the top — handles nested `.ok/` (per-folder
      // metadata directories), nested `node_modules/`, nested `dist/`, etc.
      for (const segment of relativePath.split('/')) {
        if (BUILTIN_SKIP_DIRS.has(segment)) return true;
      }
      if (contentOutsideProject) return false;
      return (
        isIgnored(relativePath, opts?.syncScope) || isIgnored(`${relativePath}/`, opts?.syncScope)
      );
    },

    isPathIgnored(relativePath: string, opts?: ContentFilterPathReadOpts): boolean {
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
      if (
        isSkillContentFile(relativePath) ||
        (isInPlaceSkillFile(relativePath, inPlaceSkillDirs) && !isIgnored(relativePath))
      )
        return false;
      // Templates-as-content: a `.md` template leaf is servable content too.
      // Ungated (like the skills carve-out here) and admitted before the `.ok`
      // always-skip floor.
      if (isTemplateContentFile(relativePath)) return false;
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
        log.warn(
          { err: err instanceof Error ? err : new Error(String(err)) },
          'content-filter rebuildDirCount walk failed — retaining previous counts',
        );
      }
    },

    setAttachmentFolderPath(value: string): void {
      configuredAttachmentFolder = attachmentFolderShape(value);
    },

    async rebuildIgnorePatterns(): Promise<RebuildResult> {
      // Refresh the in-place skill allow-list first (live re-scan): the new
      // set governs the dirCount refresh + every predicate after the swap. A
      // provider throw keeps the previous set (fail-soft, matching the
      // per-file ignore-read semantics).
      if (opts.rescanInPlaceSkillDirs) {
        try {
          inPlaceSkillDirs = opts.rescanInPlaceSkillDirs();
        } catch (err) {
          log.warn({ err }, 'in-place skill re-scan failed — keeping previous allow-list');
        }
      }

      // Snapshot for rollback. dirCount is too large to snapshot — we re-walk
      // it from the rolled-back ig instance if rebuild fails partway.
      const prevIg = ig;
      const prevOkignoreIg = okignoreIg;
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
          okignoreIg = prevOkignoreIg;
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
    log.warn({ dir, err }, `Failed to read directory for dir-count: ${dir}`);
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
  okignoreIg: Ignore,
  bytesAcc: { value: number },
): number {
  let entries: import('node:fs').Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    log.warn({ dir, err }, `Failed to read directory ${dir}`);
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
        if (name === '.okignore') okignoreIg.add(prefixed);
        count++;
      } catch (err) {
        log.warn({ path: filePath, err }, `Failed to read nested ${name} at ${filePath}`);
      }
    }

    // Recurse into subdirectory
    count += loadNestedIgnoreFiles(dirPath, projectDir, ig, okignoreIg, bytesAcc);
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
  okignoreIg: Ignore,
  contentRelPrefix: string,
  contentOutsideProject: boolean,
  dirCount: Map<string, number>,
): Promise<void> {
  let entries: import('node:fs').Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    log.warn({ dir, err }, `Failed to read directory ${dir}`);
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
            const prefixed = patterns.map((p) => prefixPattern(p, relToProject));
            ig.add(prefixed);
            if (name === '.okignore') okignoreIg.add(prefixed);
          } catch (err) {
            log.warn({ path: filePath, err }, `Failed to read nested ${name} at ${filePath}`);
          }
        }
      }

      // Sequential recursion — keeps ig mutations in traversal order.
      await initContentDirStateAsync(
        dirPath,
        childRel,
        projectDir,
        ig,
        okignoreIg,
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
  let inPlaceSkillDirs: ReadonlySet<string> = opts.inPlaceSkillDirs ?? new Set();
  let configuredAttachmentFolder = attachmentFolderShape(
    opts.attachmentFolderPath ?? DEFAULT_ATTACHMENT_FOLDER_PATH,
  );
  const skillRootPaths: ReadonlySet<string> = opts.skillRootPaths ?? new Set();

  const contentRelPrefix = toPosix(relative(projectDir, contentDir));
  const contentOutsideProject = contentRelPrefix.startsWith('..');

  // Mutable bindings — swapped atomically by rebuildIgnorePatterns().
  let ig = ignore();
  let okignoreIg = ignore();
  let watcherIgnoreGlobs: string[] = [];
  let lastPatternCount = 0;

  const dirCount = new Map<string, number>();

  // Single-file scope guard for the refcount walk — see the sync variant's
  // `refreshDirCount` for the full rationale (boot-stall + privacy on a large
  // parent dir; sibling-asset admission is unreachable in single-file mode).
  const refreshDirCount = (): void => {
    if (singleDocRelPath !== undefined) return;
    populateDirCount(contentDir, '', isIgnored, dirCount);
  };

  function isIgnored(
    relativePath: string,
    syncScope?: ContentFilterReadOpts['syncScope'],
  ): boolean {
    if (contentOutsideProject && syncScope?.pathBase !== 'project') return false;
    const projectRelPath =
      syncScope?.pathBase === 'project' || !contentRelPrefix
        ? relativePath
        : `${contentRelPrefix}/${relativePath}`;
    if (projectRelPath.startsWith('..')) return false;
    return ig.ignores(projectRelPath);
  }

  function syncProjectRelPath(
    relativePath: string,
    syncScope: NonNullable<ContentFilterReadOpts['syncScope']>,
  ): string {
    return syncScope.pathBase === 'project' || !contentRelPrefix
      ? relativePath
      : `${contentRelPrefix}/${relativePath}`;
  }

  function isOkIgnored(relativePath: string): boolean {
    if (contentOutsideProject) return false;
    const projectRelPath = contentRelPrefix ? `${contentRelPrefix}/${relativePath}` : relativePath;
    return okignoreIg.ignores(projectRelPath);
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
    const newOkignoreIg = ignore();
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
        if (name === '.okignore') newOkignoreIg.add(patterns);
      } catch (err) {
        log.warn({ path, err }, `Failed to read ${name} at ${path}`);
      }
    }

    if (contentRelPrefix && !contentOutsideProject) {
      for (const name of IGNORE_FILE_NAMES) {
        const path = join(contentDir, name);
        if (!existsSync(path)) continue;
        try {
          const patterns = parseIgnorePatterns(await readFileAsync(path, 'utf-8'));
          const prefixed = patterns.map((p) => prefixPattern(p, contentRelPrefix));
          newIg.add(prefixed);
          if (name === '.okignore') newOkignoreIg.add(prefixed);
        } catch (err) {
          log.warn({ path, err }, `Failed to read ${name} at ${path}`);
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
        newOkignoreIg,
        contentRelPrefix,
        contentOutsideProject,
        newDirCount,
      );
    }

    // Atomic swap.
    ig = newIg;
    okignoreIg = newOkignoreIg;
    watcherIgnoreGlobs = buildWatcherIgnoreGlobs(newRootPatterns);
    lastPatternCount = newRootPatterns.length;
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

      // A file under a known skill root that the canonical election did NOT
      // admit is a duplicate projection of a skill already represented by its
      // canonical bundle. Excluded ahead of that carve-out so it cannot be
      // re-admitted as ordinary content — the leak that made one skill render
      // once per editor dir it happened to be projected into.
      if (
        !opts?.bypassFilters &&
        isUnderSkillRoot(relativePath, skillRootPaths) &&
        !isInPlaceSkillFile(relativePath, inPlaceSkillDirs)
      ) {
        return true;
      }

      if (
        !opts?.bypassFilters &&
        (isSkillContentFile(relativePath) ||
          (isInPlaceSkillFile(relativePath, inPlaceSkillDirs) && !isIgnored(relativePath)))
      ) {
        if (singleDocRelPath !== undefined) return relativePath !== singleDocRelPath;
        if (isSupportedDocFile(relativePath)) return false;
        const skillExt = extname(relativePath).slice(1).toLowerCase();
        return !LINKABLE_ASSET_EXTENSIONS.has(skillExt);
      }
      // Template-as-content carve-out — a `.md` template leaf under any
      // `<folder>/.ok/templates/` is a content doc (see sync variant, incl. the
      // `!bypassFilters` gate and the inherited single-file scope obligation).
      if (!opts?.bypassFilters && isTemplateContentFile(relativePath)) {
        if (singleDocRelPath !== undefined) return relativePath !== singleDocRelPath;
        return false;
      }
      // Shareable `.ok` artifacts, sync scope only (see sync variant for the
      // allow-list rationale and the precedent #55 `!isIgnored` conjunct).
      if (
        !opts?.bypassFilters &&
        opts?.syncScope !== undefined &&
        isShareableOkArtifact(syncProjectRelPath(relativePath, opts.syncScope)) &&
        !isIgnored(relativePath, opts.syncScope)
      ) {
        if (singleDocRelPath !== undefined) return relativePath !== singleDocRelPath;
        return false;
      }
      // Always-skip floor — survives bypass; `showOk` re-admits `.ok` minus
      // `worktrees`/`local` (see sync variant for rationale).
      if (pathHasAlwaysSkipSegment(relativePath, opts?.showOk)) return true;
      // Junk-file floor — `.DS_Store` / `.localized` survive bypass too.
      if (isAlwaysSkipFile(relativePath)) return true;
      // Single-file scope — admit ONLY the one target doc (see sync variant).
      if (singleDocRelPath !== undefined) return relativePath !== singleDocRelPath;
      if (opts?.bypassFilters) {
        return opts.respectOkignore === true && isOkIgnored(relativePath);
      }
      if (isRejectedByConfigurableRules(relativePath)) return true;
      if (isSupportedDocFile(relativePath)) return false;
      if (
        isConfiguredAttachmentAsset(
          relativePath,
          configuredAttachmentFolder,
          (dir) => (dirCount.get(dir) ?? 0) > 0,
        )
      )
        return false;
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
      // Skills- and templates-as-content: keep `.ok` / `.ok/skills[/**]` and any
      // `<folder>/.ok/templates` descendable for the NORMAL index walk only (see
      // sync variant); under bypass the always-skip floor below keeps `.ok`
      // pruned. Under `syncScope` the flat `.ok/schemas` joins the descendable
      // set (see sync variant).
      if (
        !opts?.bypassFilters &&
        (isSkillContentAncestorDir(relativePath) ||
          isTemplateContentAncestorDir(relativePath) ||
          (opts?.syncScope !== undefined &&
            isShareableOkArtifactAncestorDir(syncProjectRelPath(relativePath, opts.syncScope))) ||
          isInPlaceSkillAncestorDir(relativePath, inPlaceSkillDirs))
      )
        return false;
      // Always-skip floor — survives bypass; load-bearing OOM fix for the
      // `?showAll=true` walk. `showOk` re-admits `.ok` minus
      // `worktrees`/`local` (see sync variant for rationale).
      if (pathHasAlwaysSkipSegment(relativePath, opts?.showOk)) return true;
      // Single-file scope — prune every dir that isn't an ancestor of the one
      // admitted doc (see sync variant).
      if (singleDocRelPath !== undefined) {
        return !isSingleDocAncestorDir(relativePath, singleDocRelPath);
      }
      if (opts?.bypassFilters) {
        return (
          opts.respectOkignore === true &&
          (isOkIgnored(relativePath) || isOkIgnored(`${relativePath}/`))
        );
      }
      for (const segment of relativePath.split('/')) {
        if (BUILTIN_SKIP_DIRS.has(segment)) return true;
      }
      if (contentOutsideProject) return false;
      return (
        isIgnored(relativePath, opts?.syncScope) || isIgnored(`${relativePath}/`, opts?.syncScope)
      );
    },

    isPathIgnored(relativePath: string, opts?: ContentFilterPathReadOpts): boolean {
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
      if (
        isSkillContentFile(relativePath) ||
        (isInPlaceSkillFile(relativePath, inPlaceSkillDirs) && !isIgnored(relativePath))
      )
        return false;
      // Templates-as-content: a `.md` template leaf is servable content too
      // (ungated, see sync variant).
      if (isTemplateContentFile(relativePath)) return false;
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
        log.warn(
          { err: err instanceof Error ? err : new Error(String(err)) },
          'content-filter rebuildDirCount walk failed — retaining previous counts',
        );
      }
    },

    setAttachmentFolderPath(value: string): void {
      configuredAttachmentFolder = attachmentFolderShape(value);
    },

    async rebuildIgnorePatterns(): Promise<RebuildResult> {
      // Refresh the in-place skill allow-list first (live re-scan) — mirrors
      // the sync factory; a provider throw keeps the previous set.
      if (opts.rescanInPlaceSkillDirs) {
        try {
          inPlaceSkillDirs = opts.rescanInPlaceSkillDirs();
        } catch (err) {
          log.warn({ err }, 'in-place skill re-scan failed — keeping previous allow-list');
        }
      }
      const prevIg = ig;
      const prevOkignoreIg = okignoreIg;
      const prevWatcherGlobs = watcherIgnoreGlobs;
      const prevDirCount = new Map(dirCount);
      const startedAt = Date.now();

      return withSpan('config.ignore.rebuild', { attributes: {} }, async (span) => {
        try {
          await buildAndSwapPatternState();
          const durationMs = Date.now() - startedAt;
          span.setAttributes({
            'ok.ignore.pattern_count': lastPatternCount,
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
            patternCount: lastPatternCount,
            nestedFileCount: 0,
            bytes: 0,
            durationMs,
          };
        } catch (err) {
          ig = prevIg;
          okignoreIg = prevOkignoreIg;
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
