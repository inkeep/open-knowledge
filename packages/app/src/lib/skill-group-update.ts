import type { SkillsListEntry } from '@inkeep/open-knowledge-core';
import type { ProvenanceBucket } from '@/lib/skill-provenance-bucket';

export function groupUpdatableSkills(input: {
  groupPrefix: string;
  bucket: ProvenanceBucket | undefined;
  skillByPrefix: ReadonlyMap<string, SkillsListEntry>;
}): SkillsListEntry[] {
  const { groupPrefix, bucket, skillByPrefix } = input;
  const packChild = bucket?.kind === 'plugin' && bucket.parent !== undefined && bucket.url !== null;
  if (!bucket || (bucket.kind === 'plugin' && !packChild)) return [];
  const prefix = `${groupPrefix}/`;
  const members: SkillsListEntry[] = [];
  for (const [rowPrefix, skill] of skillByPrefix) {
    if (!rowPrefix.startsWith(prefix)) continue;
    const source = skill.origin?.source;
    if (!source || source.startsWith('adopt:')) continue;
    members.push(skill);
  }
  return members;
}

export function groupDeletableSkills(input: {
  groupPrefix: string;
  bucket: ProvenanceBucket | undefined;
  skillByPrefix: ReadonlyMap<string, SkillsListEntry>;
}): SkillsListEntry[] {
  const { groupPrefix, bucket, skillByPrefix } = input;
  const packChild = bucket?.kind === 'plugin' && bucket.parent !== undefined && bucket.url !== null;
  if (!bucket || (bucket.kind === 'plugin' && !packChild)) return [];
  const prefix = `${groupPrefix}/`;
  const members: SkillsListEntry[] = [];
  for (const [rowPrefix, skill] of skillByPrefix) {
    if (!rowPrefix.startsWith(prefix)) continue;
    if (skill.managed) continue;
    members.push(skill);
  }
  return members;
}
