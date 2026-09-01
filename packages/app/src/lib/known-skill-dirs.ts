import type { SkillsListEntry } from '@inkeep/open-knowledge-core';

let knownDirs: ReadonlySet<string> = new Set();

export function projectSkillBundleDirs(skills: readonly SkillsListEntry[]): ReadonlySet<string> {
  const dirs = new Set<string>();
  for (const skill of skills) {
    if (skill.scope !== 'project') continue;
    if (skill.managed === true) continue;
    for (const filePath of [skill.path, skill.canonicalPath]) {
      if (filePath === undefined) continue;
      const slash = filePath.lastIndexOf('/');
      if (slash > 0) dirs.add(filePath.slice(0, slash));
    }
  }
  return dirs;
}

export function getKnownProjectSkillDirs(): ReadonlySet<string> {
  return knownDirs;
}

export function setKnownProjectSkillDirs(next: ReadonlySet<string>): void {
  knownDirs = next;
}

export function __resetKnownProjectSkillDirsForTests(): void {
  knownDirs = new Set();
}
