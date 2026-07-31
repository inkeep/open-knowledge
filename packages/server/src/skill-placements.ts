/**
 * Machine-local record of CUSTOM skill placements — copies/symlinks the user
 * placed at arbitrary project-relative dirs via the install menu's custom-path
 * action. Lives in `.ok/local/` (per-machine runtime state, gitignored — the
 * spec's copy-tracking registry split: canonical bindings are derivable, copy
 * paths are machine-local and never committed).
 *
 * Read is pruning: entries whose path no longer exists on disk drop out, so
 * the disclosure surfaces never list a deleted placement. Fail-soft
 * throughout — a corrupt file reads as empty.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
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

/** Record the user-chosen SOURCE host for a skill (sticky relocation). */
export async function recordSkillSourceHost(
  projectDir: string,
  name: string,
  host: string,
): Promise<void> {
  await mutateSkillPlacementsStore(projectDir, (file) => {
    file.sources = { ...file.sources, [name]: host };
  });
}

/** Record the expected form of a skills-root FOLDER after a folder verb. */
export async function recordFolderExpectation(
  projectDir: string,
  root: string,
  expectation: FolderExpectation,
): Promise<void> {
  await mutateSkillPlacementsStore(projectDir, (file) => {
    file.folders = { ...file.folders, [root]: expectation };
  });
}

/** All recorded folder expectations for a base (empty map when none). */
export function readFolderExpectations(projectDir: string): Record<string, FolderExpectation> {
  return readSkillPlacementsStore(projectDir).folders ?? {};
}

/** Record a USER-declared known skill root (idempotent). */
export async function recordKnownSkillRoot(projectDir: string, root: string): Promise<void> {
  await mutateSkillPlacementsStore(projectDir, (file) => {
    const roots = new Set(file.roots ?? []);
    if (roots.has(root)) return;
    roots.add(root);
    file.roots = [...roots].sort();
  });
}

/**
 * The raw preference, `undefined` when unset (for default-chaining).
 *
 * Read-only now: nothing writes this any more. A skill-wide mode was only ever
 * settable over MCP, where it applied as a side effect of installing and then
 * outranked the derived default forever — invisible in the app, which has no
 * such control and picks a new location's form from the ones the skill already
 * uses. Ledgers written before that changed still carry the key, so it is still
 * honored for them rather than silently flipping their behavior.
 */
export function readSkillInstallModeRaw(
  projectDir: string,
  name: string,
): 'copy' | 'link' | undefined {
  const pref = readSkillPlacementsStore(projectDir).preferences?.[name];
  return pref === 'link' || pref === 'copy' ? pref : undefined;
}

/** Read + prune: placements whose bundle dir vanished are dropped (not saved). */
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

/** Drop one recorded placement (the ledger half of unplace). */
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

/** Record (or refresh) one placement for a skill. */
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

/**
 * Forward re-sync ("copy + re-sync", the LOSSLESS half): refresh
 * recorded copies from a changed canonical. Strictly hash-gated — a copy is
 * refreshed ONLY when its current bytes still equal the hash recorded when OK
 * made it (i.e. nobody hand-edited the copy). A hand-edited copy is left
 * alone and surfaces as a fork; copy→SOURCE reconcile is a separate,
 * deliberately-unbuilt design (data-loss class). Returns the refresh count.
 */
export async function resyncRecordedSkillCopies(
  projectDir: string,
  contentDir: string,
  /** Scan override (the GLOBAL tier passes `scanGlobalInPlaceSkills(home)`). */
  skillsOverride?: InPlaceSkill[],
): Promise<number> {
  const placements = readSkillPlacements(projectDir);
  const skills = skillsOverride ?? scanInPlaceSkills(contentDir);
  // Auto-pair: observing two dirs BYTE-IDENTICAL is proof of a copy
  // relationship — record it (with the shared hash) so a later canonical edit
  // can lossless-refresh the unedited side instead of forking it. Idempotent:
  // recorded paths are skipped.
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
      if (current === undefined) continue; // vanished — the pruning read drops it
      if (current === skill.contentHash) {
        // Already in sync; keep the record's hash current for the next edit.
        if (p.hash !== current) {
          await recordSkillPlacement(projectDir, skill.name, { ...p, hash: current });
        }
        continue;
      }
      if (current !== p.hash) continue; // hand-edited copy — NEVER clobbered
      // Revalidate immediately before destructive work. This closes the gap
      // between reading a persisted ledger and the rm/cp pair below.
      copyAbs = resolveSkillPlacementPath(projectDir, p.path);
      if (copyAbs === null) continue;
      tracedRmSync(copyAbs, { recursive: true, force: true });
      // Same reason as the projection copy: a canonical that is itself a symlink
      // (the `source` verb points it elsewhere) must be materialized, or this
      // refresh replaces a real copy with a pointer to the source.
      tracedCpSync(canonicalAbs, copyAbs, { recursive: true, dereference: true });
      await recordSkillPlacement(projectDir, skill.name, { ...p, hash: skill.contentHash });
      refreshed += 1;
    }
  }
  return refreshed;
}
