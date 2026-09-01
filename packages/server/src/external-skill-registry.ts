import { resolve, sep } from 'node:path';
import { SKILL_NAME_REGEX } from '@inkeep/open-knowledge-core';

const registry = new Map<string, string>();

export function registerExternalSkill(name: string, absSkillDir: string): void {
  registry.set(name, absSkillDir);
}

export function unregisterExternalSkill(name: string): void {
  registry.delete(name);
}

export function externalSkillDir(name: string): string | null {
  return registry.get(name) ?? null;
}

export function externalSkillAbsPath(name: string, rel: string | null): string | null {
  const dir = registry.get(name);
  if (dir === undefined) return null;
  if (!SKILL_NAME_REGEX.test(name) || name.length > 64) {
    throw new Error(`externalSkillAbsPath: invalid skill name ${JSON.stringify(name)}`);
  }
  let abs: string;
  if (rel === null) {
    abs = resolve(dir, 'SKILL.md');
  } else {
    const segs = rel.split('/').filter((s) => s !== '' && s !== '.');
    if (segs.length === 0 || segs.some((s) => s === '..')) {
      throw new Error(`externalSkillAbsPath: invalid bundle path ${JSON.stringify(rel)}`);
    }
    abs = resolve(dir, ...segs);
  }
  if (!abs.startsWith(dir + sep)) {
    throw new Error(`externalSkillAbsPath: path escape for ${JSON.stringify(name)}`);
  }
  return abs;
}
