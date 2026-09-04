/**
 * Detected-skill scope resolution — the project-locality boundary for the
 * cross-harness catalog (precedent #50).
 *
 * `enumerateInstalledSkills` is machine-global: it lists every skill installed
 * in every harness home, including Claude plugins installed *project-scoped for
 * a different project*. Surfacing those under the current project's PROJECT
 * header is a project-locality violation — a resource bound to project A must
 * not appear as project B's. These two pure helpers draw that boundary:
 *
 *  - `catalogRawScopeToOkScope` maps a harness's raw scope string onto OK's
 *    `project | global` enum (the client-side bucket for a detected row).
 *  - `isDetectedSkillInProject` decides whether a detected skill belongs to the
 *    open project at all — the server drops the ones that don't before the
 *    client ever buckets them.
 *  - `isSkillOutsideOpenProject` decides whether a skill that DOES belong is
 *    nonetheless stored outside the open tree, where editing it in place would
 *    write to a different checkout.
 *
 * Pure + browser-safe (no `node:*`) so both the client sidebar and the server
 * endpoint share one source of truth.
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
