/**
 * Types for the `ok seed` scaffolder.
 *
 * folder metadata
 * lives in nested `<folder>/.ok/frontmatter.yml` files, NOT in a root
 * `config.yml folders:` array. The seed plans/applies file writes for
 * each starter folder's `.ok/frontmatter.yml` + `.ok/templates/<name>.md`.
 */

import type { PackId } from './starter.ts';

/**
 * A filesystem entry that the scaffolder will create on apply.
 */
export interface FileEntry {
  /** Path relative to the project root. */
  path: string;
  kind: 'folder' | 'file';
  /**
   * Template id used by apply() to look up the file content. Stable across
   * `rootDir` choices — the path may be `log.md` or `brain/log.md` depending
   * on where the user scaffolds, but the template id is always `log.md`.
   * For nested `.ok/` writes the template id encodes the file role
   * (`<folder>/frontmatter.yml`, `<folder>/template/<name>`). Required for
   * files; omitted for folders.
   */
  template?: string;
  /** For files, first N lines of the content to be written. Omitted for folders. */
  contentPreview?: string;
}

/**
 * An entry the scaffolder detected but will NOT write because it's already present
 * or would collide with user content. Surfaced so the plan is fully transparent.
 */
export interface SkipEntry {
  path: string;
  reason: 'already-exists' | 'user-content' | 'glob-collision';
}

/**
 * The full plan the scaffolder computed. A pure, read-only description of what
 * applySeed() would do — never performs writes itself.
 */
export interface ScaffoldPlan {
  /** Folders + files that will be newly created. */
  created: FileEntry[];
  /** Entries detected but skipped. */
  skipped: SkipEntry[];
  /** Non-fatal warnings surfaced during planning. */
  warnings: string[];
  /**
   * The pack's project-local skill, when the pack ships one. `pending` is true
   * when the skill source is absent from `.ok/skills/` and apply would (re)author
   * it. Folders/templates being present does NOT imply the skill is — so callers
   * must treat a pending skill as outstanding work, not "already set up".
   */
  packSkill?: { name: string; pending: boolean };
}

/**
 * Result of applying a ScaffoldPlan.
 *
 * Rollback semantics: on partial failure (e.g. EACCES mid-write), successfully-written
 * entries remain on disk; `errors` lists what failed. Not atomic.
 */
export interface ApplyResult {
  /** Count of folders/files successfully written. */
  applied: number;
  /** Per-path errors captured during apply. */
  errors: ApplyError[];
  /** Wall-clock duration in milliseconds. */
  durationMs: number;
  /**
   * Editor labels the pack's project-local skill was installed for (e.g.
   * `['Claude Code']`). Empty when no editor is set up for this project or the
   * pack ships no skill.
   */
  packSkillsInstalled: string[];
}

export interface ApplyError {
  /** Path that failed. */
  path: string;
  /** Error message. */
  error: string;
}

/**
 * Options accepted by planSeed() / applySeed(). `projectDir` defaults to cwd.
 *
 * `rootDir` is the folder (relative to `projectDir`) where the chosen starter
 * pack is scaffolded. Defaults to `.` (project root). Pass e.g. `'brain'` to
 * place all the pack's folders under `brain/`, with each starter folder's
 * nested `.ok/frontmatter.yml` written at e.g.
 * `brain/external-sources/.ok/frontmatter.yml`.
 *
 * `packId` selects which `STARTER_PACKS` entry to scaffold. Defaults to
 * `'knowledge-base'` for back-compat with callers that don't know about
 * multi-pack (matches the historical single-scaffold behavior).
 */
export interface SeedOptions {
  projectDir?: string;
  rootDir?: string;
  packId?: PackId;
  /**
   * Skip the `isProjectRoot` prerequisite gate so the plan can be computed in
   * an uninitialized dir. Set by `--dry-run`, whose whole purpose is to preview
   * a pack before `ok init`. Plan contents come from the static pack registry,
   * not from disk, so the result is a valid all-`created` preview.
   */
  skipPrerequisite?: boolean;
}

/**
 * Thrown by planSeed() when `.ok/config.yml` is absent (user must run `ok init`
 * first). The marker is the config file, not the `.ok/` directory: nested
 * folder-rule writes create `<folder>/.ok/` sidecars without `config.yml`.
 */
export class SeedPrerequisiteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SeedPrerequisiteError';
  }
}

/**
 * Thrown by planSeed() when the user-supplied `rootDir` is unusable —
 * absolute, contains `..` segments, resolves outside the project directory,
 * or otherwise rejected by normalization. Distinct from
 * `SeedPrerequisiteError` so callers (CLI, HTTP route, Electron IPC) can
 * surface a focused "fix your input" message rather than emit telemetry as
 * if the server malfunctioned.
 */
export class SeedRootDirError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SeedRootDirError';
  }
}
