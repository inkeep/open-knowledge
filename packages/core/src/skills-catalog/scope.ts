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
 *
 * Pure + browser-safe (no `node:*`) so both the client sidebar and the server
 * endpoint share one source of truth.
 */

import type { SkillScope } from '../schemas/api/tags-search.ts';
import type { SkillProvenance } from './schema.ts';

/** Claude's raw scope values that denote a project-bound (not user-global) install. */
const PROJECT_RAW_SCOPES = new Set(['project', 'local']);

/**
 * Map a harness's RAW scope string (Claude's `project`/`local`/`user`, or
 * absent for a bare skill-dir) onto OK's `project | global` enum. Project-bound
 * → `project`; everything else (user-global, or no recorded scope) → `global`.
 */
export function catalogRawScopeToOkScope(rawScope: string | undefined): SkillScope {
  return rawScope !== undefined && PROJECT_RAW_SCOPES.has(rawScope) ? 'project' : 'global';
}

/**
 * Trailing-slash-insensitive path equality. Both operands are already-absolute
 * directories (Claude records the launch cwd; OK's `projectDir` is resolved at
 * boot), so a string compare suffices.
 * ponytail: string compare, no `..`/symlink normalization — if a symlinked
 * project root ever needs to match its realpath, realpath both at the server
 * boundary before calling in.
 */
function samePath(a: string, b: string): boolean {
  const norm = (p: string) => p.replace(/\/+$/, '');
  return norm(a) === norm(b);
}

/**
 * Does this detected skill belong to the open project? User-global installs
 * (and bare skill-dirs with no recorded scope) always do — they apply to every
 * project. A *project-scoped* plugin install belongs only to the project it was
 * installed for: keep it iff its `projectPath` matches `projectDir`. A
 * project-scoped install with no recorded `projectPath` (or when the project
 * dir is unknown) can't be attributed, so it's kept rather than risk hiding a
 * genuine local skill.
 */
export function isDetectedSkillInProject(
  provenance: SkillProvenance,
  projectDir: string | undefined,
): boolean {
  if (catalogRawScopeToOkScope(provenance.scope) === 'global') return true;
  const owner = provenance.projectPath;
  if (owner === undefined || projectDir === undefined) return true;
  return samePath(owner, projectDir);
}
