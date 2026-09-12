/**
 * Detected-skill scope resolution — the project-locality boundary for the cross-harness catalog
 * (precedent #50).
 */

import type { SkillScope } from '../schemas/api/tags-search.ts';
import type { SkillProvenance } from './schema.ts';

const PROJECT_RAW_SCOPES = new Set(['project', 'local']);

export function catalogRawScopeToOkScope(rawScope: string | undefined): SkillScope {
  return rawScope !== undefined && PROJECT_RAW_SCOPES.has(rawScope) ? 'project' : 'global';
}

function samePath(a: string, b: string): boolean {
  const norm = (p: string) => p.replace(/\/+$/, '');
  return norm(a) === norm(b);
}

export function isDetectedSkillInProject(
  provenance: SkillProvenance,
  projectDir: string | undefined,
): boolean {
  if (catalogRawScopeToOkScope(provenance.scope) === 'global') return true;
  const owner = provenance.projectPath;
  if (owner === undefined || projectDir === undefined) return true;
  return samePath(owner, projectDir);
}

export function isSkillOutsideOpenProject(
  provenance: SkillProvenance,
  home: string,
  contentDir: string | undefined,
): boolean {
  if (contentDir === undefined) return false;
  if (catalogRawScopeToOkScope(provenance.scope) !== 'project') return false;
  const h = home.replace(/\/+$/, '');
  const c = contentDir.replace(/\/+$/, '');
  return h !== c && !h.startsWith(`${c}/`);
}
