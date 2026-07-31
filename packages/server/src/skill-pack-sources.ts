/**
 * Enumerate the skills a starter pack ships.
 *
 * A pack dir is one of two shapes, and both are supported everywhere a pack
 * skill is resolved (install, seed plan, dist composition, update detection):
 *
 *   packs/plain-notes/SKILL.md                    → one skill, `open-knowledge-pack-plain-notes`
 *
 *   packs/software-lifecycle/SKILL.md             → `open-knowledge-pack-software-lifecycle`
 *   packs/software-lifecycle/write-a-spec/SKILL.md → `…-software-lifecycle-write-a-spec`
 *
 * A member skill is any immediate subdirectory holding its own `SKILL.md`;
 * `references/` and friends carry no `SKILL.md` and stay with the owning skill.
 * Skill name == leaf directory name in every install target, per the Agent Skills
 * standard, so the root skill's copy must EXCLUDE the member dirs (`excludeDirs`)
 * or a member would ship twice, nested inside its parent.
 */

import { type Dirent, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { PACK_SKILL_PREFIX } from '@inkeep/open-knowledge-core';
import { type ResolveBundledSkillDirOptions, resolveBundledSkillDir } from './build-skill-zip.ts';

export interface PackSkillSource {
  /** Frontmatter `name` == the leaf dir this skill installs as. */
  readonly name: string;
  readonly sourceDir: string;
  /**
   * Subdirectories of `sourceDir` that are member skills in their own right —
   * omit them when copying this skill. Empty for member skills themselves.
   */
  readonly excludeDirs: readonly string[];
}

/** Immediate subdirectories of `packDir` that hold their own `SKILL.md`. */
function memberDirNames(packDir: string): string[] {
  let entries: Dirent[];
  try {
    entries = readdirSync(packDir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory() && existsSync(join(packDir, e.name, 'SKILL.md')))
    .map((e) => e.name)
    .sort();
}

/** Pure enumeration over an already-resolved pack directory. */
export function enumeratePackSkills(packId: string, packDir: string): PackSkillSource[] {
  const members = memberDirNames(packDir);
  const sources: PackSkillSource[] = [];
  if (existsSync(join(packDir, 'SKILL.md'))) {
    sources.push({
      name: `${PACK_SKILL_PREFIX}${packId}`,
      sourceDir: packDir,
      excludeDirs: members,
    });
  }
  for (const member of members) {
    sources.push({
      name: `${PACK_SKILL_PREFIX}${packId}-${member}`,
      sourceDir: join(packDir, member),
      excludeDirs: [],
    });
  }
  return sources;
}

/**
 * Every skill a pack ships, in install order (root skill first). Empty when the
 * pack ships no skill at all — `resolveBundledSkillDir` throws for a pack that
 * has no bundled directory, which is the "no skill" case, not an error.
 */
export function listPackSkillSources(
  packId: string,
  opts: ResolveBundledSkillDirOptions = {},
): PackSkillSource[] {
  let packDir: string;
  try {
    packDir = resolveBundledSkillDir(`packs/${packId}`, opts);
  } catch {
    return [];
  }
  return enumeratePackSkills(packId, packDir);
}
