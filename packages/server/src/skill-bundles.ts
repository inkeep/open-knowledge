
export type BundleId = 'discovery' | 'project' | 'write-skill';

export const BUNDLE_SKILL_NAME: Record<BundleId, string> = {
  discovery: 'open-knowledge-discovery',
  project: 'open-knowledge',
  'write-skill': 'open-knowledge-write-skill',
};

export const BUNDLE_IDS = Object.keys(BUNDLE_SKILL_NAME) as BundleId[];

export const BUNDLE_SCOPE: Record<BundleId, 'user' | 'project'> = {
  discovery: 'user',
  project: 'project',
  'write-skill': 'user',
};

export const USER_GLOBAL_BUNDLE_IDS = BUNDLE_IDS.filter((id) => BUNDLE_SCOPE[id] === 'user');

export function bundleSkillMdPath(id: BundleId): string {
  return `packages/server/assets/skills/${id}/SKILL.md`;
}
