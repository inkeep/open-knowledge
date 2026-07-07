/**
 * Scaffold writer for a new OpenKnowledge project. Creates `.ok/config.yml`,
 * `.ok/.gitignore`, and the project-root `.okignore` with safe defaults.
 *
 * Lives in `@inkeep/open-knowledge-server` because BOTH the CLI's `ok init`
 * command and the server's `POST /api/local-op/ok-init` HTTP endpoint need to
 * call it. Server is the lower layer (no CLI deps), so the impl lives here and
 * CLI consumes it; the inverse would invert the package dependency direction.
 *
 * Disk writes route through `fs-traced.ts` wrappers per the server STOP rule.
 * The wrappers gracefully no-op when telemetry is disabled, so this module is
 * safe to call from the CLI and Electron main process where no OTel context
 * is configured.
 */

import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { CONFIG_SCHEMA_MAJOR_PATH, LOCAL_DIR, OK_DIR } from '@inkeep/open-knowledge-core';
import { tracedMkdirSync, tracedWriteFileSync } from './fs-traced.ts';

/**
 * Project config filename inside `.ok/`. Constant lives here (not in core)
 * because the marker check is operationally tied to the scaffold writer and
 * `isProjectRoot` (`fs/find-project-root.ts`) — both server-owned surfaces.
 */
export const CONFIG_FILENAME = 'config.yml';

/**
 * Refuse to operate on a path that exists as a symlink. `existsSync` /
 * `readFileSync` / `writeFileSync` all transparently follow symlinks, so an
 * upstream-committed `.ok/.gitignore` (or `.ok/`, `.ok/config.yml`,
 * `.okignore`) pointing at e.g. `~/.bashrc` would let an attacker either
 * (a) append OK scaffold lines to a victim file via the read-modify-write
 * in `ensureGitignoreEntries`, or (b) plant the OK scaffold contents at
 * an arbitrary path via the dangling-symlink branch of `writeIfMissing`.
 *
 * Threat model: `ok clone <untrusted-url>` calls `runInit()` on the freshly
 * cloned tree before the user has had a chance to inspect it. Any path the
 * upstream controls is hostile until proven otherwise. `ok init` and the
 * server-side `POST /api/local-op/ok-init` share the same scaffold path —
 * apply the check here so every entry point is covered.
 *
 * Uses `lstatSync` (does NOT follow symlinks). ENOENT is benign — the
 * caller's `existsSync` branch will create a fresh file.
 */
function assertNotSymlink(filePath: string, label: string): void {
  let lst: ReturnType<typeof lstatSync>;
  try {
    lst = lstatSync(filePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
  if (lst.isSymbolicLink()) {
    throw new Error(
      `Refusing to follow symlink at ${label} (${filePath}). ` +
        `An untrusted upstream may have committed this symlink to redirect writes outside the project. ` +
        `Remove the symlink and re-run.`,
    );
  }
}

/**
 * Build the `$schema` URL for a scaffolded project `config.yml`.
 *
 * Schema versioning is INDEPENDENT of the npm package version. The URL pins
 * to the schema MAJOR (`v0`, `v1`, …) and uses the npm `@latest` dist-tag
 * for the package itself — additive changes (new optional fields, new enum
 * values) reach existing users automatically as soon as unpkg's `@latest`
 * cache refreshes (typically <1h). Breaking changes bump the schema MAJOR
 * and emit to a new directory; the old directory keeps shipping for legacy
 * YAMLs that never re-pin.
 */
export function packageVersionMajorMinor(version: string): string {
  // Default-on-undefined ([major = '0']) doesn't kick in for empty strings —
  // ''.split('.') returns [''], not []. Coerce empty segments to '0' so a
  // malformed version still yields a parsable URL slug.
  const [rawMajor = '0', rawMinor = '0'] = version.split('.');
  const major = rawMajor.length > 0 ? rawMajor : '0';
  const minor = rawMinor.length > 0 ? rawMinor : '0';
  return `${major}.${minor}`;
}

/**
 * Quote a YAML scalar safely for emission inside the rendered template.
 * Plain identifiers (`docs`, `a/b`, `with-dashes.txt`) round-trip without
 * quoting; anything containing whitespace, colons, or other YAML-significant
 * characters falls back to `JSON.stringify` (valid YAML — JSON is a subset).
 */
function quoteYamlScalar(value: string): string {
  return /^[A-Za-z0-9._\-/]+$/.test(value) ? value : JSON.stringify(value);
}

export interface BuildConfigYmlOptions {
  /** When set and not `'.'`, the scaffold's commented `content.dir`
   * placeholder is replaced with the uncommented form so a freshly written
   * config.yml carries the resolved scope (e.g., git-root promotion's picked
   * sub-path). `'.'` and `undefined` both render the default commented
   * placeholder. */
  contentDir?: string;
}

/**
 * `_version` is retained on the signature for source-compat with callers
 * pre-versioning; it's no longer used in the URL — the URL pins to schema
 * major (from `CONFIG_SCHEMA_MAJOR_PATH`) and `@latest` of the package.
 */
export function buildConfigYmlContent(_version: string, options?: BuildConfigYmlOptions): string {
  const template = `# yaml-language-server: $schema=https://unpkg.com/@inkeep/open-knowledge@latest/dist/schemas/${CONFIG_SCHEMA_MAJOR_PATH}/config.project.schema.json
# OpenKnowledge — project configuration
#
# This file overrides built-in defaults for this project. Every key below
# is commented out and shows its current default value. Uncomment any key
# to override it.
#
# Precedence (lowest -> highest):
#   Built-in defaults
#     -> ~/${OK_DIR}/global.yml         (user defaults)
#     -> ./${OK_DIR}/config.yml         (this file)
#
# Schema reference: packages/core/src/config/schema.ts


# --- Content ---------------------------------------------------------------
# dir: where the CRDT editor reads/writes documents. Relative to the project
# root (the directory containing ${OK_DIR}/), NOT to this file.
#
# Path exclusions live in .okignore (gitignore syntax) at the project root,
# with nested .okignore files honored at any folder depth.
#
# content:
#   dir: .


# --- Suggested lifecycle (optional pattern) --------------------------------
# Projects that want an explicit knowledge-maturation flow can organize as
# three tiers *relative to the content directory* — create the subfolders
# only when you need them:
#
#   1. external-sources/  — raw content fetched from URLs, PDFs. No analysis,
#                           just preservation. Use the \`ingest\` MCP tool.
#   2. research/          — analysis and synthesis. Provisional findings,
#                           trade-offs, open questions. Use the \`research\`
#                           MCP tool.
#   3. articles/          — canonical knowledge. Use the \`consolidate\` MCP
#                           tool to promote research -> articles once
#                           decisions are made.
#
# This is a pattern, not a requirement. Projects with existing layouts
# (\`specs/\`, \`reports/\`, \`docs/\`, etc.) should use those; the lifecycle
# exists as mental scaffolding, not as enforced filesystem structure.


# --- Server ----------------------------------------------------------------
# Host: set via \`--host\` flag or \`HOST\` env var (default: localhost; use
# \`0.0.0.0\` to bind LAN-visible). Port: set via \`--port\` flag or \`PORT\`
# env var (auto-allocated if unset). Both are per-process runtime knobs —
# no \`server:\` schema field exists.


# --- Appearance ------------------------------------------------------------
# Theme for the chrome. Defaults UNSET so the existing localStorage cache
# (\`ok-theme-v1\`) keeps powering FOUC-free first paint until you
# explicitly write here.
#
# appearance:
#   theme: system            # 'light' | 'dark' | 'system'
`;
  const contentDir = options?.contentDir;
  if (contentDir === undefined || contentDir === '.') return template;
  return template.replace(
    '# content:\n#   dir: .',
    `content:\n  dir: ${quoteYamlScalar(contentDir)}`,
  );
}

function writeIfMissing(filePath: string, content: string, label: string): boolean {
  assertNotSymlink(filePath, label);
  if (existsSync(filePath)) return false;
  tracedWriteFileSync(filePath, content, 'utf-8');
  return true;
}

/**
 * Append missing scaffold entries to an existing `.gitignore`, or create the
 * file from scratch when absent. User customizations are preserved — only
 * entries that aren't already present (via trim-equality) get appended.
 *
 * Required entries are derived from `scaffoldContent`'s non-comment, non-empty
 * lines. This is the upgrade path: projects that ran `ok init` before this
 * scaffold gained `principal.json` / `last-spawn-error.log` would otherwise
 * never see the new entries because `writeIfMissing` short-circuits.
 */
function ensureGitignoreEntries(
  filePath: string,
  scaffoldContent: string,
): 'created' | 'updated' | 'unchanged' {
  assertNotSymlink(filePath, '.ok/.gitignore');
  if (!existsSync(filePath)) {
    tracedWriteFileSync(filePath, scaffoldContent, 'utf-8');
    return 'created';
  }
  const required = scaffoldContent
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('#'));
  const existing = readFileSync(filePath, 'utf-8');
  const present = new Set(existing.split('\n').map((l) => l.trim()));
  const missing = required.filter((l) => !present.has(l));
  if (missing.length === 0) return 'unchanged';
  const sep = existing.length === 0 || existing.endsWith('\n') ? '' : '\n';
  tracedWriteFileSync(filePath, `${existing}${sep}${missing.join('\n')}\n`, 'utf-8');
  return 'updated';
}

/**
 * Single source of truth for `.ok/.gitignore`.
 *
 * `.ok/local/` holds every per-machine OK runtime path — locks, caches, state
 * manifests, telemetry, error logs, atomic-write tmp files. The single
 * `local/` rule covers them all, so adding a new runtime file never requires
 * a `.gitignore` edit. The project root `.gitignore` stays free of
 * OK-internal entries — no `ok` command writes to it.
 *
 * `.ok/` root files (principal.json, state.json, *.lock, sync-state.json,
 * last-spawn-error.log) are explicitly listed because they carry PII
 * (principal email + UUID), hostnames, and absolute filesystem paths and
 * predate the `local/` consolidation. Listing them ensures pre-existing
 * checkouts (where these files were already created at the .ok/ root) don't
 * accidentally commit them on a future scaffold-aware re-init. The only
 * file at .ok/ root that SHOULD be committed is `config.yml` (project
 * configuration), which is explicitly NOT in this ignore list.
 */
const OK_GITIGNORE_CONTENT = `# .ok/local/ holds per-machine runtime state. Anything inside is
# machine-local and never committed. New runtime files (caches, locks,
# manifests, telemetry, error logs) are auto-ignored — no edit needed here.
${LOCAL_DIR}/

# .ok/worktrees/ holds git worktrees created from the desktop worktree
# selector — per-machine checkouts, never committed (WORKTREES_PARENT_DIR in
# @inkeep/open-knowledge-core). Worktree creation also appends this path to
# .git/info/exclude so projects whose committed rule predates it stay clean.
worktrees/

# Per-machine runtime state at the .ok/ root. Contains PII (principal email,
# UUID), hostnames, and absolute filesystem paths — never commit. The only
# file at .ok/ root that SHOULD be committed is \`config.yml\` (project
# configuration), which is explicitly NOT in this ignore list.
principal.json
state.json
server.lock
ui.lock
sync-state.json
last-spawn-error.log
`;

/**
 * Single source of truth for the project-root `.okignore` scaffold.
 *
 * Comment-only header — no example excludes ship by default. The body
 * teaches gitignore syntax + the cross-source `!` override that makes
 * `.okignore` strictly more expressive than the previous YAML
 * `content.exclude` block.
 */
export const OK_OKIGNORE_TEMPLATE = `# .okignore — paths to exclude from the OpenKnowledge document index.
# Uses gitignore syntax (parsed by the \`ignore\` npm library), evaluated
# alongside .gitignore in a single ignore-lib instance.
#
# Patterns combine with .gitignore: an entry here adds to exclusions, and
# a leading \`!\` re-includes a file that .gitignore excluded.
# Nested .okignore files at any folder depth are honored (mirrors .gitignore).
#
# Examples:
#   drafts/        # exclude a directory
#   *.draft.md     # exclude files matching a pattern
#   !keep.md       # re-include a file .gitignore excluded
`;

/**
 * Single source of truth for the seeded project-root `.gitignore`.
 *
 * OpenKnowledge is macOS-only today, so every project will accumulate
 * `.DS_Store` Finder-metadata files. Without an ignore entry the user's
 * first `git status` lists them as untracked — confusing for users new to
 * git, noisy for everyone else. The leading comment is attribution so a
 * reader who finds this file in their first commit understands where it
 * came from.
 *
 * Kept intentionally minimal: this is a seed, not a curated list. The file
 * becomes user-owned the moment it lands (writeIfMissing semantics), so
 * additional patterns are the user's call.
 */
export const ROOT_GITIGNORE_TEMPLATE = `# Seeded by OpenKnowledge when this project was created. Edit freely.
.DS_Store
`;

export interface InitContentOptions {
  /** When set and not `'.'`, scaffolded `.ok/config.yml` carries an
   * uncommented `content.dir: <value>` block. Used by the CLI's git-root
   * promotion path to scope the project to a sub-folder of the git
   * working tree without requiring the user to hand-edit the file. */
  contentDir?: string;
  /** Optional package version threaded through to `buildConfigYmlContent`.
   * The version is currently unused inside the rendered template (the
   * `$schema` URL pins to `CONFIG_SCHEMA_MAJOR_PATH` + `@latest`), but
   * callers continue to pass it so the upgrade path stays open. */
  packageVersion?: string;
}

export interface InitContentResult {
  created: string[];
  updated: string[];
  skipped: string[];
}

/**
 * Scaffold `.ok/` inside `projectDir`. Idempotent: returns `skipped` for
 * any file that already exists with content (preserves user customizations).
 *
 * Three writes:
 *   1. `.ok/.gitignore` — merge-on-upgrade (append missing entries)
 *   2. `.ok/config.yml` — writeIfMissing (user wins)
 *   3. `.okignore` at project root — writeIfMissing (user wins)
 *
 * `.ok/` itself is created with `tracedMkdirSync({recursive: true})`. Runtime
 * subdirs (`.ok/local/`, `.ok/local/cache/`, etc.) are created lazily by the
 * writers that need them.
 *
 * Symlink-guarded at every write — see `assertNotSymlink` for the threat
 * model. An upstream-committed `.ok/` symlink would silently redirect every
 * scaffold write to whatever target the attacker chose.
 */
export function initContent(projectDir: string, options?: InitContentOptions): InitContentResult {
  const okDir = resolve(projectDir, OK_DIR);
  const created: string[] = [];
  const updated: string[] = [];
  const skipped: string[] = [];

  assertNotSymlink(okDir, '.ok/');
  tracedMkdirSync(okDir, { recursive: true });

  // .gitignore: merge-on-upgrade — append missing scaffold entries to an
  // existing file rather than skipping outright. Today's scaffold is a single
  // `local/` rule; the merge logic also tolerates the historical multi-line
  // blacklist that earlier versions wrote, leaving its (now-inert) lines in
  // place to avoid clobbering hand-edits.
  const gitignoreAction = ensureGitignoreEntries(join(okDir, '.gitignore'), OK_GITIGNORE_CONTENT);
  if (gitignoreAction === 'created') {
    created.push('.gitignore');
  } else if (gitignoreAction === 'updated') {
    updated.push('.gitignore');
  } else {
    skipped.push('.gitignore');
  }

  // config.yml: writeIfMissing — user customizations win.
  if (
    writeIfMissing(
      join(okDir, CONFIG_FILENAME),
      buildConfigYmlContent(options?.packageVersion ?? '0.0.0', {
        contentDir: options?.contentDir,
      }),
      `.ok/${CONFIG_FILENAME}`,
    )
  ) {
    created.push(CONFIG_FILENAME);
  } else {
    skipped.push(CONFIG_FILENAME);
  }

  // .okignore at project root: writeIfMissing — never clobber an existing file.
  // Lives alongside .gitignore (not under .ok/) so users author it like any
  // other root-level ignore file. Patterns load through ContentFilter into the
  // same ignore-lib instance as .gitignore, with cross-source `!` overrides.
  if (writeIfMissing(join(projectDir, '.okignore'), OK_OKIGNORE_TEMPLATE, '.okignore')) {
    created.push('.okignore');
  } else {
    skipped.push('.okignore');
  }

  return { created, updated, skipped };
}

/**
 * Seed a project-root `.gitignore` with `ROOT_GITIGNORE_TEMPLATE` IFF the
 * file does not yet exist. Intended to be called by `ok init` / Desktop
 * create-new-project ONLY when `ensureProjectGit` actually ran `git init`
 * during this invocation (`{ didInit: true }`) — when an enclosing repo
 * already exists, its `.gitignore` is the user's (or their org's) and OK
 * does not touch it.
 *
 * Symlink-guarded (same threat model as `initContent`'s scaffold writes).
 * `writeIfMissing` semantics: a subsequent `ok init` against a project that
 * already has a `.gitignore` (whether seeded by us or hand-authored) is a
 * no-op.
 *
 * Lives next to `initContent` rather than inside it because (a) `initContent`
 * is also reused by `share publish` where the fresh-git-init signal isn't
 * directly available, and (b) the contract of `initContent` is specifically
 * the OK-internal scaffold (`.ok/` + `.okignore`) — the project-root
 * `.gitignore` is user-territory, seeded as a quality-of-life convenience.
 */
export function writeRootGitignoreForNewRepo(projectDir: string): 'created' | 'skipped' {
  return writeIfMissing(join(projectDir, '.gitignore'), ROOT_GITIGNORE_TEMPLATE, '.gitignore')
    ? 'created'
    : 'skipped';
}
