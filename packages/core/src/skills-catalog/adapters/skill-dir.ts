import { join } from 'node:path';
import { NO_INERT, readSkillDir, type SkillBundle, skillDirNames } from './shared.ts';

export function enumerateSkillDir(skillsRoot: string, harness: string): SkillBundle[] {
  const bundles: SkillBundle[] = [];
  for (const name of skillDirNames(skillsRoot)) {
    const skill = readSkillDir(join(skillsRoot, name), harness, {}, NO_INERT);
    if (!skill) continue;
    bundles.push({ packName: skill.name, packVersion: '0.0.0', harness, skills: [skill] });
  }
  return bundles;
}
