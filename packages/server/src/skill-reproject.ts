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
  reprojected: Array<{ name: string; hosts: string[] }>;
  bundleHosts: EditorId[];
}

export async function reprojectAllManagedSkills(opts: {
  projectDir: string;
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
        if (!sourceMissing && validity && !validity.ok) {
          logger.warn(
            { skill: name, errors: validity.errors },
            'managed skill failed validation — left un-projected; fix SKILL.md (e.g. frontmatter.name must equal the folder name)',
          );
        }
        reverseProjectSkill(name, projectDir, recordedHosts);
        await recordSkillInstall(projectDir, name, { ...entry, hosts: [] });
        reprojected.push({ name, hosts: [] });
        continue;
      }

      const removed = recordedHosts.filter((h) => !newSet.has(h));
      if (removed.length > 0) reverseProjectSkill(name, projectDir, removed);
      const hosts = projectSkill(skillDir, name, projectDir, targets);
      await recordSkillInstall(projectDir, name, { ...entry, hosts });
      reprojected.push({ name, hosts });
    } catch (err) {
      logger.warn({ err, skill: name }, 'reproject skipped one skill after error');
    }
  }

  const bundleRemoved = SKILL_SURFACE_EDITORS.filter((e) => !newSet.has(e));
  reverseBundleSkill(projectDir, bundleRemoved);
  const bundleHosts = projectBundleSkill(projectDir, targets);

  return { reprojected, bundleHosts };
}
