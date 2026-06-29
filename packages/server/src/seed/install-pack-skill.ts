import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  EDITOR_PROJECT_SKILL_ROOT,
  type EditorId,
  PROJECT_SKILL_EDITOR_IDS,
} from '@inkeep/open-knowledge-core';
import { resolveBundledSkillDir } from '../build-skill-zip.ts';
import { tracedCpSync, tracedMkdirSync, tracedRmSync } from '../fs-traced.ts';
import { recordSkillInstall } from '../installed-skills-marker.ts';
import { getLogger } from '../logger.ts';
import { BUNDLE_SKILL_NAME } from '../skill-bundles.ts';
import { projectSkill } from '../skill-projection.ts';

const PROJECT_SKILL_EDITOR_LABELS: Partial<Record<EditorId, string>> = {
  claude: 'Claude Code',
  cursor: 'Cursor',
  codex: 'Codex',
};

const PLATFORM_SKILL_NAME = BUNDLE_SKILL_NAME.project;

export function resolvePackSkillSource(packId: string): { name: string; sourceDir: string } | null {
  let sourceDir: string;
  try {
    sourceDir = resolveBundledSkillDir(`packs/${packId}`, { checkDesktop: true });
  } catch {
    return null;
  }
  return { name: `open-knowledge-pack-${packId}`, sourceDir };
}

export async function installPackSkill(projectDir: string, packId: string): Promise<string[]> {
  const resolved = resolvePackSkillSource(packId);
  if (!resolved) return [];
  const { name, sourceDir } = resolved;

  const okSkillDir = join(projectDir, '.ok', 'skills', name);
  if (!existsSync(join(okSkillDir, 'SKILL.md'))) {
    try {
      tracedRmSync(okSkillDir, { recursive: true, force: true });
      tracedMkdirSync(join(projectDir, '.ok', 'skills'), { recursive: true });
      tracedCpSync(sourceDir, okSkillDir, { recursive: true });
    } catch (err) {
      getLogger('seed').warn(
        { err, packId, okSkillDir },
        'pack skill source authoring failed — skill not installed',
      );
      return [];
    }
  }

  const setUpHosts = PROJECT_SKILL_EDITOR_IDS.filter((id) => {
    const rel = EDITOR_PROJECT_SKILL_ROOT[id];
    if (rel === null) return false;
    return existsSync(join(projectDir, rel, PLATFORM_SKILL_NAME, 'SKILL.md'));
  });
  const hosts = projectSkill(okSkillDir, name, projectDir, setUpHosts);
  const installed = hosts.map((id) => PROJECT_SKILL_EDITOR_LABELS[id] ?? id);

  if (hosts.length > 0) {
    try {
      await recordSkillInstall(projectDir, name, {
        hosts,
        scope: 'project',
        scripts: existsSync(join(okSkillDir, 'scripts')),
        installedAt: new Date().toISOString(),
      });
    } catch {}
  }

  return installed;
}
