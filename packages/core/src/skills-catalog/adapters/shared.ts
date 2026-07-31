/**
 * Shared adapter primitives: the intermediate bundle/skill shapes both
 * adapters emit, the single SKILL.md reader, and the inert-capability probe.
 *
 * Read-only: every fs call here is a read. A malformed SKILL.md never throws —
 * frontmatter that fails to parse falls back to the directory name so one bad
 * skill is degraded, not fatal (the enumerator skips/degrades, never aborts).
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { readSkillManifestMeta } from '../manifest-meta.ts';
import type { SkillInert, SkillProvenance } from '../schema.ts';

/** A skill read from disk, pre-normalization. */
export interface RawSkill {
  readonly name: string;
  readonly description: string;
  readonly home: string;
  readonly harness: string;
  readonly skillMd: string;
  readonly scripts: string[];
  readonly references: string[];
  readonly provenance: SkillProvenance;
  readonly inert: SkillInert;
}

/** A source bundle (one Claude plugin, or one bare skill-dir) and its skills. */
export interface SkillBundle {
  readonly packName: string;
  readonly packVersion: string;
  /** Plugin `description` where the source records one (bare dirs: undefined). */
  readonly packDescription?: string;
  /** Plugin `author.name` where recorded. */
  readonly packAuthor?: string;
  readonly harness: string;
  readonly skills: RawSkill[];
}

/** Files under `dir` (recursive), absolute paths, files only. `[]` when absent. */
function listFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir, { recursive: true, withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => join(e.parentPath, e.name))
      .sort();
  } catch {
    return [];
  }
}

/**
 * Read one skill directory (`<dir>/SKILL.md` + optional `scripts/`/`references/`).
 * Returns `null` when there is no `SKILL.md` (skip it). On malformed frontmatter
 * the skill still returns, with `name` falling back to the dir name and an empty
 * description — degrade-not-abort.
 */
export function readSkillDir(
  dir: string,
  harness: string,
  provenance: SkillProvenance,
  inert: SkillInert,
): RawSkill | null {
  const skillMd = join(dir, 'SKILL.md');
  if (!existsSync(skillMd)) return null;
  const dirName = basename(dir);
  let name = dirName;
  let description = '';
  try {
    ({ name, description } = readSkillManifestMeta(readFileSync(skillMd, 'utf-8'), dirName));
  } catch {
    // Unreadable SKILL.md → keep the dir-name fallback rather than abort.
  }
  return {
    name,
    description,
    home: dir,
    harness,
    skillMd,
    scripts: listFiles(join(dir, 'scripts')),
    references: listFiles(join(dir, 'references')),
    provenance,
    inert,
  };
}

/** Skill-dir names directly under `root` (each a candidate `<name>/SKILL.md`). */
export function skillDirNames(root: string): string[] {
  if (!existsSync(root)) return [];
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

/** Presence-only inert flags for a bundle root (`commands/`, `hooks/`, `.mcp.json`). */
export function detectInert(bundleRoot: string): SkillInert {
  const isDir = (p: string): boolean => {
    try {
      return statSync(p).isDirectory();
    } catch {
      return false;
    }
  };
  return {
    commands: isDir(join(bundleRoot, 'commands')),
    hooks: isDir(join(bundleRoot, 'hooks')),
    mcp: existsSync(join(bundleRoot, '.mcp.json')),
  };
}

/** Inert flags with everything off — bare skill-dirs ship no capabilities. */
export const NO_INERT: SkillInert = { commands: false, hooks: false, mcp: false };
