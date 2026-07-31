/**
 * Generic skill-dir adapter — `<home>/skills/<name>/SKILL.md` for every bare
 * harness home (claude-personal, codex, cursor, opencode, agents). No
 * provenance (the dir records none) and no inert capabilities. Each skill is
 * its own one-skill bundle; the enumerator de-dupes same-named bundles across
 * homes into a single Pack.
 *
 * Read-only.
 */

import { join } from 'node:path';
import { NO_INERT, readSkillDir, type SkillBundle, skillDirNames } from './shared.ts';

/** `skillsRoot` is the `<home>/skills` directory. Returns `[]` when absent. */
export function enumerateSkillDir(skillsRoot: string, harness: string): SkillBundle[] {
  const bundles: SkillBundle[] = [];
  for (const name of skillDirNames(skillsRoot)) {
    const skill = readSkillDir(join(skillsRoot, name), harness, {}, NO_INERT);
    if (!skill) continue;
    bundles.push({ packName: skill.name, packVersion: '0.0.0', harness, skills: [skill] });
  }
  return bundles;
}
