/**
 * `sharing/git-exclude.ts` — manage the OK artifact set in `.git/info/exclude`.
 *
 * Single source of truth for the sharing-mode toggle. The user's posture — share OK config with the team
 * (default) or keep it local-only on this machine — is encoded ENTIRELY in
 * `.git/info/exclude`. No parallel registry; `readSharingMode` derives the
 * mode by checking whether any OK artifact appears in the exclude file.
 *
 * Worktree-aware: every read/write resolves the gitdir via
 * `resolveGitDirDetailed` from `@inkeep/open-knowledge-core` so linked
 * worktrees (where `<projectRoot>/.git` is a pointer file) write to the
 * correct `<repo>/.git/worktrees/<name>/info/exclude`, not a non-existent
 * `<projectRoot>/.git/info/exclude`.
 *
 * Every transition to local-only (init `--local-only`, `ok config-sharing unshare`,
 * desktop create radio, desktop settings panel) flows through
 * `addOkPathsToGitExclude`. That function runs `probeTrackedOkPaths`
 * internally and refuses the write when any OK artifact is already tracked
 * upstream — `.git/info/exclude` cannot hide tracked files, so silently
 * completing the operation would mislead the user. One probe site, one
 * refusal site, one diagnostic.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  EDITOR_PROJECT_SKILL_ROOT,
  type EditorId,
  INSTALLED_SKILLS_REL,
  OK_DIR,
  parseInstalledSkills,
} from '@inkeep/open-knowledge-core';
// `resolveGitDirDetailed` is in the `node:fs`-importing subpath of core —
// the barrel deliberately omits it to keep the main entry browser-safe
// (see `packages/core/src/index.ts`).
import { resolveGitDirDetailed } from '@inkeep/open-knowledge-core/shadow-repo-layout';
import { ALL_EDITOR_IDS, EDITOR_TARGETS } from '../commands/editors.ts';

/**
 * Claude's project-scope launcher entry. Not exposed via `EDITOR_TARGETS`
 * (it's a per-project artifact, not a per-editor integration — see
 * `writeProjectAiIntegrations`) so it must be enumerated explicitly here.
 */
const CLAUDE_LAUNCH_JSON = '.claude/launch.json';

/**
 * The project's OK ignore file (`.okignore`, gitignore syntax). Lives at the
 * project root and, like `.gitignore`, can also appear nested at any folder
 * depth — both covered by the unanchored entry in `getOkArtifactPaths`.
 */
const OK_IGNORE_FILENAME = '.okignore';

/**
 * Result of an `addOkPathsToGitExclude` / `removeOkPathsFromGitExclude` call
 * that completed the variant-matching pass against the exclude file.
 *
 * `no-exclude` is a sub-typed no-op: the gitdir is unresolvable, the
 * resolved gitdir has no `info/` dir, the `.git` pointer is malformed, or
 * the `.git` entry is inaccessible. Callers map each sub-reason to a
 * different user-facing message; all four are non-fatal for sharing-mode
 * itself.
 */
export type ExcludeWriteResult =
  | { kind: 'updated'; appended: string[]; alreadyPresent: string[]; removed: string[] }
  | {
      kind: 'no-exclude';
      reason: 'no-git' | 'no-info-dir' | 'malformed-pointer' | 'inaccessible';
    };

/**
 * Refusal returned by `addOkPathsToGitExclude` when one or more candidate
 * paths are already tracked upstream. Carries the pre-formatted remediation
 * message so the CLI and desktop surface identical copy.
 */
export interface TrackedRefusal {
  kind: 'refused-tracked';
  /** Paths currently tracked upstream (subset of the input `paths`). */
  tracked: string[];
  /** Pre-formatted, multi-line user-facing diagnostic. */
  remediation: string;
}

/** Resolved sharing-mode reading derived from `.git/info/exclude` content. */
export type SharingMode = 'shared' | 'local-only' | 'no-git';

/**
 * Return the canonical OK artifact set for a project. Artifact classes:
 *
 *  - `.ok/`                              — whole-tree, config + folder configs
 *  - `.okignore`                         — project ignore file (gitignore syntax)
 *  - `.mcp.json`                        — Claude Code project MCP (merged file)
 *  - `.cursor/mcp.json`                 — Cursor project MCP (merged file)
 *  - `.codex/config.toml`               — Codex project MCP (merged file)
 *  - `.claude/skills/open-knowledge/`   — Claude project SKILL.md bundle (whole-tree)
 *  - `.cursor/skills/open-knowledge/`   — Cursor project SKILL.md bundle (whole-tree)
 *  - `.codex/skills/open-knowledge/`    — Codex project SKILL.md bundle (whole-tree)
 *  - `.claude/launch.json`              — Claude launcher entry (merged file)
 *
 * `.ok/` and `.okignore` are emitted UNANCHORED (slash-free). gitignore
 * matches a slash-free pattern at every depth, so one entry each covers the
 * project-root `.ok/` (where `config.yml` lives — it is read from
 * `<projectRoot>/.ok/`, regardless of `content.dir`), the content-dir copy,
 * and folder-nested copies. This is intentionally content.dir-independent:
 * anchoring to `<contentDir>/.ok/` misses the project-root config dir
 * whenever `content.dir` is a subdirectory, leaving the primary OK config
 * committable in local-only mode.
 *
 * Returns POSIX-separated, project-root-relative paths. Directory entries
 * carry a trailing `/` so the gitignore syntax in `.git/info/exclude` treats
 * them as whole-tree excludes; file entries do not.
 *
 * Derives the per-editor `projectConfigPath` / `projectSkillPath` slots from
 * `EDITOR_TARGETS` so a future editor entry with project-scope artifacts
 * flows through automatically — no hand-maintained list.
 */
export function getOkArtifactPaths(projectRoot: string): readonly string[] {
  // `.ok/` and `.okignore` are unanchored — a slash-free gitignore pattern
  // matches at any depth, so one entry each covers the project-root config
  // dir, the content-dir copy, and folder-nested copies, regardless of
  // `content.dir`.
  const paths: string[] = [`${OK_DIR}/`, OK_IGNORE_FILENAME];
  for (const id of ALL_EDITOR_IDS) {
    const target = EDITOR_TARGETS[id];
    if (target.projectConfigPath) {
      paths.push(toProjectRelative(target.projectConfigPath(projectRoot), projectRoot));
    }
    if (target.projectSkillPath) {
      // The target points at `<dir>/SKILL.md`; exclude the whole bundle
      // dir so future skill assets (manifest, scripts/, etc.) are covered
      // by the same line. Equivalent to writing both `SKILL.md` and the
      // dir separately, but cleaner in the exclude file.
      const skillFile = toProjectRelative(target.projectSkillPath(projectRoot), projectRoot);
      paths.push(`${dirnamePosix(skillFile)}/`);
    }
  }
  paths.push(CLAUDE_LAUNCH_JSON);

  // The loop above only excludes the single
  // hardcoded `open-knowledge` bundle per editor — authored skills
  // (`.{host}/skills/<name>/`) and pack skills would still leak in
  // local-only mode. Enumerate the installed-skill set and
  // exclude each skill's projection per the hosts it was installed to. A
  // blanket `skills/` exclude would over-reach into hand-placed non-OK
  // skills, so this is installed-skill-set-aware (only OK-managed
  // projections). When no marker exists (nothing installed on this machine),
  // only the bundle excludes apply.
  const markerPath = join(projectRoot, ...INSTALLED_SKILLS_REL);
  if (existsSync(markerPath)) {
    try {
      const marker = parseInstalledSkills(readFileSync(markerPath, 'utf-8'));
      if (marker) {
        for (const [name, entry] of Object.entries(marker.skills)) {
          for (const host of entry.hosts) {
            const root = EDITOR_PROJECT_SKILL_ROOT[host as EditorId];
            if (root) paths.push(`${root}/${name}/`);
          }
        }
      }
    } catch {
      // TOCTOU: the marker (written atomically via tmp+rename) can vanish or
      // become unreadable between the existsSync check and the read. Treat as
      // no installs so `readSharingMode` honors its documented never-throws
      // contract (it runs on the desktop UI mount path).
    }
  }

  // De-dupe while preserving insertion order so the artifact set's emitted
  // order is stable for tests and the `ok config-sharing status` output.
  return Array.from(new Set(paths));
}

/**
 * Append each path to `<gitdir>/info/exclude`, idempotent against the four
 * recognized variants per path. Runs `probeTrackedOkPaths` FIRST — when any
 * candidate path is tracked upstream, returns `TrackedRefusal` and does NOT
 * write. The probe runs at exactly one site (this function) so the
 * safety check fires uniformly across every transition to local-only.
 *
 * Returns `kind: 'updated'` on a successful append-or-noop pass. The
 * `appended` and `alreadyPresent` arrays partition the input.
 *
 * Returns `kind: 'no-exclude'` when the gitdir / info-dir is unresolvable;
 * callers treat this as a no-op (sharing-mode is a `.git`-only feature, and
 * a non-git project has nothing to opt out of).
 */
export function addOkPathsToGitExclude(
  projectRoot: string,
  paths: readonly string[],
): ExcludeWriteResult | TrackedRefusal {
  const tracked = probeTrackedOkPaths(projectRoot, paths).tracked;
  if (tracked.length > 0) {
    return {
      kind: 'refused-tracked',
      tracked,
      remediation: formatTrackedRemediation(tracked),
    };
  }
  const resolved = resolveExcludePath(projectRoot);
  if (resolved.kind !== 'ok') return resolved.result;

  const existing = existsSync(resolved.path) ? readFileSync(resolved.path, 'utf-8') : '';
  const presentVariants = collectPresentVariants(existing);

  const appended: string[] = [];
  const alreadyPresent: string[] = [];
  for (const p of paths) {
    if (hasAnyVariant(presentVariants, p)) {
      alreadyPresent.push(p);
    } else {
      appended.push(p);
    }
  }

  if (appended.length === 0) {
    return { kind: 'updated', appended, alreadyPresent, removed: [] };
  }

  const separator = existing.length === 0 || existing.endsWith('\n') ? '' : '\n';
  const additions = `${appended.join('\n')}\n`;
  try {
    writeFileSync(resolved.path, `${existing}${separator}${additions}`, 'utf-8');
  } catch {
    // EACCES / ENOSPC / EROFS must not escape as an uncaught throw: callers
    // (CLI commands, the desktop consent flow) promise a typed result and
    // treat sharing-mode as a non-fatal side-effect. Map to the existing
    // `inaccessible` reason, which every caller already renders.
    return { kind: 'no-exclude', reason: 'inaccessible' };
  }

  return { kind: 'updated', appended, alreadyPresent, removed: [] };
}

/**
 * Remove every line in `<gitdir>/info/exclude` that matches any of the
 * four recognized variants for any path. Preserves every other line
 * byte-identical — no whitespace normalization, no reordering, no
 * surrounding-line touching. The variant set is the same one
 * `addOkPathsToGitExclude` and `readSharingMode` use, so add-remove-add
 * cycles round-trip cleanly.
 *
 * No tracked-files probe: going local-only → shared cannot create a
 * tracking conflict (tracking state is orthogonal to the exclude file).
 */
export function removeOkPathsFromGitExclude(
  projectRoot: string,
  paths: readonly string[],
): ExcludeWriteResult {
  const resolved = resolveExcludePath(projectRoot);
  if (resolved.kind !== 'ok') return resolved.result;
  if (!existsSync(resolved.path)) {
    return { kind: 'updated', appended: [], alreadyPresent: [], removed: [] };
  }

  const variantsByPath = paths.map((p) => buildVariants(p));
  // Single flat variant set for fast per-line membership testing.
  const allVariants = new Set<string>();
  for (const set of variantsByPath) {
    for (const v of set) allVariants.add(v);
  }

  let before: string;
  try {
    before = readFileSync(resolved.path, 'utf-8');
  } catch {
    return { kind: 'no-exclude', reason: 'inaccessible' };
  }
  // Use a string split that preserves the trailing-newline boundary so we
  // can rebuild byte-identically. `split('\n')` on `a\nb\n` yields
  // `['a','b','']`; rejoining with `\n` reproduces the original — no
  // whitespace mangling.
  const lines = before.split('\n');
  const removedLines = new Set<string>();
  const kept: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (allVariants.has(trimmed)) {
      removedLines.add(trimmed);
      continue;
    }
    kept.push(line);
  }

  // The artifact paths whose lines were actually removed this invocation —
  // the honest set callers report (e.g. `ok config-sharing share --json`),
  // rather than the full candidate list.
  const removed = paths.filter((p) => {
    for (const v of buildVariants(p)) {
      if (removedLines.has(v)) return true;
    }
    return false;
  });

  if (removedLines.size === 0) {
    return { kind: 'updated', appended: [], alreadyPresent: [], removed: [] };
  }

  const after = kept.join('\n');
  if (after !== before) {
    try {
      writeFileSync(resolved.path, after, 'utf-8');
    } catch {
      return { kind: 'no-exclude', reason: 'inaccessible' };
    }
  }
  return { kind: 'updated', appended: [], alreadyPresent: [], removed };
}

/**
 * Read the current sharing mode. `local-only` iff at least one variant for
 * any path in `getOkArtifactPaths(projectRoot)` appears in
 * `.git/info/exclude`. `shared` when none match. `no-git` when the gitdir
 * is unresolvable (non-git project, malformed pointer, or inaccessible).
 *
 * Pure read — never throws, never writes. Safe to call from the desktop UI
 * mount path or from CI lockfile scripts.
 */
export function readSharingMode(projectRoot: string): SharingMode {
  const resolved = resolveExcludePath(projectRoot);
  if (resolved.kind !== 'ok') {
    return resolved.result.reason === 'no-git' ||
      resolved.result.reason === 'malformed-pointer' ||
      resolved.result.reason === 'inaccessible'
      ? 'no-git'
      : 'shared';
  }
  if (!existsSync(resolved.path)) return 'shared';
  let content: string;
  try {
    content = readFileSync(resolved.path, 'utf-8');
  } catch {
    // TOCTOU: the file can vanish or lose read permission between the
    // existsSync check and here (NFS/FUSE/container/permission change).
    // "Pure read — never throws"; treat an unreadable exclude as no opt-out.
    return 'shared';
  }
  const present = collectPresentVariants(content);
  const artifacts = getOkArtifactPaths(projectRoot);
  for (const p of artifacts) {
    if (hasAnyVariant(present, p)) return 'local-only';
  }
  return 'shared';
}

/**
 * Return the subset of `getOkArtifactPaths(projectRoot)` that currently
 * appears in `.git/info/exclude` (matched via the canonical four-variant
 * spelling tolerance). Pure read — never writes, never throws. Empty array
 * when the gitdir is unresolvable.
 *
 * Used by `ok config-sharing status` to render the excluded-paths section and by
 * the desktop settings panel for the equivalent UI list. Lives next to
 * `readSharingMode` so both observable read paths share one variant-match
 * implementation — no `excludeFileContains`-style duplicate.
 */
export function getExcludedOkPaths(projectRoot: string): readonly string[] {
  const resolved = resolveExcludePath(projectRoot);
  if (resolved.kind !== 'ok') return [];
  if (!existsSync(resolved.path)) return [];
  let content: string;
  try {
    content = readFileSync(resolved.path, 'utf-8');
  } catch {
    return [];
  }
  const present = collectPresentVariants(content);
  return getOkArtifactPaths(projectRoot).filter((p) => hasAnyVariant(present, p));
}

/**
 * Pure probe — checks which of `paths` (if any) are currently tracked
 * upstream via `git ls-files --error-unmatch`. Used at exactly one site
 * inside `addOkPathsToGitExclude`, plus by `ok config-sharing status` to surface
 * the tracked set in the read-only report. Skips paths that don't exist
 * on disk — there's nothing to potentially conflict.
 *
 * `git ls-files --error-unmatch <p>` exits 0 iff at least one index entry
 * matches the pathspec. Works for both files and directories — the
 * directory form expands to "any tracked file under this path."
 */
export function probeTrackedOkPaths(
  projectRoot: string,
  paths: readonly string[],
): { tracked: string[] } {
  const tracked: string[] = [];
  for (const p of paths) {
    const abs = resolve(projectRoot, p);
    if (!existsSync(abs)) continue;
    try {
      execFileSync('git', ['ls-files', '--error-unmatch', '--', p], {
        cwd: projectRoot,
        stdio: ['ignore', 'ignore', 'ignore'],
      });
      tracked.push(p);
    } catch {
      // Non-zero exit — `--error-unmatch` failed because no index entry
      // matches. Path is untracked; nothing to refuse on.
    }
  }
  return { tracked };
}

/**
 * Format the tracked-files diagnostic. Single source of truth for the
 * remediation copy — the CLI prints it to stderr, the desktop modal
 * renders the same string.
 *
 * The hand-crafted shape lists each tracked path, names the exact
 * `git rm --cached` command for each, and warns about the
 * teammate-side-effect of an `rm --cached` (the deletion propagates on
 * next pull). Loud and explicit.
 */
export function formatTrackedRemediation(tracked: readonly string[]): string {
  const lines: string[] = [];
  lines.push('Cannot switch OpenKnowledge to local-only — these OK files are tracked upstream:');
  lines.push('');
  for (const p of tracked) lines.push(`  ${p}`);
  lines.push('');
  lines.push(
    ".git/info/exclude only hides files that git isn't already tracking. To proceed, untrack them first:",
  );
  lines.push('');
  for (const p of tracked) {
    const arg = p.replace(/\/$/, '');
    const recursive = p.endsWith('/') ? '-r ' : '';
    lines.push(`  git rm --cached ${recursive}${arg}`);
  }
  lines.push('');
  lines.push(
    "Then re-run the command. Note: `git rm --cached` removes the files from the index — your teammates will see a deletion on their next pull. If you don't want that, leave sharing mode set to 'shared'.",
  );
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

type ResolveExcludePathResult =
  | { kind: 'ok'; path: string }
  | { kind: 'no-exclude'; result: Extract<ExcludeWriteResult, { kind: 'no-exclude' }> };

/**
 * Resolve `<gitdir>/info/exclude` via the shared resolver. Maps each
 * non-directory / non-linked outcome to a typed `no-exclude` sub-reason so
 * callers don't need to handle `MalformedGitPointerError` /
 * `GitDirAccessError` themselves.
 *
 * Order of precedence — gitdir resolution first, then `info/` existence.
 * Skipping the `info/` check when the gitdir is resolvable but lacks an
 * `info/` dir would silently no-op rather than telling callers why.
 */
function resolveExcludePath(projectRoot: string): ResolveExcludePathResult {
  const detail = resolveGitDirDetailed(projectRoot);
  switch (detail.kind) {
    case 'directory':
    case 'linked': {
      // `.git/info/exclude` is a per-clone artifact, not a per-worktree one.
      // In a linked worktree, `<projectRoot>/.git` points at the per-worktree
      // admin dir (`<repo>/.git/worktrees/<name>/`), but the exclude file
      // lives in the COMMON dir (the shared `<repo>/.git/`). Git stores the
      // path to the common dir in a `commondir` file inside the admin dir,
      // relative to that admin dir. For main worktrees, no `commondir` file
      // exists and the gitdir IS the common dir.
      const commonDir = resolveCommonDir(detail.path);
      const info = join(commonDir, 'info');
      if (!existsSync(info)) {
        return { kind: 'no-exclude', result: { kind: 'no-exclude', reason: 'no-info-dir' } };
      }
      return { kind: 'ok', path: join(info, 'exclude') };
    }
    case 'absent':
      return { kind: 'no-exclude', result: { kind: 'no-exclude', reason: 'no-git' } };
    case 'malformed-pointer':
      return {
        kind: 'no-exclude',
        result: { kind: 'no-exclude', reason: 'malformed-pointer' },
      };
    case 'inaccessible':
      return { kind: 'no-exclude', result: { kind: 'no-exclude', reason: 'inaccessible' } };
  }
}

/**
 * Resolve the common-dir of a gitdir. In a linked worktree, the per-worktree
 * admin dir contains a `commondir` text file whose body is a path
 * (typically relative) to the shared `.git` directory. In a main worktree,
 * no `commondir` file exists and the gitdir IS the common dir.
 *
 * The `commondir` body is git's documented mechanism for resolving shared
 * per-clone artifacts (refs/, objects/, info/, hooks/) from a linked
 * worktree's gitdir; we use the same mechanism rather than re-running
 * `git rev-parse --git-common-dir` so the resolution stays in-process and
 * doesn't depend on a working `git` binary at sharing-mode evaluation time.
 */
function resolveCommonDir(gitDir: string): string {
  const commondirFile = join(gitDir, 'commondir');
  if (!existsSync(commondirFile)) return gitDir;
  let body: string;
  try {
    body = readFileSync(commondirFile, 'utf-8').trim();
  } catch {
    return gitDir;
  }
  if (body.length === 0) return gitDir;
  return isAbsolute(body) ? body : resolve(gitDir, body);
}

/**
 * Recognized variants for a single artifact path. Mirrors gitignore's
 * tolerance for the four common spellings: with/without trailing slash,
 * with/without leading slash. Used at both write sites (`add`/`remove`)
 * and the read site (`readSharingMode`) so the variant set cannot drift.
 */
function buildVariants(path: string): Set<string> {
  const noTrail = path.replace(/\/$/, '');
  return new Set([path, noTrail, `/${path}`, `/${noTrail}`]);
}

function hasAnyVariant(presentVariants: Set<string>, path: string): boolean {
  for (const v of buildVariants(path)) {
    if (presentVariants.has(v)) return true;
  }
  return false;
}

/**
 * Pre-compute the set of every variant line present in the exclude file,
 * so the variant check is O(P × 4) instead of O(P × N × 4) where N is the
 * exclude-file line count. Exact-match semantics — trimmed line equality
 * against the variant set, no glob expansion (those are gitignore-engine
 * concerns we explicitly stay out of).
 */
function collectPresentVariants(excludeFileContent: string): Set<string> {
  const present = new Set<string>();
  for (const raw of excludeFileContent.split('\n')) {
    const trimmed = raw.trim();
    if (trimmed.length === 0) continue;
    present.add(trimmed);
  }
  return present;
}

/**
 * Convert a target's absolute project-relative path (the output of
 * `EDITOR_TARGETS[id].projectConfigPath(projectRoot)`) into a POSIX,
 * project-root-relative string suitable for `.git/info/exclude`. The
 * exclude file's matching is POSIX-style regardless of platform — Windows
 * paths must be normalized to forward slashes before they land there.
 */
function toProjectRelative(absPath: string, projectRoot: string): string {
  return toPosix(relative(projectRoot, absPath));
}

/** POSIX-ify a path string. Idempotent on already-POSIX inputs. */
function toPosix(p: string): string {
  return sep === '/' ? p : p.split(sep).join('/');
}

/**
 * Directory-of, POSIX semantics. `dirname('foo/bar')` is `'foo'`. Used to
 * shorten an editor's `projectSkillPath` (a file path ending in
 * `SKILL.md`) into the bundle dir we exclude as a whole tree.
 */
function dirnamePosix(p: string): string {
  const ix = p.lastIndexOf('/');
  return ix < 0 ? '.' : p.slice(0, ix);
}
