import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { LEGACY_SKILL_STORE_ROOT } from '@inkeep/open-knowledge-core';
import { parseSkillDir } from '@inkeep/open-knowledge-core/skills-catalog';
import { tracedCpSync, tracedRmSync } from './fs-traced.ts';
import { type InPlaceSkill, scanInPlaceSkills } from './in-place-skills.ts';
import {
  type FolderExpectation,
  mutateSkillPlacementsStore,
  readSkillPlacementsStore,
  resolveSkillPlacementPath,
  type SkillPlacement,
} from './skill-placements-store.ts';

export {
  type FolderExpectation,
  resolveSkillPlacementPath,
  type SkillPlacement,
} from './skill-placements-store.ts';

export function isRefusedOkPlacementRoot(rootRel: string): boolean {
  const underOk = rootRel === '.ok' || rootRel.startsWith('.ok/');
  return underOk && rootRel !== LEGACY_SKILL_STORE_ROOT;
}

export async function recordSkillSourceHost(
  projectDir: string,
  name: string,
  host: string,
): Promise<void> {
  await mutateSkillPlacementsStore(projectDir, (file) => {
    file.sources = { ...file.sources, [name]: host };
  });
}

export async function recordFolderExpectation(
  projectDir: string,
  root: string,
  expectation: FolderExpectation,
): Promise<void> {
  await mutateSkillPlacementsStore(projectDir, (file) => {
    file.folders = { ...file.folders, [root]: expectation };
  });
}

export function readFolderExpectations(projectDir: string): Record<string, FolderExpectation> {
  return readSkillPlacementsStore(projectDir).folders ?? {};
}

export async function recordKnownSkillRoot(projectDir: string, root: string): Promise<void> {
  await mutateSkillPlacementsStore(projectDir, (file) => {
    const roots = new Set(file.roots ?? []);
    if (roots.has(root)) return;
    roots.add(root);
    file.roots = [...roots].sort();
  });
}

export function readSkillInstallModeRaw(
  projectDir: string,
  name: string,
): 'copy' | 'link' | undefined {
  const pref = readSkillPlacementsStore(projectDir).preferences?.[name];
  return pref === 'link' || pref === 'copy' ? pref : undefined;
}

export function readSkillPlacements(projectDir: string): Record<string, SkillPlacement[]> {
  const out: Record<string, SkillPlacement[]> = {};
  for (const [name, list] of Object.entries(readSkillPlacementsStore(projectDir).skills)) {
    const live = list.filter((placement) => {
      const abs = resolveSkillPlacementPath(projectDir, placement.path);
      return abs !== null && existsSync(join(abs, 'SKILL.md'));
    });
    if (live.length > 0) out[name] = live;
  }
  return out;
}

export async function removeSkillPlacement(
  projectDir: string,
  name: string,
  path: string,
): Promise<void> {
  await mutateSkillPlacementsStore(projectDir, (file) => {
    const kept = (file.skills[name] ?? []).filter((p) => p.path !== path);
    file.skills = { ...file.skills };
    if (kept.length > 0) file.skills[name] = kept;
    else delete file.skills[name];
  });
}

export async function clearSkillPlacements(projectDir: string, name: string): Promise<void> {
  await mutateSkillPlacementsStore(projectDir, (file) => {
    if (file.skills[name] === undefined) return;
    file.skills = { ...file.skills };
    delete file.skills[name];
  });
}

export async function recordSkillPlacement(
  projectDir: string,
  name: string,
  placement: SkillPlacement,
): Promise<void> {
  await mutateSkillPlacementsStore(projectDir, (file) => {
    file.skills = { ...file.skills };
    const list = (file.skills[name] ?? []).filter((p) => p.path !== placement.path);
    list.push(placement);
    file.skills[name] = list;
  });
}

export async function resyncRecordedSkillCopies(
  projectDir: string,
  contentDir: string,
  skillsOverride?: InPlaceSkill[],
): Promise<number> {
  const placements = readSkillPlacements(projectDir);
  const skills = skillsOverride ?? scanInPlaceSkills(contentDir);
  for (const skill of skills) {
    const recorded = new Set((placements[skill.name] ?? []).map((p) => p.path));
    for (const dir of skill.copyDirs) {
      if (recorded.has(dir)) continue;
      if (resolveSkillPlacementPath(projectDir, dir) === null) continue;
      const placement: SkillPlacement = { path: dir, mode: 'copy', hash: skill.contentHash };
      await recordSkillPlacement(projectDir, skill.name, placement);
      placements[skill.name] = [...(placements[skill.name] ?? []), placement];
    }
  }
  if (Object.keys(placements).length === 0) return 0;
  let refreshed = 0;
  for (const skill of skills) {
    const list = placements[skill.name];
    if (!list) continue;
    const canonicalAbs = resolveSkillPlacementPath(contentDir, skill.dir);
    if (canonicalAbs === null) continue;
    for (const p of list) {
      if (p.mode !== 'copy' || p.hash === undefined) continue;
      let copyAbs = resolveSkillPlacementPath(projectDir, p.path);
      if (copyAbs === null) continue;
      if (copyAbs === canonicalAbs) continue;
      const current = parseSkillDir(copyAbs)?.contentHash;
      if (current === undefined) continue;
      if (current === skill.contentHash) {
        if (p.hash !== current) {
          await recordSkillPlacement(projectDir, skill.name, { ...p, hash: current });
        }
        continue;
      }
      if (current !== p.hash) continue;
      copyAbs = resolveSkillPlacementPath(projectDir, p.path);
      if (copyAbs === null) continue;
      tracedRmSync(copyAbs, { recursive: true, force: true });
      tracedCpSync(canonicalAbs, copyAbs, { recursive: true, dereference: true });
      await recordSkillPlacement(projectDir, skill.name, { ...p, hash: skill.contentHash });
      refreshed += 1;
    }
  }
  return refreshed;
}
