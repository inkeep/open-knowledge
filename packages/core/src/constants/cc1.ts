export const SYSTEM_DOC_NAME = '__system__';
export const CC1_CONTRACT_VERSION = 1;

export const CONFIG_DOC_NAME_PROJECT = '__config__/project';

export const CONFIG_DOC_NAME_USER = '__user__/config.yml';

export const CONFIG_DOC_NAME_PROJECT_LOCAL = '__local__/project';

export const CONFIG_DOC_NAME_OKIGNORE = '__config__/okignore';

export const CONFIG_DOC_NAMES = Object.freeze([
  CONFIG_DOC_NAME_PROJECT,
  CONFIG_DOC_NAME_PROJECT_LOCAL,
  CONFIG_DOC_NAME_USER,
  CONFIG_DOC_NAME_OKIGNORE,
] as const);
export type ConfigDocName = (typeof CONFIG_DOC_NAMES)[number];

export const MANAGED_ARTIFACT_PREFIX_SKILL = '__skill__/';
export const MANAGED_ARTIFACT_PREFIX_TEMPLATE = '__template__/';

export const MANAGED_ARTIFACT_PREFIX_EXTSKILL = '__extskill__/';

export const MANAGED_ARTIFACT_SCOPES = ['project', 'global'] as const;
export type ManagedArtifactScope = (typeof MANAGED_ARTIFACT_SCOPES)[number];

export function isManagedArtifactDocName(name: string): boolean {
  return (
    name.startsWith(MANAGED_ARTIFACT_PREFIX_SKILL) ||
    name.startsWith(MANAGED_ARTIFACT_PREFIX_TEMPLATE) ||
    name.startsWith(MANAGED_ARTIFACT_PREFIX_EXTSKILL)
  );
}

export function externalSkillLiveDocName(name: string): string {
  return `${MANAGED_ARTIFACT_PREFIX_EXTSKILL}${name}`;
}

export function externalSkillFileLiveDocName(name: string, rel: string): string {
  const relNoExt = stripMdExt(rel);
  return `${MANAGED_ARTIFACT_PREFIX_EXTSKILL}${name}/${relNoExt}`;
}

export function isExternalSkillDocName(name: string): boolean {
  return name.startsWith(MANAGED_ARTIFACT_PREFIX_EXTSKILL);
}

export function parseExternalSkillDocName(
  name: string,
): { name: string; rel: string | null } | null {
  if (!name.startsWith(MANAGED_ARTIFACT_PREFIX_EXTSKILL)) return null;
  const rest = name.slice(MANAGED_ARTIFACT_PREFIX_EXTSKILL.length);
  const slash = rest.indexOf('/');
  const skillName = slash < 0 ? rest : rest.slice(0, slash);
  const rel = slash < 0 ? null : rest.slice(slash + 1);
  if (!/^[a-z0-9-]+$/.test(skillName)) return null;
  return { name: skillName, rel: rel && rel.length > 0 ? rel : null };
}

export function stripMdExt(path: string): string {
  return path.replace(/\.mdx?$/i, '');
}

export const LEGACY_SKILL_STORE_ROOT = '.ok/skills';

export function projectSkillContentDocName(name: string): string {
  return `${LEGACY_SKILL_STORE_ROOT}/${name}/SKILL`;
}

const SKILL_BUNDLE_SUBDIRS = ['references', 'scripts'] as const;

export function resolveSkillSlashTarget(target: string, sourceDocName: string): string | null {
  const trimmed = target.trim();
  if (!trimmed.startsWith('/')) return null;
  const name = trimmed.slice(1);
  if (name === '' || name.includes('/')) return null;

  const projectRoot = /^(\.[A-Za-z0-9_-]+\/skills)\/[^/]+\/(?:SKILL|references\/.+)$/.exec(
    sourceDocName,
  );
  if (projectRoot) return `${projectRoot[1] as string}/${name}/SKILL`;

  const globalSkill = /^__skill__\/(global)\/[^/]+(?:\/references\/.+)?$/.exec(sourceDocName);
  if (globalSkill) return skillLiveDocName('global', name);

  return null;
}

export function resolveSkillBundleWikiTarget(target: string, sourceDocName: string): string | null {
  const skillDirMatch =
    /^(\.[A-Za-z0-9_-]+\/skills\/[^/]+)\/(?:SKILL|references\/.+)$/.exec(sourceDocName) ??
    /^(__skill__\/global\/[^/]+)(?:\/references\/.+)?$/.exec(sourceDocName) ??
    /^(__extskill__\/[^/]+)(?:\/.+)?$/.exec(sourceDocName);
  if (!skillDirMatch) return null;
  const skillDir = skillDirMatch[1] as string;

  const trimmed = target.trim();
  const withoutExt = stripMdExt(trimmed);
  const segments = withoutExt.split('/').filter((s) => s !== '' && s !== '.');
  const [first] = segments;
  if (!first || !(SKILL_BUNDLE_SUBDIRS as readonly string[]).includes(first)) return null;
  if (segments.includes('..')) return null;
  if (segments.length < 2) return null;
  return `${skillDir}/${segments.join('/')}`;
}

export type ParsedProjectSkillBundleDoc =
  | { name: string; kind: 'skill'; rel: null }
  | { name: string; kind: 'reference'; rel: string };

const PROJECT_SKILL_BUNDLE_DOC_RE = /^\.[A-Za-z0-9_-]+\/skills\/([^/]+)\/(SKILL|references\/.+)$/;

export function parseProjectSkillBundleDoc(docName: string): ParsedProjectSkillBundleDoc | null {
  const match = PROJECT_SKILL_BUNDLE_DOC_RE.exec(docName);
  if (!match) return null;
  const name = match[1] as string;
  const tail = match[2] as string;
  if (tail === 'SKILL') return { name, kind: 'skill', rel: null };
  return { name, kind: 'reference', rel: tail.slice('references/'.length) };
}

export type ParsedGlobalSkillBundleDoc =
  | { name: string; kind: 'skill'; rel: null; host: string | null }
  | { name: string; kind: 'reference'; rel: string; host: string | null };

const GLOBAL_SKILL_BUNDLE_DOC_RE = /^__skill__\/global\/([^/]+)(?:\/(references\/.+))?$/;

export function parseGlobalSkillBundleDoc(docName: string): ParsedGlobalSkillBundleDoc | null {
  const match = GLOBAL_SKILL_BUNDLE_DOC_RE.exec(docName);
  if (!match) return null;
  const { name, host } = splitSkillHostQualifier(match[1] as string);
  const tail = match[2];
  if (tail === undefined) return { name, kind: 'skill', rel: null, host };
  return { name, kind: 'reference', rel: tail.slice('references/'.length), host };
}

export function skillLiveDocName(scope: ManagedArtifactScope, name: string, host?: string): string {
  return scope === 'project'
    ? projectSkillContentDocName(name)
    : `${MANAGED_ARTIFACT_PREFIX_SKILL}${scope}/${name}${host ? `@${host}` : ''}`;
}

export function splitSkillHostQualifier(segment: string): { name: string; host: string | null } {
  const at = segment.indexOf('@');
  if (at < 0) return { name: segment, host: null };
  const host = segment.slice(at + 1);
  return { name: segment.slice(0, at), host: host === '' ? null : host };
}

export function skillFileLiveDocName(
  scope: ManagedArtifactScope,
  name: string,
  rel: string,
  host?: string,
): string {
  const relNoExt = stripMdExt(rel);
  return scope === 'project'
    ? `${LEGACY_SKILL_STORE_ROOT}/${name}/${relNoExt}`
    : `${MANAGED_ARTIFACT_PREFIX_SKILL}${scope}/${name}${host ? `@${host}` : ''}/${relNoExt}`;
}

export type ParsedManagedArtifactName = {
  kind: 'skill';
  scope: ManagedArtifactScope;
  name: string;
  host: string | null;
  rel: string | null;
};

function decodeManagedSegments(encoded: string): string {
  if (encoded === '') return '';
  try {
    return encoded
      .split('/')
      .map((s) => decodeURIComponent(s))
      .join('/');
  } catch {
    return encoded;
  }
}

export function parseManagedArtifactName(name: string): ParsedManagedArtifactName | null {
  if (name.startsWith(MANAGED_ARTIFACT_PREFIX_SKILL)) {
    const rest = name.slice(MANAGED_ARTIFACT_PREFIX_SKILL.length);
    const slash = rest.indexOf('/');
    if (slash < 0) return null;
    const scope = rest.slice(0, slash);
    if (scope !== 'global' && scope !== 'project') return null;
    const encoded = rest.slice(slash + 1);
    if (!encoded) return null;
    const decoded = decodeManagedSegments(encoded);
    const nameEnd = decoded.indexOf('/');
    const segment = nameEnd < 0 ? decoded : decoded.slice(0, nameEnd);
    if (!segment) return null;
    const rel = nameEnd < 0 ? null : decoded.slice(nameEnd + 1);
    const { name: skillName, host } = splitSkillHostQualifier(segment);
    if (!skillName) return null;
    return { kind: 'skill', scope, name: skillName, host, rel };
  }
  return null;
}

const TEMPLATE_FILE_TARGET_RE = /^(?:(.+)\/)?\.ok\/templates\/([^/]+?)(?:\.md)?$/;

export type ParsedTemplateName = { folder: string; name: string };

export function templateContentDocName(folderRel: string, name: string): string {
  const folder = folderRel.replace(/^\/+|\/+$/g, '');
  return folder ? `${folder}/.ok/templates/${name}` : `.ok/templates/${name}`;
}

export function parseTemplateContentDocName(docName: string): ParsedTemplateName | null {
  const match = TEMPLATE_FILE_TARGET_RE.exec(docName);
  if (!match) return null;
  return { folder: (match[1] ?? '').replace(/^\/+|\/+$/g, ''), name: match[2] as string };
}

export function parseLegacyTemplateDocName(name: string): ParsedTemplateName | null {
  if (!name.startsWith(MANAGED_ARTIFACT_PREFIX_TEMPLATE)) return null;
  const rest = name.slice(MANAGED_ARTIFACT_PREFIX_TEMPLATE.length);
  if (!rest) return null;
  const lastSlash = rest.lastIndexOf('/');
  const encodedName = lastSlash < 0 ? rest : rest.slice(lastSlash + 1);
  if (!encodedName) return null;
  const encodedFolder = lastSlash < 0 ? '' : rest.slice(0, lastSlash);
  return {
    folder: decodeManagedSegments(encodedFolder),
    name: decodeManagedSegments(encodedName),
  };
}
