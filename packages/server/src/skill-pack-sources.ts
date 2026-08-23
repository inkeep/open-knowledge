/**
 * Enumerate the skills a starter pack ships.
 *
 * A pack dir is one of two shapes, and both are supported everywhere a pack
 * skill is resolved (install, seed plan, dist composition, update detection):
 *
 *   packs/plain-notes/SKILL.md                     → one skill
 *
 *   packs/software-lifecycle/SKILL.md              → the pack's orientation skill
 *   packs/software-lifecycle/write-a-spec/SKILL.md → one member skill
 *
 * A member skill is any immediate subdirectory holding its own `SKILL.md`;
 * `references/` and friends carry no `SKILL.md` and stay with the owning skill.
 * Skill names come from SKILL.md frontmatter — the single naming authority,
 * shared with the public-mirror projection (`deriveSkillMoves` reads the same
 * `name:` line), so the public directory name and the install target cannot
 * diverge. Skill name == leaf directory name in every install target, per the
 * Agent Skills standard, so the root skill's copy must EXCLUDE the member dirs
 * and the pack-level `README.md` (`excludePaths`) or they would ship inside
 * the installed root skill.
 */

import { type Dirent, existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { type ResolveBundledSkillDirOptions, resolveBundledSkillDir } from './build-skill-zip.ts';

export interface PackSkillSource {
  /** Frontmatter `name` == the leaf dir this skill installs as. */
  readonly name: string;
  readonly sourceDir: string;
  /**
   * Entries of `sourceDir` that must not ship with this skill's copy: member
   * skill dirs (skills in their own right) and the pack-level README. Empty
   * for member skills themselves.
   */
  readonly excludePaths: readonly string[];
}

/** Immediate subdirectories of `root` that hold their own `SKILL.md`. */
function skillDirsUnder(root: string): string[] {
  let entries: Dirent[];
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory() && existsSync(join(root, e.name, 'SKILL.md')))
    .map((e) => e.name)
    .sort();
}

/** Frontmatter `name:`, falling back to the leaf dir name (Agent Skills standard). */
function frontmatterName(skillDir: string): string {
  let md: string;
  try {
    md = readFileSync(join(skillDir, 'SKILL.md'), 'utf8');
  } catch {
    return basename(skillDir);
  }
  return /^name:[ \t]*(\S+)[ \t]*$/m.exec(md)?.[1] ?? basename(skillDir);
}

/** Pure enumeration over an already-resolved pack directory. */
export function enumeratePackSkills(packDir: string): PackSkillSource[] {
  const members = skillDirsUnder(packDir);
  // Packs are also Agent Plugins (agent-plugins.org): a `plugin.json` manifest
  // plus, in the spec's layout, member skills under `skills/`. Both member
  // locations are enumerated so the legacy shape and the conformant shape work
  // during and after the layout migration; the manifest and the `skills/` dir
  // must never ship inside the root skill's copy.
  const specMembers = skillDirsUnder(join(packDir, 'skills')).map((name) => join('skills', name));
  const sources: PackSkillSource[] = [];
  if (existsSync(join(packDir, 'SKILL.md'))) {
    sources.push({
      name: frontmatterName(packDir),
      sourceDir: packDir,
      excludePaths: [...members, 'README.md', 'plugin.json', 'skills'],
    });
  }
  for (const member of [...members, ...specMembers]) {
    sources.push({
      name: frontmatterName(join(packDir, member)),
      sourceDir: join(packDir, member),
      excludePaths: [],
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
  return enumeratePackSkills(packDir);
}
