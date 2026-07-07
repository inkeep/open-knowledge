/**
 * Shadow-repo layout helpers — shared between CLI (read path) and server
 * (write path).
 *
 * The shadow repo lives at `<gitdir>/ok/`, where `<gitdir>` is resolved via
 * `resolveGitDir(projectRoot)`:
 *   - Main worktree: `<projectRoot>/.git/ok/` (`.git` is a directory).
 *   - Linked worktree: `<repo>/.git/worktrees/<name>/ok/` (`.git` is a pointer
 *     file; the bare repo lives inside Git's per-worktree admin dir, so
 *     `git worktree remove` cleans it up automatically).
 *
 * Main-worktree path is bit-identical to pre-worktree-support behavior, so
 * existing main-worktree shadows do not migrate. Pre-rename integrated shadows
 * at `.git/openknowledge/` (legacy path) are silently rename-migrated in-place
 * once per repo via `initShadowRepo()`. Its on-disk layout is a documented
 * invariant:
 *
 *   refs/wip/<project-branch>/<writer-id>
 *
 * where `<writer-id>` is one of the five recognized forms in the writer-ID
 * taxonomy (dropping the legacy `human-` prefix and the opaque `server` writer):
 *   - `agent-<connectionId>`     — an MCP agent session wrote the commit
 *   - `principal-<UUID>`         — a browser-tab principal wrote the commit
 *   - `file-system`              — classified: disk reconcile (file-watcher)
 *   - `git-upstream`             — classified: HEAD-move commit import
 *   - `openknowledge-service`    — classified: service-level fallback (park, etc.)
 *
 * Legacy ref names (`server`, `human-<*>`, `upstream`) classify as `'unknown'`
 * so the allowlist sweep in `initShadowRepo()` can safely delete them on
 * first run without deleting legitimate new-taxonomy refs.
 *
 * Centralizing this layout knowledge prevents CLI/server drift: the CLI
 * consumes these utilities to parse writer IDs and resolve shadow-dir paths
 * without re-implementing the regex or path conventions.
 *
 * This file uses only `node:fs` (no other server/runtime deps) so it is safe
 * to include from any workspace package.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

/**
 * Writer-ID taxonomy (precedent #25). Classified system writers are non-attributable
 * actions written under a fixed writer-id. Legacy values ('human-', 'upstream',
 * 'server') are classified 'unknown' so the allowlist sweep can
 * identify and GC them without confusing them with valid attributed refs.
 *
 * Full writer-ID table:
 *   agent-<connectionId>       → 'agent'                           (MCP session)
 *   principal-<UUID>           → 'principal'                        (browser tab)
 *   file-system                → 'classified-file-system'           (disk reconcile)
 *   git-upstream               → 'classified-git-upstream'          (HEAD-move import)
 *   openknowledge-service      → 'classified-openknowledge-service' (park / service)
 *   server, human-*, upstream  → 'unknown'                          (legacy, swept on GC)
 */
export type WriterClassification =
  | 'agent'
  | 'principal'
  | 'classified-file-system'
  | 'classified-git-upstream'
  | 'classified-openknowledge-service'
  | 'unknown';

export interface ParsedWriter {
  /** The full writer id as stored in the ref (e.g., "agent-<uuid>"). */
  id: string;
  classification: WriterClassification;
  /**
   * Convenience derived from `classification`:
   *   - `true`  when classification === 'agent'
   *   - `false` when classification === 'principal'
   *   - `null`  for system writers and unknown (indeterminate for
   *     "who edited this?" attribution)
   *
   * Prefer `classification` when reasoning about attribution.
   */
  isAgent: boolean | null;
}

/**
 * Canonical regex matching the writer-id portion at the end of a ref.
 * Single source of truth for the layout; any ref-parsing code in the repo
 * should flow through `parseWriterId`.
 *
 * Recognized ids — `agent-<uuid>`, `principal-<uuid>`,
 * `file-system`, `git-upstream`, `openknowledge-service`.
 * Legacy ids (`human-*`, `upstream`, `server`) do NOT match → 'unknown',
 * so they are eligible for GC by the allowlist sweep.
 */
const WRITER_ID_RE =
  /^(agent-[^/]+|principal-[^/]+|file-system|git-upstream|openknowledge-service)$/;

/**
 * Classification of `<projectRoot>/.git`. Centralizes the single
 * `statSync` + pointer-parse so `resolveGitDir` (lossy: `string | null`),
 * `resolveShadowDir` (typed: throws on each unusable kind), and boot-time
 * worktree-attribute computation consume the same source of truth.
 *
 * Three failure modes — distinct because their recoveries differ:
 *   - `'absent'`             — `.git` is not on disk (`ENOENT`). Recovery: run
 *                              `ensureProjectGit` upstream, or accept the
 *                              legacy fallthrough.
 *   - `'malformed-pointer'`  — `.git` is a file but its `gitdir:` body is
 *                              unreadable, parses to nothing, or references a
 *                              missing admin dir. Recovery: `git worktree prune`.
 *   - `'inaccessible'`       — `statSync` failed for a reason other than
 *                              `ENOENT` (typically `EACCES`/`EPERM`). We don't
 *                              know the shape of `.git`. Recovery: filesystem
 *                              permissions / mount.
 *
 * Both `'malformed-pointer'` and `'inaccessible'` carry `cause` so consumers
 * can branch on the underlying error code (`EACCES` vs parse failure) without
 * losing the diagnostic stack.
 */
export type ResolvedGitDir =
  | {
      kind: 'directory';
      path: string;
      /**
       * Path from the work-tree root (the directory containing `.git`) to the
       * caller's `projectRoot`. Empty when `projectRoot` IS the work-tree root
       * — i.e. the common case where `<projectRoot>/.git` was found directly.
       * Non-empty when the gitdir was discovered by walking up from a
       * subfolder, which `resolveShadowDir` uses to namespace per-project
       * shadows under the shared parent gitdir.
       */
      projectSubPath: string;
    }
  | {
      kind: 'linked';
      /** Resolved admin dir (the gitdir the pointer references). */
      path: string;
      /** Path of the `.git` pointer file itself — needed for error attribution. */
      gitPath: string;
      projectSubPath: string;
    }
  | { kind: 'absent' }
  | { kind: 'malformed-pointer'; gitPath: string; target: string; cause?: unknown }
  | { kind: 'inaccessible'; gitPath: string; cause: unknown };

/**
 * Classify a `.git` path (file or directory) without walking up the
 * filesystem. The caller supplies `workTreeRoot` — the directory CONTAINING
 * the `.git` entry — so we can resolve relative `gitdir:` pointers correctly
 * even when the `.git` lives at an ancestor of `projectRoot`.
 */
function classifyGitEntry(
  gitPath: string,
  workTreeRoot: string,
  projectRoot: string,
): ResolvedGitDir {
  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(gitPath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return { kind: 'absent' };
    return { kind: 'inaccessible', gitPath, cause: err };
  }
  const projectSubPath = computeProjectSubPath(workTreeRoot, projectRoot);
  if (stat.isDirectory()) return { kind: 'directory', path: gitPath, projectSubPath };
  if (stat.isFile()) {
    let content: string;
    try {
      content = readFileSync(gitPath, 'utf-8').trim();
    } catch (err) {
      return { kind: 'malformed-pointer', gitPath, target: '', cause: err };
    }
    const match = content.match(/^gitdir:\s*(.+)$/);
    if (!match) return { kind: 'malformed-pointer', gitPath, target: '' };
    // Relative pointers resolve against the directory that contains the
    // `.git` file (the worktree root), not against `projectRoot` — these
    // differ when `.git` lives at an ancestor of `projectRoot`.
    return {
      kind: 'linked',
      path: resolve(workTreeRoot, match[1]),
      gitPath,
      projectSubPath,
    };
  }
  // socket / device / etc. — treat as absent for the consumers' purposes.
  return { kind: 'absent' };
}

/**
 * Return the path component from `workTreeRoot` down to `projectRoot`. Empty
 * string when they coincide. Non-empty result is guaranteed to NOT begin with
 * `..` (the walk-up only ever discovers `.git` at an ancestor, so projectRoot
 * is always a descendant). Defensive `..`-check guards against future callers
 * that pass arbitrary paths.
 */
function computeProjectSubPath(workTreeRoot: string, projectRoot: string): string {
  const rel = relative(workTreeRoot, projectRoot);
  if (rel === '' || rel === '.') return '';
  if (rel.startsWith('..') || isAbsolute(rel)) return '';
  return rel;
}

/**
 * Walk up from `startDir` looking for a `.git` (directory or pointer file) at
 * any ancestor. Stops at `homedir()` (matching `folder-admission.ts`'s
 * "don't promote at-or-above home" policy — `~/.git` would be a hostile
 * carve-out we want to refuse) and at the filesystem root. Returns the path
 * to the discovered `.git` entry and the ancestor directory containing it,
 * or `null` if none found within the bound.
 */
function findAncestorGitEntry(startDir: string): { gitPath: string; workTreeRoot: string } | null {
  const home = homedir();
  let cursor = resolve(startDir);
  // Hard cap so a hostile or pathological tree (cyclic symlinks via realpath
  // edge cases, very deep mount stacks) can't pin a server boot in a tight
  // statSync loop. 64 is well beyond any realistic monorepo depth.
  const MAX_DEPTH = 64;
  for (let i = 0; i < MAX_DEPTH; i++) {
    if (cursor === home) return null;
    const parent = dirname(cursor);
    if (parent === cursor) return null; // reached filesystem root
    if (parent === home) return null; // refuse ~/.git (at-or-above-home policy)
    const candidate = resolve(parent, '.git');
    try {
      const stat = statSync(candidate);
      if (stat.isDirectory() || stat.isFile()) {
        return { gitPath: candidate, workTreeRoot: parent };
      }
    } catch (err) {
      // ENOENT / EACCES / etc. — keep walking; if a parent is unreadable we
      // can't tell whether `.git` exists there, but surfacing that as an
      // error would block boot for every container that mounts a parent of
      // its project read-only without execute. Prefer the safe fallthrough
      // — at worst the caller hits the legacy `<projectRoot>/.git/ok` path.
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') {
        console.warn(
          `[shadow-repo-layout] Cannot stat ${candidate} (${code ?? 'unknown'}); skipping ancestor`,
        );
      }
    }
    cursor = parent;
  }
  return null;
}

export function resolveGitDirDetailed(projectRoot: string): ResolvedGitDir {
  const projectRootAbs = resolve(projectRoot);
  const direct = classifyGitEntry(resolve(projectRootAbs, '.git'), projectRootAbs, projectRootAbs);
  // Direct hit at projectRoot — return as-is. Covers main-worktree, linked-
  // worktree, AND the pre-existing-shell-`.git/` case (where a prior subfolder
  // boot under the bug left an empty `.git/` directory containing only `ok/`).
  // The shell-`.git/` case continues to be repaired by `ensureProjectGit` and
  // its shadow continues to live where it was created. We never walk up if
  // `.git` is present at projectRoot.
  if (direct.kind !== 'absent') return direct;

  // No `.git` at projectRoot — projectRoot may be a subfolder of an existing
  // work tree. Walk up. If we find an ancestor `.git`, host the shadow inside
  // its gitdir (with a per-subfolder namespace; see `resolveShadowDir`) rather
  // than creating a nested `<projectRoot>/.git/` shell. This eliminates the
  // bug class where `initShadowRepo`'s mkdir materialised a shell `.git/`
  // inside a subfolder of an existing repo, which on next boot tricked
  // `ensureProjectGit`'s shell-repair path into running `git init` and
  // fragmenting the user's history into a nested repo.
  const ancestor = findAncestorGitEntry(projectRootAbs);
  if (ancestor === null) {
    // ENOENT / ENOTDIR were the original errors at projectRoot — fall
    // through to the legacy `<projectRoot>/.git/ok` path. Callers handle the
    // no-`.git` case via `ensureProjectGit` upstream.
    return { kind: 'absent' };
  }
  return classifyGitEntry(ancestor.gitPath, ancestor.workTreeRoot, projectRootAbs);
}

/**
 * Resolve the actual `.git` directory for a project root — handles both the
 * standard `.git`-as-directory case and the linked-worktree case where
 * `<projectRoot>/.git` is a regular file containing `gitdir: <abs>`.
 *
 * Returns the resolved absolute path on success, or `null` when `.git` is
 * absent OR when the pointer file is unreadable / malformed. Callers that
 * need to distinguish "no .git" from "stale pointer" should use
 * `resolveShadowDir`, which surfaces the typed `MalformedGitPointerError`
 * for the latter.
 */
export function resolveGitDir(projectRoot: string): string | null {
  const result = resolveGitDirDetailed(projectRoot);
  if (result.kind === 'directory' || result.kind === 'linked') return result.path;
  return null;
}

/**
 * Resolve the shadow-repo bare git dir's target path for a project — WITHOUT
 * checking whether the shadow itself has been initialized yet. Used by init
 * (`packages/server/src/shadow-repo.ts`) to pick where to create the repo,
 * and internally by `getShadowRepoPath`.
 *
 * Worktree-aware: appends `'ok'` to the resolved gitdir, which is
 * `<projectRoot>/.git` for a main worktree (`.git`-as-directory) and
 * `<repo>/.git/worktrees/<name>` for a linked worktree (`.git`-as-pointer).
 * The main-worktree path is bit-identical to pre-worktree-support behavior
 * so existing main-worktree shadows do not migrate.
 *
 * Throws one of two typed errors when `.git` is on disk but unusable:
 *   - `MalformedGitPointerError` — `.git` is a file but its `gitdir:` pointer
 *     is unreadable, has no `gitdir:` line, or references a path that does
 *     not exist on disk. Common cause: stale pointer left by a partial
 *     `git worktree remove` race or `rm -rf` of the admin dir without
 *     `git worktree prune`. Recovery hint names `git worktree prune`.
 *   - `GitDirAccessError` — `statSync` on `.git` failed for a reason other
 *     than `ENOENT` (typically `EACCES`/`EPERM`). The shape of `.git` is
 *     unknown — could be a directory we can't read or a pointer file with no
 *     metadata access. Recovery hint names filesystem permissions.
 *
 * Each typed error carries the original `errno` exception as `cause` so log
 * consumers can branch on the specific failure mode without parsing strings.
 *
 * When `.git` is truly absent (`ENOENT`), falls through to the legacy
 * `<projectRoot>/.git/ok` path. Callers already handle the no-`.git` case
 * via `ensureProjectGit` upstream of this function.
 */
export function resolveShadowDir(projectRoot: string): string {
  const result = resolveGitDirDetailed(projectRoot);
  switch (result.kind) {
    case 'directory':
      return resolve(result.path, shadowSubdirName(result.projectSubPath));
    case 'linked':
      if (!existsSync(result.path)) {
        // Pointer parsed but target dir is gone (stale `git worktree` admin).
        throw new MalformedGitPointerError(result.gitPath, result.path);
      }
      return resolve(result.path, shadowSubdirName(result.projectSubPath));
    case 'malformed-pointer':
      throw new MalformedGitPointerError(result.gitPath, result.target, { cause: result.cause });
    case 'inaccessible':
      throw new GitDirAccessError(result.gitPath, { cause: result.cause });
    case 'absent':
      // Legacy fallthrough — callers handle no-`.git` upstream via ensureProjectGit.
      return resolve(projectRoot, '.git/ok');
  }
}

/**
 * Pick the shadow subdir name within a discovered gitdir. The toplevel case
 * (`projectSubPath === ''`) keeps the unchanged `ok` name so existing on-disk
 * shadows are bit-identical to pre-walk-up behavior. Subfolder discovery
 * namespaces the shadow with a path-derived slug so two `.ok/` projects sharing
 * one parent gitdir can't collide on `refs/wip/<branch>/<writer>` or on the
 * shadow tree path layout (both would otherwise write to `foo.md` at the root
 * of the shared bare repo and silently overwrite each other's attribution).
 */
function shadowSubdirName(projectSubPath: string): string {
  if (projectSubPath === '') return 'ok';
  return `ok-${slugifyShadowSubPath(projectSubPath)}`;
}

/**
 * Filesystem-safe slug for a path segment relative to the work-tree root.
 * Path separators become `-`; characters outside `[A-Za-z0-9._-]` become `_`.
 * Caps length to 64 chars (well below any platform's component limit) with
 * an 8-hex-digit suffix derived from the full input for collision resistance
 * when two long sub-paths happen to share a 64-char prefix. The result is a
 * single path component — no slashes, no leading dots, never empty.
 */
function slugifyShadowSubPath(rel: string): string {
  // Normalize path separators (handles Windows `\` if it ever surfaces here).
  const flat = rel.split(sep).join('-').replace(/\/+/g, '-');
  const sanitized = flat.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '_');
  const MAX = 64;
  if (sanitized.length <= MAX) return sanitized || 'sub';
  const hash = djb2(rel).toString(16).padStart(8, '0');
  return `${sanitized.slice(0, MAX - 9)}-${hash}`;
}

/** Tiny string hash (djb2). Only used to disambiguate truncated slug suffixes. */
function djb2(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = (h * 33 + s.charCodeAt(i)) >>> 0;
  }
  return h;
}

/**
 * Thrown by `resolveShadowDir` when `<projectRoot>/.git` exists as a file but
 * its `gitdir:` pointer is unreadable, malformed, or references a missing
 * admin directory. Common cause: `git worktree remove` race or a manual
 * `rm -rf` of the admin directory without `git worktree prune`.
 *
 * `gitPointerPath` is the path of the `.git` file itself; `resolvedTarget`
 * is the path the pointer claims (or `''` when the pointer text was
 * unreadable / had no `gitdir:` line). Carry both so log consumers can
 * distinguish the two failure shapes without parsing the message.
 */
export class MalformedGitPointerError extends Error {
  readonly gitPointerPath: string;
  readonly resolvedTarget: string;
  constructor(gitPointerPath: string, resolvedTarget: string, options?: { cause?: unknown }) {
    const targetClause = resolvedTarget
      ? `references a missing or unreadable gitdir at ${resolvedTarget}`
      : 'is unreadable or has no valid gitdir: pointer';
    super(
      `\`.git\` pointer at ${gitPointerPath} ${targetClause}. Run \`git worktree prune\` from the source repo and try again.`,
      options,
    );
    this.name = 'MalformedGitPointerError';
    this.gitPointerPath = gitPointerPath;
    this.resolvedTarget = resolvedTarget;
  }
}

/**
 * Thrown by `resolveShadowDir` when `<projectRoot>/.git` exists on disk but
 * `statSync` failed for a reason other than `ENOENT` — typically `EACCES`
 * (path itself unreadable), `EPERM` (parent directory denies traversal), or
 * `EBUSY` on a stale mount. The shape of `.git` is undetermined: it could be
 * a directory or a pointer file we lack permission to inspect.
 *
 * Distinct from `MalformedGitPointerError` because the recovery is
 * different: pruning the worktree won't fix a permission failure on the
 * `.git` path itself. The recovery hint names filesystem permissions and
 * mount state.
 *
 * Carry the original `errno` exception as `cause` so log consumers can
 * branch on the specific code (`EACCES` vs `EPERM` vs `EBUSY`) without
 * parsing the message.
 */
export class GitDirAccessError extends Error {
  readonly gitPath: string;
  constructor(gitPath: string, options?: { cause?: unknown }) {
    const codeClause =
      options?.cause !== undefined &&
      options.cause !== null &&
      typeof options.cause === 'object' &&
      'code' in options.cause &&
      typeof (options.cause as { code: unknown }).code === 'string'
        ? ` (${(options.cause as { code: string }).code})`
        : '';
    super(
      `Cannot access \`.git\` at ${gitPath}${codeClause}. Check filesystem permissions and that the volume is mounted.`,
      options,
    );
    this.name = 'GitDirAccessError';
    this.gitPath = gitPath;
  }
}

/**
 * Return the shadow-repo bare git dir's path, or `null` when the shadow repo
 * has not been initialized yet (HEAD file absent) or when the project's
 * `.git` pointer is stale/malformed/inaccessible.
 *
 * Acts as a "is shadow ready?" probe — collapses every unusable state
 * (no `.git`, stale worktree pointer, malformed pointer text, permission
 * failure, missing HEAD) to `null` so the read path (`readShadowLog` /
 * `enrichPath`) can fall back to "no history" without unwinding through
 * Promise rejections. The actionable `MalformedGitPointerError` and
 * `GitDirAccessError` still surface from the boot path, which calls
 * `resolveShadowDir` directly via `server-factory.ts` and `shadow-repo.ts`.
 * Consumers that need the path regardless of readiness should use
 * `resolveShadowDir` directly and handle the typed errors.
 */
export function getShadowRepoPath(projectRoot: string): string | null {
  let path: string;
  try {
    path = resolveShadowDir(projectRoot);
  } catch (err) {
    if (err instanceof MalformedGitPointerError) return null;
    if (err instanceof GitDirAccessError) return null;
    throw err;
  }
  return existsSync(resolve(path, 'HEAD')) ? path : null;
}

/**
 * Return the `refs/wip/<branch>/` prefix used when enumerating per-writer
 * WIP refs for a given project branch. Callers typically concatenate this
 * with `*` (or omit the trailing slash) when passing to `git for-each-ref`.
 */
export function getWipRefPattern(branch: string): string {
  return `refs/wip/${branch}/`;
}

/**
 * A single contributor entry extracted from a WIP commit message body.
 * Matches the shape written by contributor-tracker.ts's formatContributorsFrom().
 * v is optional for backward compatibility with pre-versioned commit messages.
 */
export interface ShadowContributor {
  v?: number;
  id: string;
  name: string;
  /** Color seed for deterministic color assignment — matches presence bar color. */
  colorSeed?: string;
  docs: string[];
  /**
   * Flat per-contributor array of agent-provided summaries, oldest first.
   * Additive field — legacy commits lack it entirely and parse with
   * `summaries: undefined`. Malformed values (non-array, or array with
   * non-string elements) drop just this field and leave the rest of the
   * contributor entry intact — a deliberate divergence from the
   * whole-entry-skip convention used for other optional fields, because
   * decorative loss (no bullets) is preferable to attribution loss.
   */
  summaries?: string[];
}

const OK_CONTRIBUTORS_PREFIX = 'ok-contributors: ';

/**
 * Parse `ok-contributors:` JSON lines from a commit message body (or full
 * raw message text via `%B`). Skips blank lines and malformed JSON silently.
 * Returns an empty array when the body is empty or contains no contributor lines.
 */
export function parseContributors(body: string): ShadowContributor[] {
  if (!body) return [];
  const contributors: ShadowContributor[] = [];
  for (const line of body.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith(OK_CONTRIBUTORS_PREFIX)) continue;
    try {
      const parsed = JSON.parse(trimmed.slice(OK_CONTRIBUTORS_PREFIX.length)) as unknown;
      if (
        parsed !== null &&
        typeof parsed === 'object' &&
        'id' in parsed &&
        typeof (parsed as Record<string, unknown>).id === 'string' &&
        'name' in parsed &&
        typeof (parsed as Record<string, unknown>).name === 'string' &&
        'docs' in parsed &&
        Array.isArray((parsed as Record<string, unknown>).docs) &&
        ((parsed as Record<string, unknown>).docs as unknown[]).every(
          (d) => typeof d === 'string',
        ) &&
        (!('colorSeed' in parsed) ||
          typeof (parsed as Record<string, unknown>).colorSeed === 'string')
      ) {
        // Malformed `summaries` drops just the field; the contributor
        // entry still parses. Decorative loss (no bullets) beats attribution
        // loss (missing contributor). Deliberate divergence from the
        // whole-entry-skip convention applied to other optional fields.
        const raw = parsed as Record<string, unknown>;
        if ('summaries' in raw) {
          const s = raw.summaries;
          if (!Array.isArray(s) || !s.every((x) => typeof x === 'string')) {
            delete raw.summaries;
          }
        }
        contributors.push(parsed as ShadowContributor);
      }
    } catch {
      // skip malformed lines
    }
  }
  return contributors;
}

// ─── In-memory checkpoint body metadata ────────

/** Prefix for the versioned checkpoint-metadata body line. */
const OK_CHECKPOINT_PREFIX = 'ok-checkpoint-v1: ';

/**
 * Kind-discriminated checkpoint metadata parsed from the `ok-checkpoint-v1:`
 * body line. The body line coexists with `ok-contributors:` lines —
 * `parseContributors` skips unknown prefixes, so the two channels do not
 * interfere.
 *
 * `docName` and `size` are carried inline so the `/api/rescue` read path can
 * enumerate checkpoints via a single batched `git log` without a per-ref
 * `git ls-tree` fan-out. They are
 * optional in the parsed shape for backward-compatible reads: pre-enrichment
 * commits returned `null` for both and the rescue list fell back to
 * `ls-tree`. New writes (`saveInMemoryCheckpoint`) always populate them.
 */
/**
 * Why a service-authored consolidation fired. Bounded set so telemetry/diagnose
 * can read it back as a low-cardinality enum. Parsed back as a bare `string` for
 * forward-compatibility (a future trigger an old reader doesn't know about still
 * parses), so writers construct with this type but readers must not assume it.
 */
export type AutoConsolidationTrigger = 'dead-chain' | 'session-close' | 'boot' | 'ttl';

export type ParsedCheckpoint =
  | {
      kind: 'bridge-merge-loss';
      docName: string | null;
      size: number | null;
      metadata: { lostSubstrings: string[] };
    }
  | {
      kind: 'external-change-rescue';
      docName: string | null;
      size: number | null;
      metadata: { incomingDiskSha: string };
    }
  | {
      // Service-authored consolidation of dead/stale WIP chains.
      // GET /api/history excludes this kind by default so daily
      // auto-consolidations never pollute timelines; old readers that predate
      // this kind get `null` from parseCheckpoint (the unknown-kind fallback)
      // and render it as a plain Save Version — data-safe, cosmetic only.
      kind: 'auto-consolidation';
      docName: string | null;
      size: number | null;
      metadata: { foldedRefs: number; trigger: string };
    };

/**
 * Parse the `ok-checkpoint-v1:` metadata line from a commit message body.
 * Returns `null` when the line is absent, malformed JSON, has an unknown
 * `kind`, or has a metadata shape that doesn't match the expected kind.
 *
 * Parallel to `parseContributors` in spirit — silent fallback, no throws —
 * so TimelinePanel rendering can gracefully degrade to 'Save Version'
 * rendering for checkpoints without this body line.
 */
export function parseCheckpoint(body: string): ParsedCheckpoint | null {
  if (!body) return null;
  for (const line of body.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith(OK_CHECKPOINT_PREFIX)) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed.slice(OK_CHECKPOINT_PREFIX.length));
    } catch {
      return null;
    }
    if (parsed === null || typeof parsed !== 'object') return null;
    const obj = parsed as {
      kind?: unknown;
      metadata?: unknown;
      docName?: unknown;
      size?: unknown;
    };
    const kind = obj.kind;
    const metadata = obj.metadata;
    if (metadata === null || typeof metadata !== 'object') return null;
    const docName = typeof obj.docName === 'string' ? obj.docName : null;
    const size = typeof obj.size === 'number' && Number.isFinite(obj.size) ? obj.size : null;
    if (kind === 'bridge-merge-loss') {
      const m = metadata as { lostSubstrings?: unknown };
      if (Array.isArray(m.lostSubstrings) && m.lostSubstrings.every((s) => typeof s === 'string')) {
        return {
          kind: 'bridge-merge-loss',
          docName,
          size,
          metadata: { lostSubstrings: m.lostSubstrings as string[] },
        };
      }
      return null;
    }
    if (kind === 'external-change-rescue') {
      const m = metadata as { incomingDiskSha?: unknown };
      if (typeof m.incomingDiskSha === 'string') {
        return {
          kind: 'external-change-rescue',
          docName,
          size,
          metadata: { incomingDiskSha: m.incomingDiskSha },
        };
      }
      return null;
    }
    if (kind === 'auto-consolidation') {
      const m = metadata as { foldedRefs?: unknown; trigger?: unknown };
      if (
        typeof m.foldedRefs === 'number' &&
        Number.isFinite(m.foldedRefs) &&
        typeof m.trigger === 'string'
      ) {
        return {
          kind: 'auto-consolidation',
          docName,
          size,
          metadata: { foldedRefs: m.foldedRefs, trigger: m.trigger },
        };
      }
      return null;
    }
    return null;
  }
  return null;
}

/**
 * Format the `ok-checkpoint-v1:` body line for a given kind+metadata. Produces
 * exactly one line (no trailing newline). Consumers embed it inside a full
 * commit message body as a sibling to `ok-contributors:` lines.
 *
 * Exported so `saveInMemoryCheckpoint` in the server package can share this
 * serialization rule with the parser — see precedent #4 (shared computation).
 */
export function formatCheckpointBodyLine(parsed: ParsedCheckpoint): string {
  const payload: {
    kind: ParsedCheckpoint['kind'];
    docName?: string;
    size?: number;
    metadata: ParsedCheckpoint['metadata'];
  } = {
    kind: parsed.kind,
    metadata: parsed.metadata,
  };
  if (parsed.docName !== null) payload.docName = parsed.docName;
  if (parsed.size !== null) payload.size = parsed.size;
  return `${OK_CHECKPOINT_PREFIX}${JSON.stringify(payload)}`;
}

// ─── ok-actor: body line ─────────────────────────────────────────────────────

/**
 * Structured actor tuple written as `ok-actor:` JSON body line in every
 * shadow-repo commit. Makes the repo queryable without a session registry.
 * v:1 is the sole schema version; bump v to introduce breaking changes.
 */
export interface OkActorEntry {
  v: 1;
  /**
   * The writer id — the ref-name this commit was authored under:
   *   - `agent-<connectionId>`    — MCP agent session
   *   - `principal-<UUID>`        — browser-tab principal
   *   - `file-system` | `git-upstream` | `openknowledge-service` — classified
   *
   * Carries the identity that `ok-contributors.id` used to carry pre-consolidation,
   * so a commit body is self-describing (`git show -s <sha>` → full attribution
   * without needing to join against `git for-each-ref`). Also disambiguates
   * classified writers, which otherwise share `{principal: null, agent_session: null}`.
   */
  writer_id: string;
  /** Long-lived principal id (stub — null until human-browser auth wired). */
  principal: string | null;
  /** Per-session agent connection id, e.g. "conn-abc123". Null for classified writers. */
  agent_session: string | null;
  /** Claude model family, e.g. "claude-3-5-sonnet". Null when not known. */
  agent_type: string | null;
  /** MCP client name (e.g. "claude-code"). Null when not known. */
  client_name: string | null;
  /** MCP client version. Null when not known. */
  client_version: string | null;
  /** User-supplied label for this session. Null when absent. */
  label: string | null;
  /** Human-readable display name shown in attribution UI. */
  display_name: string;
  /** Color seed for deterministic color assignment — matches presence bar. */
  color_seed: string;
  /** Documents touched in this drain cycle. */
  docs: string[];
  /**
   * Flat per-contributor array of agent-provided summaries, oldest first.
   * Elided when empty so summary-less writes stay byte-identical to legacy.
   * Malformed values (non-array, array-with-non-string) drop JUST this field
   * at parse time — decorative loss (no bullets) beats attribution loss.
   * Consolidated onto ok-actor: as the foundation's deferred read-path
   * migration (formerly lived on ok-contributors:).
   */
  summaries?: string[];
  /**
   * Per-rename mapping of `{from, to}` pairs collected during this drain cycle.
   * Anchors the rename chain to a durable shadow-commit record so the rename
   * log index can be rebuilt from `git log` body parsing alone if `renames.jsonl`
   * is missing or corrupt. Elided when empty/absent so non-rename writes stay
   * byte-identical to legacy ok-actor commits. Malformed entries (non-object,
   * missing `from`/`to`, non-string fields) are dropped individually at parse
   * time; the rest of the array is preserved and the parent OkActorEntry parses
   * normally — same divergence shape as `summaries`.
   */
  previous_paths?: Array<{ from: string; to: string }>;
}

const OK_ACTOR_PREFIX = 'ok-actor: ';

/**
 * Format an `ok-actor:` JSON body line. Produces exactly one line (no trailing newline).
 * Pair with `parseOkActor` / `parseOkActors` at the read path. Elides `summaries`
 * and `previous_paths` when empty/absent so writes without those fields stay
 * byte-identical to pre-feature ok-actor commits.
 */
export function formatOkActor(entry: OkActorEntry): string {
  const { summaries, previous_paths, ...rest } = entry;
  const payload: Record<string, unknown> = { ...rest };
  if (summaries && summaries.length > 0) payload.summaries = summaries;
  if (previous_paths && previous_paths.length > 0) payload.previous_paths = previous_paths;
  return `${OK_ACTOR_PREFIX}${JSON.stringify(payload)}`;
}

/**
 * Parse a single JSON object into an `OkActorEntry`, or `null` on schema violation.
 * Extracted so `parseOkActor` (first-match) and `parseOkActors` (all-matches)
 * share one validation pass.
 *
 * Back-compat note: pre-consolidation `ok-actor:` lines (shipped before this
 * unification) lacked `writer_id`. When missing, derive it:
 *   - `agent_session` set → `agent-<agent_session>`
 *   - `principal` set → `<principal>`  (principal ids already include the
 *     `principal-` prefix)
 *   - otherwise → derive from `display_name` for the three classified writers;
 *     fall back to `'openknowledge-service'` as the safest non-attributed
 *     classified writer if display_name doesn't match.
 */
function parseOkActorObject(obj: Record<string, unknown>): OkActorEntry | null {
  if (obj.v !== 1) return null;
  if (!('display_name' in obj) || typeof obj.display_name !== 'string') return null;
  if (!('docs' in obj) || !Array.isArray(obj.docs)) return null;
  const principal = typeof obj.principal === 'string' ? obj.principal : null;
  const agent_session = typeof obj.agent_session === 'string' ? obj.agent_session : null;
  let writer_id: string;
  if (typeof obj.writer_id === 'string' && obj.writer_id.length > 0) {
    writer_id = obj.writer_id;
  } else if (agent_session) {
    writer_id = `agent-${agent_session}`;
  } else if (principal) {
    writer_id = principal;
  } else {
    // Classified writers — derive from display_name. The three recognized values
    // are stable display strings in shadow-repo.ts (FILE_SYSTEM_WRITER etc.).
    switch (obj.display_name) {
      case 'File System':
        writer_id = 'file-system';
        break;
      case 'Git (upstream)':
        writer_id = 'git-upstream';
        break;
      default:
        writer_id = 'openknowledge-service';
    }
  }
  const summaries =
    'summaries' in obj && Array.isArray(obj.summaries)
      ? (obj.summaries as unknown[]).every((s) => typeof s === 'string')
        ? (obj.summaries as string[])
        : undefined // Drop field on malformed, keep entry
      : undefined;
  const previous_paths = parsePreviousPaths(obj);
  return {
    v: 1,
    writer_id,
    principal,
    agent_session,
    agent_type: typeof obj.agent_type === 'string' ? obj.agent_type : null,
    client_name: typeof obj.client_name === 'string' ? obj.client_name : null,
    client_version: typeof obj.client_version === 'string' ? obj.client_version : null,
    label: typeof obj.label === 'string' ? obj.label : null,
    display_name: obj.display_name,
    color_seed: typeof obj.color_seed === 'string' ? obj.color_seed : 'unknown',
    docs: (obj.docs as unknown[]).filter((d): d is string => typeof d === 'string'),
    ...(summaries && summaries.length > 0 ? { summaries } : {}),
    ...(previous_paths && previous_paths.length > 0 ? { previous_paths } : {}),
  };
}

/**
 * Per-element validator for `previous_paths`. Drops malformed elements
 * individually (decorative loss — chain step missing) rather than rejecting
 * the parent OkActorEntry, mirroring the `summaries` divergence shape.
 * Returns `undefined` only when the field is absent or a non-array — both
 * cases collapse to "no previous_paths emitted on the typed literal."
 */
function parsePreviousPaths(
  obj: Record<string, unknown>,
): Array<{ from: string; to: string }> | undefined {
  if (!('previous_paths' in obj)) return undefined;
  if (!Array.isArray(obj.previous_paths)) return undefined;
  const out: Array<{ from: string; to: string }> = [];
  for (const raw of obj.previous_paths as unknown[]) {
    if (raw === null || typeof raw !== 'object') continue;
    const candidate = raw as Record<string, unknown>;
    if (typeof candidate.from !== 'string' || typeof candidate.to !== 'string') continue;
    out.push({ from: candidate.from, to: candidate.to });
  }
  return out;
}

/**
 * Parse the first `ok-actor:` JSON body line from a commit message body.
 * Returns `null` when the line is absent, malformed, or fails schema validation
 * (v must be 1; display_name and docs must be present).
 *
 * Use `parseOkActors` (plural) when the body may contain multiple writers
 * (multi-contributor L2 drain); pre-unification commits used one ok-actor
 * per commit, but the consolidated write path emits one per writer.
 */
export function parseOkActor(body: string): OkActorEntry | null {
  if (!body) return null;
  for (const line of body.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith(OK_ACTOR_PREFIX)) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed.slice(OK_ACTOR_PREFIX.length));
    } catch {
      return null;
    }
    if (parsed === null || typeof parsed !== 'object') return null;
    return parseOkActorObject(parsed as Record<string, unknown>);
  }
  return null;
}

/**
 * Parse every `ok-actor:` JSON body line from a commit message body.
 * Returns an empty array when the body contains no valid ok-actor lines.
 * Malformed lines are skipped silently (mirrors `parseContributors` convention).
 *
 * The consolidated L2 drain emits one `ok-actor:` per writer per commit
 * (fan-out), so this is the right reader for post-consolidation commits.
 */
export function parseOkActors(body: string): OkActorEntry[] {
  if (!body) return [];
  const out: OkActorEntry[] = [];
  for (const line of body.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith(OK_ACTOR_PREFIX)) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed.slice(OK_ACTOR_PREFIX.length));
    } catch {
      continue;
    }
    if (parsed === null || typeof parsed !== 'object') continue;
    const entry = parseOkActorObject(parsed as Record<string, unknown>);
    if (entry) out.push(entry);
  }
  return out;
}

/**
 * Project an `OkActorEntry` onto the legacy `ShadowContributor` DTO that
 * Timeline + CLI render paths consume. Kept deliberately thin — the renderers
 * haven't been migrated to consume `OkActorEntry` fields directly (rich actor
 * data like `agent_type`, `client_name` is available for them to adopt later).
 */
export function okActorToShadowContributor(a: OkActorEntry): ShadowContributor {
  const shadow: ShadowContributor = {
    v: 1,
    id: a.writer_id,
    name: a.display_name,
    colorSeed: a.color_seed,
    docs: a.docs,
  };
  if (a.summaries && a.summaries.length > 0) shadow.summaries = a.summaries;
  return shadow;
}

/**
 * Read contributors from a commit message body, preferring the consolidated
 * `ok-actor:` body lines and falling back to legacy `ok-contributors:` lines
 * when no `ok-actor:` is present.
 *
 * This is the single entry point the Timeline API (`timeline-query.ts`) and
 * the CLI enrichment path (`shadow-log.ts`) should call. Callers that need
 * the full actor tuple (e.g., a future on-behalf-of render) should consume
 * `parseOkActors` directly.
 *
 * Back-compat contract: commits written before the ok-actor consolidation
 * (on disk from pre-unification sessions) have only `ok-contributors:` lines
 * and continue to render identically. Commits written post-consolidation
 * have only `ok-actor:` lines. Transitional commits with both are possible
 * during rollout and prefer `ok-actor:` — `ok-contributors:` is ignored when
 * at least one ok-actor is present to avoid double-counting.
 */
export function readContributors(body: string): ShadowContributor[] {
  const actors = parseOkActors(body);
  if (actors.length > 0) return actors.map(okActorToShadowContributor);
  return parseContributors(body);
}

// ─── Subject-prefix scheme ───────────────────────────────────────────────────

/** Format a `wip:` subject from docs touched in the drain cycle. */
export function formatWipSubject(docs: string[]): string {
  if (docs.length === 0) return 'wip: auto-save';
  if (docs.length === 1) return `wip: ${docs[0]}`;
  return `wip: ${docs.length} docs`;
}

/** Format a `reconcile:` subject for file-watcher-triggered reconcile writes. */
export function formatReconcileSubject(docName: string): string {
  return `reconcile: ${docName}`;
}

/** Format a `rollback:` subject for rollback-to-version writes. */
export function formatRollbackSubject(docName: string, sha: string): string {
  return `rollback: ${docName} to ${sha.slice(0, 7)}`;
}

/** Format a `park:` subject for branch-switch park commits. */
export function formatParkSubject(oldBranch: string, newBranch: string): string {
  return `park: ${oldBranch} -> ${newBranch}`;
}

/** Format a `rename:` subject for managed-rename writes. */
export function formatRenameSubject(oldName: string, newName: string): string {
  return `rename: ${oldName} -> ${newName}`;
}

/** Format a `checkpoint:` subject for save-version and safety-checkpoint commits. */
export function formatCheckpointSubject(message: string): string {
  return `checkpoint: ${message}`;
}

/** Format an `import:` subject for upstream-import commits. */
export function formatImportSubject(oldHead: string | null, newHead: string): string {
  return oldHead
    ? `import: from ${oldHead.slice(0, 8)}..${newHead.slice(0, 8)}`
    : `import: initial at ${newHead.slice(0, 8)}`;
}

// ─── Change-note subject composition ─────────────────────────────────────────
//
// Landing per-writer summaries on the COMMIT SUBJECT line (not just the
// `ok-contributors:` body) is what turns `git log --oneline refs/wip/main/agent-*`
// from a wall of `wip: notes.md` duplicates into a scannable team-history feed.
// The body still carries the full summary array for the TimelinePanel render —
// this helper is the git-log-shaped projection.

/**
 * Upper bound on the length of the rendered commit subject line.
 * Matches the CommonMark / git subject-line convention so `git log --oneline`
 * stays legible without wrapping.
 */
export const COMMIT_SUBJECT_MAX_LEN = 72;

/**
 * Defense-in-depth line-terminator stripper for the commit-subject pipeline.
 * `normalizeSummary` (`packages/server/src/agent-write-summary.ts`) already
 * strips these at the API boundary, but `composeCommitSubject` is exported
 * and reachable from callers that bypass the boundary helper. A subject line
 * containing an embedded LF (or any other line-break codepoint) gets parsed
 * as multiple body lines by `parseOkActors` / `parseContributors` /
 * `parseCheckpoint`, allowing commit-message injection — e.g. a summary of
 * `"x\nok-actor: {…}"` would produce a forged actor entry alongside the
 * legitimate one when the L2 drain concatenates the subject with the body.
 *
 * Constructed via `new RegExp` to mirror `LINE_TERMINATOR_RE` in the server
 * package — keeps the source ASCII-safe so file round-trips can't substitute
 * raw U+2028 / U+2029 codepoints into a regex literal where JS parsers
 * reject them.
 */
// biome-ignore lint/complexity/useRegexLiterals: see docblock above for the constraint that forces `new RegExp`.
const SUBJECT_LINE_BREAK_RE = new RegExp('[\\r\\n\\v\\f\\u0085\\u2028\\u2029]', 'g');

function stripLineBreaks(s: string): string {
  return s.replace(SUBJECT_LINE_BREAK_RE, ' ');
}

/**
 * Combine a base subject (from `formatWipSubject` / `formatReconcileSubject` / etc.
 * or a `ContributorEntry.subjectOverride`) with agent-supplied change-notes,
 * producing a single subject line capped at `COMMIT_SUBJECT_MAX_LEN`.
 *
 * Rules:
 *  - 0 summaries → base subject unchanged (pre-feature byte-identity).
 *  - 1 summary → `<base> — <summary>` truncated with a trailing U+2026
 *    ellipsis when over budget; the `<base>` portion is never truncated.
 *  - ≥2 summaries → `<base> (N edits)`. The bullets live in the body
 *    (`ok-contributors.summaries`) and in the TimelinePanel UI — the
 *    subject only carries the count so `git log --oneline` stays one line.
 *
 * Both `base` and each `summaries[i]` are stripped of line-break codepoints
 * (LF, CR, VT, FF, NEL, U+2028, U+2029) before composition — see
 * `SUBJECT_LINE_BREAK_RE` above. This is a structural invariant of the
 * function: the returned string is guaranteed to be a single line, even
 * when the API-boundary `normalizeSummary` is bypassed.
 *
 * Truncation preserves the base, separator, and suffix so the `grep`-friendly
 * target stays intact even for very short terminal widths. Matches the
 * `normalizeSummary` API-boundary truncation in `agent-write-summary.ts` by
 * using the same single-codepoint `…` rather than three ASCII dots.
 */
export function composeCommitSubject(base: string, summaries: readonly string[]): string {
  const safeBase = stripLineBreaks(base);
  if (summaries.length === 0) return safeBase;
  if (summaries.length >= 2) return `${safeBase} (${summaries.length} edits)`;
  const [rawSummary] = summaries;
  if (rawSummary === undefined) return safeBase; // defensive; length-1 branch guards against this
  const summary = stripLineBreaks(rawSummary);
  const full = `${safeBase} — ${summary}`;
  if (full.length <= COMMIT_SUBJECT_MAX_LEN) return full;
  const prefix = `${safeBase} — `;
  const budget = COMMIT_SUBJECT_MAX_LEN - prefix.length - 1; // reserve one char for the ellipsis
  if (budget <= 0) return full.slice(0, COMMIT_SUBJECT_MAX_LEN); // base already over budget — defensive slice
  return `${prefix}${summary.slice(0, budget)}…`;
}

/**
 * Classify a writer id using the documented prefix convention. Unknown
 * prefixes (legacy commits, external git operations) classify as 'unknown'
 * and `isAgent` is `null` — agents reasoning about attribution should
 * treat that as indeterminate, not as "not an agent."
 */
export function parseWriterId(id: string): ParsedWriter {
  if (!WRITER_ID_RE.test(id)) {
    return { id, classification: 'unknown', isAgent: null };
  }
  if (id.startsWith('agent-')) return { id, classification: 'agent', isAgent: true };
  if (id.startsWith('principal-')) return { id, classification: 'principal', isAgent: false };
  if (id === 'file-system') return { id, classification: 'classified-file-system', isAgent: null };
  if (id === 'git-upstream')
    return { id, classification: 'classified-git-upstream', isAgent: null };
  if (id === 'openknowledge-service')
    return { id, classification: 'classified-openknowledge-service', isAgent: null };
  // Unreachable given the regex, but keeps the type narrowing honest.
  return { id, classification: 'unknown', isAgent: null };
}
