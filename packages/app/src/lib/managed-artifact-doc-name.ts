import {
  parseProjectSkillBundleDoc,
  type SkillsListEntry,
  skillFileLiveDocName,
  skillLiveDocName,
  stripMdExt,
} from '@inkeep/open-knowledge-core';

export { skillLiveDocName };

export function skillEntryLiveDocName(
  skill: Pick<SkillsListEntry, 'scope' | 'name' | 'path' | 'canonicalPath' | 'hostQualifier'>,
): string {
  return skill.scope === 'project'
    ? stripMdExt(skillEntryDocPath(skill))
    : skillLiveDocName(skill.scope, skill.name, skill.hostQualifier);
}

function skillEntryDocPath(skill: Pick<SkillsListEntry, 'path' | 'canonicalPath'>): string {
  return skill.canonicalPath ?? skill.path;
}

export function skillEntryFileLiveDocName(
  skill: Pick<SkillsListEntry, 'scope' | 'name' | 'path' | 'canonicalPath' | 'hostQualifier'>,
  rel: string,
): string {
  if (skill.scope !== 'project')
    return skillFileLiveDocName(skill.scope, skill.name, rel, skill.hostQualifier);
  const dir = skillEntryDocPath(skill).replace(/\/SKILL\.mdx?$/i, '');
  return `${dir}/${stripMdExt(rel)}`;
}

export function parseProjectSkillContentDocName(docName: string): string | null {
  const parsed = parseProjectSkillBundleDoc(docName);
  return parsed?.kind === 'skill' ? parsed.name : null;
}
