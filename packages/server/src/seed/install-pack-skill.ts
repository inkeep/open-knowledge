import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  EDITOR_PROJECT_SKILL_ROOT,
  type EditorId,
  isOpenKnowledgeSkillsSource,
  OPENKNOWLEDGE_SKILLS_REPO,
  PROJECT_SKILL_EDITOR_IDS,
  RENAMED_PACK_SKILLS,
} from '@inkeep/open-knowledge-core';
import {
  emptySkillsLock,
  parseSkillDir,
  parseSkillsLock,
  SKILLS_LOCK_REL,
  type SkillsLock,
  upsertLockEntry,
} from '@inkeep/open-knowledge-core/skills-catalog';
import { copyDirSync } from '../copy-dir.ts';
import { tracedMkdirSync, tracedRmSync, tracedWriteFileSync } from '../fs-traced.ts';
import { resolveDefaultSkillHomeRel, scanInPlaceSkills } from '../in-place-skills.ts';
import { getLogger } from '../logger.ts';
import { BUNDLE_SKILL_NAME } from '../skill-bundles.ts';
import { resolveSkillInstallReportSettings } from '../skill-install-report-config.ts';
import { listPackSkillSources, type PackSkillSource } from '../skill-pack-sources.ts';
import { hostSkillsRootEscapes, projectInPlaceSkill } from '../skill-projection.ts';
import { readSkillsLockFile } from '../skills-lock-store.ts';
import { reportSkillInstall } from '../skills-sh-install-report.ts';
import type { PackSkillConflict } from './types.ts';

const PROJECT_SKILL_EDITOR_LABELS: Partial<Record<EditorId, string>> = {
  claude: 'Claude Code',
  cursor: 'Cursor',
  codex: 'Codex',
};

const PLATFORM_SKILL_NAME = BUNDLE_SKILL_NAME.project;

export function resolvePackSkillSources(packId: string): PackSkillSource[] {
  return listPackSkillSources(packId, { checkDesktop: false });
}

function recordPackSkillProvenance(projectDir: string, name: string, skillDir: string): void {
  try {
    const acquired = parseSkillDir(skillDir);
    if (!acquired) return;
    const lockPath = join(projectDir, ...SKILLS_LOCK_REL);
    const lock = existsSync(lockPath)
      ? (parseSkillsLock(readFileSync(lockPath, 'utf-8')) ?? emptySkillsLock())
      : emptySkillsLock();
    if (lock.skills[name]) return;
    tracedMkdirSync(dirname(lockPath), { recursive: true });
    const updated = upsertLockEntry(lock, name, {
      source: OPENKNOWLEDGE_SKILLS_REPO,
      skill: name,
      contentHash: acquired.contentHash,
      importedAt: new Date().toISOString(),
    });
    tracedWriteFileSync(lockPath, `${JSON.stringify(updated, null, 2)}\n`, 'utf-8');
  } catch (err) {
    getLogger('seed').warn({ err, name }, 'pack skill provenance not recorded');
  }
}

export const OLD_PACK_SKILL_NAME: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(RENAMED_PACK_SKILLS).map(([oldName, newName]) => [newName, oldName]),
);

export interface PackSkillInstallResult {
  editors: string[];
  conflicts: PackSkillConflict[];
}

export function classifyPresentPackSkill(
  packId: string,
  name: string,
  presentDir: string | null,
  lock: SkillsLock,
): 'ours' | 'ours-retrofit' | 'foreign' {
  const entry = lock.skills[name];
  if (entry) return isOpenKnowledgeSkillsSource(entry.source) ? 'ours' : 'foreign';
  if (presentDir) {
    try {
      const md = readFileSync(join(presentDir, 'SKILL.md'), 'utf-8');
      if (packIdFromSkillMd(md) === packId) return 'ours-retrofit';
    } catch {}
  }
  return 'foreign';
}

function packIdFromSkillMd(md: string): string | null {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/.exec(md)?.[1];
  if (frontmatter === undefined) return null;
  return /^[ \t]+pack:[ \t]*"?([a-z0-9-]+)"?[ \t]*$/m.exec(frontmatter)?.[1] ?? null;
}

export type PackSkillHomeRefusal = 'no-agent-folder' | 'home-escapes-project';

export function resolvePackSkillHome(
  projectDir: string,
): { homeRel: string } | { refusal: PackSkillHomeRefusal } {
  const homeRel = resolveDefaultSkillHomeRel(projectDir, 'project');
  if (homeRel === null) return { refusal: 'no-agent-folder' };
  if (hostSkillsRootEscapes(projectDir, join(projectDir, homeRel))) {
    return { refusal: 'home-escapes-project' };
  }
  return { homeRel };
}

export async function installPackSkill(
  projectDir: string,
  packId: string,
): Promise<PackSkillInstallResult> {
  const sources = resolvePackSkillSources(packId);
  if (sources.length === 0) return { editors: [], conflicts: [] };

  const setUpHosts = PROJECT_SKILL_EDITOR_IDS.filter((id) => {
    const rel = EDITOR_PROJECT_SKILL_ROOT[id];
    if (rel === null) return false;
    return existsSync(join(projectDir, rel, PLATFORM_SKILL_NAME, 'SKILL.md'));
  });

  const reportSettings = resolveSkillInstallReportSettings();
  const installed = new Set<string>();

  const scan = scanInPlaceSkills(projectDir);
  const existingNames = new Set(scan.map((sk) => sk.name));
  const legacyNamed = new Map(
    sources
      .map(({ name }) => [name, OLD_PACK_SKILL_NAME[name]] as const)
      .filter(
        ([, oldName]) =>
          oldName !== undefined &&
          (existingNames.has(oldName) ||
            existsSync(join(projectDir, '.ok', 'skills', oldName, 'SKILL.md'))),
      ) as Iterable<readonly [string, string]>,
  );
  const scanDirByName = new Map(scan.map((sk) => [sk.name, join(projectDir, sk.dir)]));
  const lock = readSkillsLockFile(join(projectDir, ...SKILLS_LOCK_REL));
  const conflicts: PackSkillConflict[] = [];
  const home = resolvePackSkillHome(projectDir);
  if ('refusal' in home) {
    if (home.refusal === 'home-escapes-project') {
      getLogger('seed').warn(
        { packId },
        'default skill home escapes the project (symlinked out) — pack skills not installed',
      );
    } else {
      getLogger('seed').info(
        { packId },
        'no existing agent host is available — pack skills not installed',
      );
    }
    return { editors: [], conflicts: [] };
  }
  const homeRel = home.homeRel;
  const homeHost = (Object.entries(EDITOR_PROJECT_SKILL_ROOT) as [EditorId, string | null][]).find(
    ([, root]) => root === homeRel,
  )?.[0];
  for (const { name: shippedName, sourceDir, excludePaths } of sources) {
    const name = legacyNamed.get(shippedName) ?? shippedName;
    const skillDir = join(projectDir, homeRel, name);
    const legacyStoreDir = join(projectDir, '.ok', 'skills', name);
    const alreadyPresent =
      existingNames.has(name) ||
      existsSync(join(skillDir, 'SKILL.md')) ||
      existsSync(join(legacyStoreDir, 'SKILL.md'));
    const sourceHome = existsSync(join(legacyStoreDir, 'SKILL.md')) ? legacyStoreDir : skillDir;
    if (alreadyPresent) {
      const presentDir =
        scanDirByName.get(name) ??
        (existsSync(join(skillDir, 'SKILL.md'))
          ? skillDir
          : existsSync(join(legacyStoreDir, 'SKILL.md'))
            ? legacyStoreDir
            : null);
      const classification = classifyPresentPackSkill(packId, name, presentDir, lock);
      if (classification === 'foreign') {
        conflicts.push({ name });
        continue;
      }
      if (classification === 'ours-retrofit' && presentDir) {
        recordPackSkillProvenance(projectDir, name, presentDir);
      }
    }
    if (!alreadyPresent) {
      try {
        tracedRmSync(skillDir, { recursive: true, force: true });
        tracedMkdirSync(join(projectDir, homeRel), { recursive: true });
        copyDirSync(sourceDir, skillDir, {
          filter: (src) => !excludePaths.some((p) => src === join(sourceDir, p)),
        });
      } catch (err) {
        try {
          tracedRmSync(skillDir, { recursive: true, force: true });
        } catch {}
        getLogger('seed').warn(
          { err, packId, skillDir },
          'pack skill source authoring failed — skill not installed',
        );
        continue;
      }

      recordPackSkillProvenance(projectDir, name, skillDir);
      void reportSkillInstall(
        { source: OPENKNOWLEDGE_SKILLS_REPO, skills: [name], scope: projectDir },
        { home: reportSettings.home, enabled: reportSettings.enabled },
      );
    }

    const canonicalAbs = existsSync(join(sourceHome, 'SKILL.md')) ? sourceHome : skillDir;
    const canonicalHash = parseSkillDir(canonicalAbs)?.contentHash;
    if (canonicalHash === undefined) continue;
    const fanned = projectInPlaceSkill({
      canonicalAbs,
      canonicalHash,
      canonicalRootRel: homeRel,
      name,
      cwd: projectDir,
      targets: setUpHosts,
      mode: 'copy',
    });
    for (const id of fanned.hosts) {
      installed.add(PROJECT_SKILL_EDITOR_LABELS[id as EditorId] ?? id);
    }
    if (fanned.conflicted.length > 0) {
      conflicts.push({
        name,
        hosts: fanned.conflicted.map((id) => PROJECT_SKILL_EDITOR_LABELS[id as EditorId] ?? id),
      });
    }
    if (homeHost !== undefined && setUpHosts.includes(homeHost)) {
      installed.add(PROJECT_SKILL_EDITOR_LABELS[homeHost] ?? homeHost);
    }
  }

  return { editors: [...installed], conflicts };
}

interface PackSkillOnDemandResult {
  installedHosts: string[];
  skills: Array<{ name: string; created: boolean }>;
}

export async function installPackSkillOnDemand(
  projectDir: string,
  packId: string,
): Promise<PackSkillOnDemandResult> {
  const sources = resolvePackSkillSources(packId);
  const before = new Set(scanInPlaceSkills(projectDir).map((skill) => skill.name));
  const installResult = await installPackSkill(projectDir, packId);
  const after = new Set(scanInPlaceSkills(projectDir).map((skill) => skill.name));

  const missing = sources.find(({ name }) => !after.has(name));
  if (missing) {
    throw new Error(`Pack skill "${missing.name}" could not be authored.`);
  }

  return {
    installedHosts: installResult.editors,
    skills: sources.map(({ name }) => ({ name, created: !before.has(name) })),
  };
}
