/**
 * Re-projection orchestrator: bring every managed skill into line with a target
 * editor set. Shared by the change-targets action (`PUT /api/skill-targets`)
 * and reclaim — both need the same "project authored skills + OK's shipped
 * bundle to `targets`, reverse-project from dropped editors, keep the
 * marker's host set in sync" pass, so it lives in one place.
 */

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { type EditorId, PROJECT_SKILL_EDITOR_IDS } from '@inkeep/open-knowledge-core';
import { readInstalledSkills, recordSkillInstall } from './installed-skills-marker.ts';
import { getLogger } from './logger.ts';
import {
  projectBundleSkill,
  projectSkill,
  resolvedHosts,
  reverseBundleSkill,
  reverseProjectSkill,
  validateSkillForInstall,
} from './skill-projection.ts';

const logger = getLogger('skill-reproject');

/** Editor ids that have a project skill surface (valid projection targets).
 *  Reuses core's derived list so a new skill-surface editor is picked up here
 *  automatically (don't hand-maintain a parallel set). */
const SKILL_SURFACE_EDITORS: readonly EditorId[] = PROJECT_SKILL_EDITOR_IDS;

export interface ReprojectResult {
  /** Per authored skill: the editor ids it now lives in after re-projection. */
  reprojected: Array<{ name: string; hosts: string[] }>;
  /** Editor ids OK's shipped `open-knowledge` bundle now lives in. */
  bundleHosts: EditorId[];
}

/**
 * Re-project every authored skill in the marker AND OK's shipped bundle to
 * `targets`. Each skill is reverse-projected from the editors it's no longer
 * targeted at, then projected to `targets` (only if its source still exists +
 * validates — a source-gone skill drops to zero hosts rather than re-creating
 * a stale projection). The marker's per-skill host set is updated to match.
 *
 * Global-scope marker entries are skipped (the global store isn't wired).
 */
export async function reprojectAllManagedSkills(opts: {
  projectDir: string;
  /** Absolute `.ok/skills` dir for authored (project-scope) skill sources. */
  skillsRoot: string;
  targets: readonly EditorId[];
}): Promise<ReprojectResult> {
  const { projectDir, skillsRoot, targets } = opts;
  const newSet = new Set<string>(targets);
  const marker = readInstalledSkills(projectDir);
  const reprojected: Array<{ name: string; hosts: string[] }> = [];

  for (const [name, entry] of Object.entries(marker.skills)) {
    if (entry.scope !== 'project') continue;
    const recordedHosts = resolvedHosts(entry.hosts);
    try {
      const skillDir = resolve(skillsRoot, name);
      const sourceMissing = !existsSync(skillDir);
      const validity = sourceMissing ? null : validateSkillForInstall(skillDir, name);
      if (sourceMissing || !validity?.ok) {
        // Source present but INVALID (most often a native-authored SKILL.md
        // whose frontmatter.name ≠ the folder): surface
        // WHY rather than silently un-projecting it, so the user can fix the
        // skill instead of wondering where it went. Don't auto-rename — mutating
        // a user's SKILL.md is riskier than a loud warning.
        if (!sourceMissing && validity && !validity.ok) {
          logger.warn(
            { skill: name, errors: validity.errors },
            'managed skill failed validation — left un-projected; fix SKILL.md (e.g. frontmatter.name must equal the folder name)',
          );
        }
        // Source gone/invalid: reverse-project from EVERY recorded host, not
        // just the no-longer-targeted ones — otherwise the still-targeted
        // projections linger on disk while the marker claims zero hosts.
        reverseProjectSkill(name, projectDir, recordedHosts);
        await recordSkillInstall(projectDir, name, { ...entry, hosts: [] });
        reprojected.push({ name, hosts: [] });
        continue;
      }

      // Source present: drop the no-longer-targeted hosts, then project the
      // source into the new target set.
      const removed = recordedHosts.filter((h) => !newSet.has(h));
      if (removed.length > 0) reverseProjectSkill(name, projectDir, removed);
      const hosts = projectSkill(skillDir, name, projectDir, targets);
      await recordSkillInstall(projectDir, name, { ...entry, hosts });
      reprojected.push({ name, hosts });
    } catch (err) {
      // Per-skill isolation: one skill's projection failure must not abort
      // re-projection of the rest (the targets write already committed, so a
      // throw here would leave the remaining skills un-reprojected).
      logger.warn({ err, skill: name }, 'reproject skipped one skill after error');
    }
  }

  // OK's shipped bundle follows the same set: reverse from every skill-surface
  // editor no longer targeted, then project to the new set.
  const bundleRemoved = SKILL_SURFACE_EDITORS.filter((e) => !newSet.has(e));
  reverseBundleSkill(projectDir, bundleRemoved);
  const bundleHosts = projectBundleSkill(projectDir, targets);

  return { reprojected, bundleHosts };
}
