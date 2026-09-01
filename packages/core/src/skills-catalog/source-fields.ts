const GITHUB_SOURCE = /^([\w.-]+)\/([\w.-]+)$/;
const SITE_SOURCE =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;

export type SkillsShCatalogSource =
  | { kind: 'github'; owner: string; repo: string }
  | { kind: 'site'; hostname: string };

export interface SkillsShSkillLinks {
  sourceKind: SkillsShCatalogSource['kind'];
  skillsUrl: string;
  sourceUrl: string;
}

export function parseSkillsShCatalogSource(source: string): SkillsShCatalogSource | null {
  const github = GITHUB_SOURCE.exec(source);
  if (github) {
    const [, owner, repo] = github;
    if (owner && repo) return { kind: 'github', owner, repo };
  }
  if (SITE_SOURCE.test(source)) return { kind: 'site', hostname: source };
  return null;
}

export function skillsShSkillLinks(source: string, skillId: string): SkillsShSkillLinks | null {
  const parsed = parseSkillsShCatalogSource(source);
  const skill = skillId.trim();
  if (!parsed || !skill) return null;

  const encodedSkill = encodeURIComponent(skill);
  if (parsed.kind === 'github') {
    const owner = encodeURIComponent(parsed.owner);
    const repo = encodeURIComponent(parsed.repo);
    return {
      sourceKind: 'github',
      skillsUrl: `https://www.skills.sh/${owner}/${repo}/${encodedSkill}`,
      sourceUrl: `https://github.com/${owner}/${repo}`,
    };
  }

  const hostname = encodeURIComponent(parsed.hostname);
  return {
    sourceKind: 'site',
    skillsUrl: `https://www.skills.sh/site/${hostname}/${encodedSkill}`,
    sourceUrl: `https://${parsed.hostname}`,
  };
}

export function ownerOf(source: string): string | null {
  return source.includes('/') ? (source.split('/')[0] ?? null) : null;
}

export function slug(id: string): string {
  const last = id.split('/').pop();
  return last && last.length > 0 ? last : id;
}
