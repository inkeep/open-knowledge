/**
 * Filesystem writers for skill artifacts at `<skillsRoot>/<name>/SKILL.md`.
 *
 * Mirrors `templates-write.ts` (the spine) for the new skill artifact
 * type. Differences from templates:
 *   - A skill is a DIRECTORY (`<skillsRoot>/<name>/`) holding `SKILL.md` plus
 *     optional `references/` and `scripts/` — not a single file. The directory
 *     name IS the skill name (load-bearing: it becomes the projected dir name
 *     and the agent-facing identity).
 *   - Frontmatter is the Agent Skills schema verbatim: `name` (required, ==dir,
 *     `^[a-z0-9-]+$`, ≤64) + `description` (required, ≤1024). NO `version`
 *     field; NO XML tags anywhere in `name`/`description` (breaks Claude Cowork
 *     and the skill loader). OK must NOT inject its own descriptive frontmatter.
 *
 * Scope-agnostic: the caller computes `skillsRoot` from scope —
 *   - project: `<projectDir>/.ok/skills`
 *   - global: `<userOkDir>/skills`
 * so this module stays free of scope/home resolution.
 *
 * Atomicity matches templates: write goes through tmp+rename for `SKILL.md`;
 * delete removes the whole skill dir; move renames the dir (relocation injected
 * so this module stays git-agnostic — the `git mv` primitive lives server-side,
 * exactly as `applyTemplateMove`).
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { isAbsolute, join, normalize, sep } from 'node:path';
import {
  containsXmlTag,
  SKILL_NAME_REGEX,
  type SkillFrontmatter,
} from '@inkeep/open-knowledge-core';
import { stringify as stringifyYaml } from 'yaml';

// ── Schema constants (Agent Skills standard) ──────────────────────────────
const NAME_MAX = 64;
const DESCRIPTION_MAX = 1024;
/** Reserved word the skill loader rejects in `name` (cross-vendor). */
const RESERVED_NAME_WORDS = ['anthropic', 'claude'];
/** Soft body-length guidance (warning, not error) — progressive disclosure. */
const BODY_SOFT_MAX_LINES = 500;
/** SKILL.md entrypoint filename (load-bearing for editor discovery). */
const SKILL_FILE = 'SKILL.md';

type SkillWriteResult =
  | { ok: true; path: string; created: boolean; warnings: string[] }
  | { ok: false; error: { code: string; message: string } };

/** Result of {@link composeSkillContent} — validated SKILL.md bytes, no disk I/O. */
export type SkillContentResult =
  | { ok: true; content: string; warnings: string[] }
  | { ok: false; error: { code: string; message: string } };

type SkillDeleteResult =
  | { ok: true; path: string; existed: boolean }
  | { ok: false; error: { code: string; message: string } };

type SkillMoveResult =
  | { ok: true; fromPath: string; toPath: string; committed: boolean }
  | { ok: false; error: { code: string; message: string } };

interface WriteSkillInput {
  /** Absolute path to the `.ok/skills` dir for the target scope. */
  skillsRoot: string;
  /** Skill name (== directory). Validated against SKILL_NAME_REGEX + reserved words. */
  name: string;
  /** SKILL.md body (markdown, no frontmatter — frontmatter is built here). */
  body: string;
  frontmatter: SkillFrontmatter;
}

interface DeleteSkillInput {
  skillsRoot: string;
  name: string;
}

interface MoveSkillInput {
  skillsRoot: string;
  fromName: string;
  toName: string;
  /**
   * Relocate the skill dir on disk. Injected so this module stays git-agnostic
   * (the `git mv` primitive lives server-side, as in `applyTemplateMove`).
   * Returns `true` for a tracked `git mv` (history-preserving), `false` for a
   * plain rename fallback.
   */
  relocate: (fromAbs: string, toAbs: string) => Promise<boolean>;
}

/**
 * Validate a skill's name + frontmatter and serialize the full SKILL.md bytes
 * (`---\n<fm>---\n<body>`) — WITHOUT touching disk. This is the frontmatter-
 * composition + validation core shared by the fs writer (`applySkillWrite`) and
 * the CRDT write path (the `skill-put` handler routes the returned `content`
 * through the doc's Y.Text). Keeping composition here preserves purity: OK
 * builds `name`+`description` server-side; callers never inject frontmatter.
 */
export function composeSkillContent(input: {
  name: string;
  body: string;
  frontmatter: SkillFrontmatter;
}): SkillContentResult {
  const nameCheck = validateName(input.name);
  if (!nameCheck.ok) return { ok: false, error: nameCheck.error };

  // `name` frontmatter must equal the directory name (skill-loader contract).
  const fmCheck = validateFrontmatter(input.frontmatter, input.name);
  if (!fmCheck.ok) return { ok: false, error: fmCheck.error };

  const fmYaml = serializeFrontmatter(input.frontmatter);
  const content = `---\n${fmYaml}---\n${input.body}`;

  const warnings: string[] = [];
  const lineCount = input.body.split('\n').length;
  if (lineCount > BODY_SOFT_MAX_LINES) {
    warnings.push(
      `SKILL.md body is ${lineCount} lines — keep it under ${BODY_SOFT_MAX_LINES} for performance (every line is a recurring token cost). Move detail into one-level-deep references/.`,
    );
  }
  return { ok: true, content, warnings };
}

export function applySkillWrite(input: WriteSkillInput): SkillWriteResult {
  const base = validateBase(input.skillsRoot);
  if (!base.ok) return { ok: false, error: base.error };

  const composed = composeSkillContent({
    name: input.name,
    body: input.body,
    frontmatter: input.frontmatter,
  });
  if (!composed.ok) return { ok: false, error: composed.error };
  const { content, warnings } = composed;

  const { skillDir, filePath } = skillPaths(input.skillsRoot, input.name);

  try {
    mkdirSync(skillDir, { recursive: true });
  } catch (err) {
    return {
      ok: false,
      error: {
        code: 'WRITE_ERROR',
        message: `Failed to create skill directory at ${relPathOf(input.skillsRoot, skillDir)}: ${(err as Error).message}`,
      },
    };
  }

  const created = !existsSync(filePath);

  // Atomic write: tmp + rename so the file-watcher sees one event.
  const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  try {
    writeFileSync(tmpPath, content, 'utf-8');
    renameSync(tmpPath, filePath);
  } catch (err) {
    try {
      unlinkSync(tmpPath);
    } catch {
      // Best effort — tmp may not exist or already moved.
    }
    return {
      ok: false,
      error: {
        code: 'WRITE_ERROR',
        message: `Failed to write skill at ${relPathOf(input.skillsRoot, filePath)}: ${(err as Error).message}`,
      },
    };
  }

  return { ok: true, path: relPathOf(input.skillsRoot, filePath), created, warnings };
}

// ── Bundle files (references/** + scripts/**) ──────────────────────────────
// fs-direct writer/deleter for the non-SKILL.md files of a skill bundle. Used
// for global-scope `.md` references and ALL scripts (project `.md` references
// route through the CRDT content-doc path instead — they are graph citizens).
// The relative path is validated by the verb layer (`resolveSkillFilePath`);
// this module re-checks the cheap invariants (containment, allowed root) so the
// helper is safe to call independently. Atomicity matches `applySkillWrite`
// (tmp + rename); a write into a non-existent skill dir is refused (the skill's
// SKILL.md must exist first).

/** Per-file byte cap for a skill bundle file. Single source — the API handler
 *  (`/api/skill-file` PUT) imports this rather than re-stating the literal. */
export const BUNDLE_FILE_MAX_BYTES = 256 * 1024;
/** Max bundle files (excl. SKILL.md) a single skill may hold. Single source —
 *  enforced by BOTH the fs-direct write (below) and the API handler's content
 *  branch (project `.md` references route through the CRDT content path, not
 *  this writer, so they import this + `countBundleFiles` to enforce the same
 *  cap). */
export const BUNDLE_MAX_FILES = 50;

interface BundleFileInput {
  skillsRoot: string;
  /** Skill name (== directory). */
  name: string;
  /** Skill-relative POSIX path under `references/` or `scripts/`. */
  relPath: string;
}

type BundleFileWriteResult =
  | { ok: true; path: string; created: boolean }
  | { ok: false; error: { code: string; message: string } };

type BundleFileDeleteResult =
  | { ok: true; path: string; existed: boolean }
  | { ok: false; error: { code: string; message: string } };

/**
 * Re-validate a skill-relative bundle path lexically (allowed root +
 * containment) and resolve it to an absolute path inside the skill dir.
 */
function resolveBundleFileAbs(
  skillDir: string,
  relPath: string,
): { ok: true; abs: string } | { ok: false; error: { code: string; message: string } } {
  if (typeof relPath !== 'string' || relPath.length === 0 || relPath.includes('\x00')) {
    return { ok: false, error: { code: 'BAD_FILE_PATH', message: 'Invalid skill file path.' } };
  }
  const segments = relPath
    .replace(/\\/g, '/')
    .split('/')
    .filter((s) => s !== '' && s !== '.');
  if (segments.length < 2 || segments.some((s) => s === '..')) {
    return {
      ok: false,
      error: { code: 'BAD_FILE_PATH', message: `Invalid skill file path: ${relPath}` },
    };
  }
  if (segments[0] !== 'references' && segments[0] !== 'scripts') {
    return {
      ok: false,
      error: {
        code: 'BAD_FILE_PATH',
        message: `Skill file must be under references/ or scripts/: ${relPath}`,
      },
    };
  }
  const abs = join(skillDir, ...segments);
  // Defense in depth: the lexical join must stay inside the skill dir.
  if (abs !== skillDir && !abs.startsWith(skillDir + sep)) {
    return {
      ok: false,
      error: { code: 'BAD_FILE_PATH', message: `Skill file escapes the skill dir: ${relPath}` },
    };
  }
  return { ok: true, abs };
}

/** Count existing bundle files (everything beside SKILL.md), bounded scan. */
export function countBundleFiles(skillDir: string): number {
  let count = 0;
  const walk = (dir: string): void => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const entryName of names) {
      const abs = join(dir, entryName);
      let isDir: boolean;
      try {
        isDir = statSync(abs).isDirectory();
      } catch {
        continue;
      }
      if (isDir) walk(abs);
      else if (!(dir === skillDir && entryName === SKILL_FILE)) count++;
    }
  };
  walk(skillDir);
  return count;
}

/**
 * Write one bundle file (fs-direct, atomic tmp+rename). Refuses a write into a
 * skill whose `SKILL.md` does not exist (a bundle file is meaningless without
 * its skill), an over-cap file, and a per-skill file-count overflow.
 */
export function applySkillBundleFileWrite(
  input: BundleFileInput & { content: string },
): BundleFileWriteResult {
  const base = validateBase(input.skillsRoot);
  if (!base.ok) return { ok: false, error: base.error };
  const nameCheck = validateName(input.name);
  if (!nameCheck.ok) return { ok: false, error: nameCheck.error };

  const { skillDir, filePath: skillMd } = skillPaths(input.skillsRoot, input.name);
  if (!existsSync(skillMd)) {
    return {
      ok: false,
      error: {
        code: 'SKILL_NOT_FOUND',
        message: `No skill "${input.name}" — create it (write its SKILL.md) before adding bundle files.`,
      },
    };
  }
  const resolved = resolveBundleFileAbs(skillDir, input.relPath);
  if (!resolved.ok) return { ok: false, error: resolved.error };
  const { abs } = resolved;

  const byteLength = Buffer.byteLength(input.content, 'utf-8');
  if (byteLength > BUNDLE_FILE_MAX_BYTES) {
    return {
      ok: false,
      error: {
        code: 'FILE_TOO_LARGE',
        message: `Skill file ${input.relPath} is ${byteLength} bytes — the per-file cap is ${BUNDLE_FILE_MAX_BYTES}.`,
      },
    };
  }

  const created = !existsSync(abs);
  if (created && countBundleFiles(skillDir) >= BUNDLE_MAX_FILES) {
    return {
      ok: false,
      error: {
        code: 'TOO_MANY_FILES',
        message: `Skill "${input.name}" already holds ${BUNDLE_MAX_FILES} bundle files (the cap) — delete one before adding another.`,
      },
    };
  }

  try {
    mkdirSync(join(abs, '..'), { recursive: true });
  } catch (err) {
    return {
      ok: false,
      error: {
        code: 'WRITE_ERROR',
        message: `Failed to create directory for ${input.relPath}: ${(err as Error).message}`,
      },
    };
  }
  const tmpPath = `${abs}.tmp.${process.pid}.${Date.now()}`;
  try {
    writeFileSync(tmpPath, input.content, 'utf-8');
    renameSync(tmpPath, abs);
  } catch (err) {
    try {
      unlinkSync(tmpPath);
    } catch {
      // Best effort — tmp may not exist or already moved.
    }
    return {
      ok: false,
      error: {
        code: 'WRITE_ERROR',
        message: `Failed to write skill file ${input.relPath}: ${(err as Error).message}`,
      },
    };
  }
  return {
    ok: true,
    path: relPathOf(input.skillsRoot, abs),
    created,
  };
}

/**
 * Delete one bundle file (fs-direct). A no-op (file absent) reports
 * `existed: false`. Prunes a now-empty `references/`/`scripts/` dir; never
 * touches SKILL.md or the skill dir itself.
 */
export function applySkillBundleFileDelete(input: BundleFileInput): BundleFileDeleteResult {
  const base = validateBase(input.skillsRoot);
  if (!base.ok) return { ok: false, error: base.error };
  const nameCheck = validateName(input.name);
  if (!nameCheck.ok) return { ok: false, error: nameCheck.error };

  const { skillDir } = skillPaths(input.skillsRoot, input.name);
  const resolved = resolveBundleFileAbs(skillDir, input.relPath);
  if (!resolved.ok) return { ok: false, error: resolved.error };
  const { abs } = resolved;

  const existed = existsSync(abs);
  if (existed) {
    try {
      unlinkSync(abs);
    } catch (err) {
      return {
        ok: false,
        error: {
          code: 'UNLINK_FAILED',
          message: `Failed to delete skill file ${input.relPath}: ${(err as Error).message}`,
        },
      };
    }
    // Prune a now-empty top-level dir (references/ or scripts/), leaving the
    // skill dir + SKILL.md intact.
    const parent = join(abs, '..');
    if (parent !== skillDir && isEmpty(parent)) {
      try {
        rmdirSync(parent);
      } catch {
        // race / non-empty — leave it.
      }
    }
  }
  return { ok: true, path: relPathOf(input.skillsRoot, abs), existed };
}

export function applySkillDelete(input: DeleteSkillInput): SkillDeleteResult {
  const base = validateBase(input.skillsRoot);
  if (!base.ok) return { ok: false, error: base.error };
  const nameCheck = validateName(input.name);
  if (!nameCheck.ok) return { ok: false, error: nameCheck.error };

  const { skillsRoot } = base;
  const { skillDir } = skillPaths(input.skillsRoot, input.name);

  const existed = existsSync(skillDir);
  if (existed) {
    try {
      // Remove the whole skill dir (SKILL.md + references/ + scripts/).
      rmSync(skillDir, { recursive: true, force: true });
    } catch (err) {
      return {
        ok: false,
        error: {
          code: 'UNLINK_FAILED',
          message: `Failed to delete skill at ${relPathOf(input.skillsRoot, skillDir)}: ${(err as Error).message}`,
        },
      };
    }
  }
  // Auto-clean an empty `.ok/skills` then `.ok/` left behind.
  cleanEmptyDirs(skillsRoot);

  return { ok: true, path: relPathOf(input.skillsRoot, skillDir), existed };
}

/**
 * Rename a skill `fromName` → `toName` (changes its identity == dir name).
 * Refuses a no-op, a missing source, and a destination collision. The dir
 * relocation is delegated to `input.relocate` (git mv with fs fallback). The
 * SKILL.md body's `name` frontmatter is NOT rewritten here — the caller layers
 * an `applySkillWrite` at the destination to keep `name`==dir (atomic
 * move+edit), exactly as the template move spine does.
 */
export async function applySkillMove(input: MoveSkillInput): Promise<SkillMoveResult> {
  const base = validateBase(input.skillsRoot);
  if (!base.ok) return { ok: false, error: base.error };
  const fromCheck = validateName(input.fromName);
  if (!fromCheck.ok) return { ok: false, error: fromCheck.error };
  const toCheck = validateName(input.toName);
  if (!toCheck.ok) return { ok: false, error: toCheck.error };

  const from = skillPaths(input.skillsRoot, input.fromName);
  const to = skillPaths(input.skillsRoot, input.toName);

  if (from.skillDir === to.skillDir) {
    return {
      ok: false,
      error: { code: 'NOOP', message: 'Source and destination are the same skill.' },
    };
  }
  if (!existsSync(from.skillDir)) {
    return {
      ok: false,
      error: {
        code: 'SKILL_NOT_FOUND',
        message: `No skill at ${relPathOf(input.skillsRoot, from.skillDir)}.`,
      },
    };
  }
  if (existsSync(to.skillDir)) {
    return {
      ok: false,
      error: {
        code: 'SKILL_EXISTS',
        message: `A skill already exists at ${relPathOf(input.skillsRoot, to.skillDir)}.`,
      },
    };
  }

  let committed: boolean;
  try {
    committed = await input.relocate(from.skillDir, to.skillDir);
  } catch (err) {
    return {
      ok: false,
      error: { code: 'MOVE_FAILED', message: `Failed to move skill: ${(err as Error).message}` },
    };
  }

  return {
    ok: true,
    fromPath: relPathOf(input.skillsRoot, from.skillDir),
    toPath: relPathOf(input.skillsRoot, to.skillDir),
    committed,
  };
}

// ── Validation ────────────────────────────────────────────────────────────

function validateBase(
  skillsRoot: string,
): { ok: true; skillsRoot: string } | { ok: false; error: { code: string; message: string } } {
  if (!isAbsolute(skillsRoot)) {
    return {
      ok: false,
      error: { code: 'BAD_SKILLS_ROOT', message: 'skillsRoot must be absolute' },
    };
  }
  return { ok: true, skillsRoot };
}

function validateName(
  name: string,
): { ok: true } | { ok: false; error: { code: string; message: string } } {
  if (typeof name !== 'string' || name.length === 0) {
    return { ok: false, error: { code: 'BAD_NAME', message: 'Skill name is required.' } };
  }
  if (name.length > NAME_MAX) {
    return {
      ok: false,
      error: { code: 'BAD_NAME', message: `Skill name must be ≤${NAME_MAX} characters.` },
    };
  }
  if (!SKILL_NAME_REGEX.test(name)) {
    return {
      ok: false,
      error: {
        code: 'BAD_NAME',
        message: `Skill name must match /^[a-z0-9-]+$/ (got: ${JSON.stringify(name)}). Lowercase letters, digits, hyphens — no slashes, dots, spaces, or uppercase.`,
      },
    };
  }
  if (RESERVED_NAME_WORDS.some((w) => name.includes(w))) {
    return {
      ok: false,
      error: {
        code: 'RESERVED_NAME',
        message: `Skill name may not contain reserved words (${RESERVED_NAME_WORDS.join(', ')}).`,
      },
    };
  }
  return { ok: true };
}

/**
 * Validate the skill frontmatter against the Agent Skills schema:
 *   - `name` non-empty, ==dir name, no XML tags.
 *   - `description` non-empty, ≤1024, no XML tags.
 *   - NO `version` (or other unknown) keys — the loader ignores them and a
 *     KB-injected `version` would mislead; reject so authors don't rely on it.
 * The no-XML-tag rule is load-bearing: `<...>` in name/description breaks the
 * Claude Cowork parser and the skill loader.
 */
function validateFrontmatter(
  fm: SkillFrontmatter,
  dirName: string,
): { ok: true } | { ok: false; error: { code: string; message: string } } {
  if (!fm || typeof fm !== 'object') {
    return {
      ok: false,
      error: {
        code: 'BAD_FRONTMATTER',
        message: 'Skill frontmatter (name, description) is required.',
      },
    };
  }
  if (typeof fm.name !== 'string' || fm.name.length === 0) {
    return {
      ok: false,
      error: { code: 'SKILL_NAME_REQUIRED', message: 'Skill frontmatter.name is required.' },
    };
  }
  if (fm.name !== dirName) {
    return {
      ok: false,
      error: {
        code: 'NAME_DIR_MISMATCH',
        message: `Skill frontmatter.name (${JSON.stringify(fm.name)}) must equal the skill directory name (${JSON.stringify(dirName)}).`,
      },
    };
  }
  if (containsXmlTag(fm.name)) {
    return {
      ok: false,
      error: {
        code: 'XML_TAG_IN_NAME',
        message: 'Skill frontmatter.name may not contain XML tags (`<...>`).',
      },
    };
  }
  if (typeof fm.description !== 'string' || fm.description.length === 0) {
    return {
      ok: false,
      error: {
        code: 'SKILL_DESCRIPTION_REQUIRED',
        message:
          'Skill frontmatter.description is required — it is the primary triggering surface (when to use the skill).',
      },
    };
  }
  if (fm.description.length > DESCRIPTION_MAX) {
    return {
      ok: false,
      error: {
        code: 'DESCRIPTION_TOO_LONG',
        message: `Skill frontmatter.description must be ≤${DESCRIPTION_MAX} characters (got ${fm.description.length}).`,
      },
    };
  }
  if (containsXmlTag(fm.description)) {
    return {
      ok: false,
      error: {
        code: 'XML_TAG_IN_DESCRIPTION',
        message:
          'Skill frontmatter.description may not contain XML tags (`<...>`) — they break the Cowork parser and skill loader.',
      },
    };
  }
  return { ok: true };
}

function skillPaths(skillsRoot: string, name: string): { skillDir: string; filePath: string } {
  const skillDir = join(skillsRoot, name);
  const filePath = join(skillDir, SKILL_FILE);
  return { skillDir, filePath };
}

/**
 * Auto-clean the now-possibly-empty `.ok/skills` then its parent `.ok/` after a
 * delete/move-out. A non-empty dir (other skills, or `.ok/` still holding
 * templates/frontmatter/local) is left intact. Mirrors `cleanEmptyOkDirs` in
 * templates-write.ts.
 */
function cleanEmptyDirs(skillsRoot: string): void {
  if (existsSync(skillsRoot) && isEmpty(skillsRoot)) {
    try {
      rmdirSync(skillsRoot);
    } catch {
      // race / permission — leave it
    }
  }
  // skillsRoot is `<...>/.ok/skills`; its parent is `<...>/.ok`.
  const okDir = normalize(join(skillsRoot, '..'));
  if (okDir.endsWith(`${sep}.ok`) && existsSync(okDir) && isEmpty(okDir)) {
    try {
      rmdirSync(okDir);
    } catch {
      // non-empty (frontmatter.yml / templates / local) — leave it
    }
  }
}

function relPathOf(base: string, abs: string): string {
  const rel = abs.startsWith(base + sep) ? abs.slice(base.length + 1) : abs;
  return normalize(rel).split(sep).join('/');
}

function serializeFrontmatter(fm: SkillFrontmatter): string {
  // Order: name then description (schema canonical order). No other keys.
  return stringifyYaml({ name: fm.name, description: fm.description });
}

function isEmpty(absDir: string): boolean {
  try {
    return readdirSync(absDir).length === 0;
  } catch {
    return false;
  }
}
