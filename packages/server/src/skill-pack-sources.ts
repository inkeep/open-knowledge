import { type Dirent, existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { type ResolveBundledSkillDirOptions, resolveBundledSkillDir } from './build-skill-zip.ts';

export interface PackSkillSource {
  readonly name: string;
  readonly sourceDir: string;
  readonly excludePaths: readonly string[];
}

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

function frontmatterName(skillDir: string): string {
  let md: string;
  try {
    md = readFileSync(join(skillDir, 'SKILL.md'), 'utf8');
  } catch {
    return basename(skillDir);
  }
  return /^name:[ \t]*(\S+)[ \t]*$/m.exec(md)?.[1] ?? basename(skillDir);
}

export function enumeratePackSkills(packDir: string): PackSkillSource[] {
  const members = skillDirsUnder(packDir);
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
