export const AGENTS_SKILLS_ROOT = '.agents/skills';

export const PACK_SKILL_PREFIX = 'open-knowledge-pack-';

export function isOpenKnowledgeSkillsSource(source: string): boolean {
  const raw = source.trim();
  if (raw === OPENKNOWLEDGE_SKILLS_REPO) return true;

  if (!raw.includes('://') && !raw.includes('@')) return false;

  if (raw.includes('://')) {
    try {
      const url = new URL(raw);
      return TRUSTED_SKILL_HOSTS.has(url.hostname.toLowerCase()) && pathIsOurRepo(url.pathname);
    } catch {
      return false;
    }
  }
  const scp = /^(?:[\w.-]+@)?([\w.-]+):(.+)$/.exec(raw);
  if (scp) return TRUSTED_SKILL_HOSTS.has(scp[1].toLowerCase()) && pathIsOurRepo(scp[2]);
  return false;
}

const TRUSTED_SKILL_HOSTS: ReadonlySet<string> = new Set([
  'skills.sh',
  'www.skills.sh',
  'github.com',
  'www.github.com',
  'raw.githubusercontent.com',
]);

function pathIsOurRepo(pathname: string): boolean {
  const trimmed = pathname.replace(/^\/+/, '').replace(/\.git$/, '');
  return (
    trimmed === OPENKNOWLEDGE_SKILLS_REPO || trimmed.startsWith(`${OPENKNOWLEDGE_SKILLS_REPO}/`)
  );
}

export function projectSkillDecisionKey(projectDir: string): string {
  return `project-skill:${projectDir}`;
}

export const RENAMED_PACK_SKILLS: Readonly<Record<string, string>> = {
  'open-knowledge-pack-plain-notes': 'note-taking',
  'open-knowledge-pack-worldbuilding': 'worldbuilding',
  'open-knowledge-pack-writing-pipeline': 'writing-workflow',
  'open-knowledge-pack-codebase-wiki': 'codebase-wiki',
  'open-knowledge-pack-knowledge-base': 'knowledge-base',
  'open-knowledge-pack-software-lifecycle': 'software-lifecycle',
  'open-knowledge-pack-entity-vault': 'personal-crm',
  'open-knowledge-pack-okf': 'okf-knowledge-base',
  'open-knowledge-pack-software-lifecycle-frame-a-proposal': 'frame-a-proposal',
  'open-knowledge-pack-software-lifecycle-record-a-decision': 'record-a-decision',
  'open-knowledge-pack-software-lifecycle-write-a-spec': 'write-a-spec',
  'open-knowledge-pack-software-lifecycle-review-a-design': 'review-a-design',
  'open-knowledge-pack-software-lifecycle-write-a-postmortem': 'write-a-postmortem',
  'open-knowledge-pack-knowledge-base-research': 'research-with-sources',
  'open-knowledge-pack-knowledge-base-consolidate': 'consolidate-notes',
};

export const OPENKNOWLEDGE_SKILLS_REPO = 'inkeep/open-knowledge-skills';

export function isRetiredPackListing(name: string, source: string): boolean {
  return name.startsWith(PACK_SKILL_PREFIX) && isOpenKnowledgeSkillsSource(source);
}

export const SKILL_REF_RE = /(^|[\s([])\/([a-z0-9][a-z0-9-]{1,63})(?=$|[\s.,;:!?)\]])/g;

const SKILL_REF_STOPLIST = new Set([
  'tmp',
  'usr',
  'etc',
  'var',
  'dev',
  'opt',
  'bin',
  'api',
  'home',
  'root',
]);

export function isSkillRefCandidate(slug: string): boolean {
  return !SKILL_REF_STOPLIST.has(slug);
}

const SKILL_REF_CODE_RE = /`\/([a-z0-9][a-z0-9-]{1,63})`/g;

export function extractSkillRefs(body: string): string[] {
  const out = new Set<string>();
  SKILL_REF_RE.lastIndex = 0;
  for (let m = SKILL_REF_RE.exec(body); m !== null; m = SKILL_REF_RE.exec(body)) {
    const slug = m[2] as string;
    if (isSkillRefCandidate(slug)) out.add(slug);
  }
  SKILL_REF_CODE_RE.lastIndex = 0;
  for (let m = SKILL_REF_CODE_RE.exec(body); m !== null; m = SKILL_REF_CODE_RE.exec(body)) {
    const slug = m[1] as string;
    if (isSkillRefCandidate(slug)) out.add(slug);
  }
  return [...out];
}

export function rewriteSkillRefs(body: string, from: string, to: string): string {
  if (from === to || !isSkillRefCandidate(from) || !body.includes(`/${from}`)) return body;
  SKILL_REF_RE.lastIndex = 0;
  const prose = body.replace(SKILL_REF_RE, (match, lead: string, slug: string) =>
    slug === from ? `${lead}/${to}` : match,
  );
  SKILL_REF_CODE_RE.lastIndex = 0;
  return prose.replace(SKILL_REF_CODE_RE, (match, slug: string) =>
    slug === from ? `\`/${to}\`` : match,
  );
}
