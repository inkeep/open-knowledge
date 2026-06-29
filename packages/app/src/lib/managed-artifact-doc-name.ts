
import {
  MANAGED_ARTIFACT_PREFIX_TEMPLATE,
  projectSkillContentDocName,
  SKILL_CONTENT_ROOT,
  skillLiveDocName,
} from '@inkeep/open-knowledge-core';

export { projectSkillContentDocName, skillLiveDocName };


export function templateDocName(folder: string, name: string): string {
  const trimmed = folder.replace(/^\/+|\/+$/g, '');
  return `${MANAGED_ARTIFACT_PREFIX_TEMPLATE}${trimmed ? `${trimmed}/` : ''}${name}`;
}

/** A path inside a PROJECT skill's source dir (`.ok/skills/<name>/<relPath>`) — a
 *  nested content doc or asset. */
export function projectSkillFilePath(name: string, relPath: string): string {
  return `${SKILL_CONTENT_ROOT}/${name}/${relPath}`;
}

export function parseProjectSkillContentDocName(docName: string): string | null {
  const prefix = `${SKILL_CONTENT_ROOT}/`;
  const suffix = '/SKILL';
  if (!docName.startsWith(prefix) || !docName.endsWith(suffix)) return null;
  const name = docName.slice(prefix.length, docName.length - suffix.length);
  return name && !name.includes('/') ? name : null;
}
