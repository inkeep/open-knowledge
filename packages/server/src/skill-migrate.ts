/**
 * One-shot store→in-place migration: relocate each project
 * `.ok/skills/<name>` bundle OUT of the store to its precedence editor-dir path,
 * so existing skills join the in-place model (versioned + listed at their real
 * paths; the store dies by attrition).
 *
 * Target selection: the highest-`SKILL_CANONICAL_PRECEDENCE` host that already
 * carries the skill (a store symlink OK projected, or a same-hash real copy);
 * a skill projected nowhere lands in the `.agents/skills` hub (the precedence
 * pick, mirroring the default-canonical rule).
 *
 * Safety (the reason this is boot-time + never destructive):
 *  - A DIFFERENT real dir or a foreign symlink at the target → the skill is
 *    SKIPPED entirely, everything left untouched.
 *  - Other hosts' store symlinks are replaced with real COPIES of the new
 *    canonical (the go-forward copy model) so editors keep loading it.
 *  - The install marker entry is dropped — the in-place scan is truth.
 *  - Lockfile entries stay: they're name-keyed and Update/Modified/Revert
 *    resolve the bundle's real dir dynamically.
 */

import { existsSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import {
  AGENTS_SKILLS_ROOT,
  EDITOR_PROJECT_SKILL_ROOT,
  EDITOR_USER_SKILL_ROOT,
  type EditorId,
  SKILL_NAME_REGEX,
  skillRootActivationPath,
} from '@inkeep/open-knowledge-core';
import {
  parseSkillDir,
  SKILL_CANONICAL_PRECEDENCE,
  type SkillHostId,
} from '@inkeep/open-knowledge-core/skills-catalog';
import { tracedCpSync, tracedMkdirSync, tracedRenameSync, tracedRmSync } from './fs-traced.ts';
import { removeSkillInstall } from './installed-skills-marker.ts';
import { getLogger } from './logger.ts';
import { INTERNAL_BUNDLE_SKILL_NAMES } from './skill-bundles.ts';
import { inspectSkillPathEntry } from './skill-path-entry.ts';
import { readSkillPlacements } from './skill-placements.ts';
import { hostSkillsRootEscapes } from './skill-projection.ts';

const logger = getLogger('skill-migrate');

/** host → base-relative skills root, in canonical-precedence order. */
function rootsByPrecedence(
  map: Record<EditorId, string | null>,
): ReadonlyArray<{ host: SkillHostId; root: string }> {
  return [
    { host: 'agents' as SkillHostId, root: AGENTS_SKILLS_ROOT },
    ...(Object.entries(map) as [EditorId, string | null][])
      .filter((e): e is [EditorId, string] => e[1] !== null)
      .map(([host, root]) => ({ host: host as SkillHostId, root })),
  ].sort((a, b) => {
    const ra = SKILL_CANONICAL_PRECEDENCE.indexOf(a.host);
    const rb = SKILL_CANONICAL_PRECEDENCE.indexOf(b.host);
    return (
      (ra === -1 ? SKILL_CANONICAL_PRECEDENCE.length : ra) -
        (rb === -1 ? SKILL_CANONICAL_PRECEDENCE.length : rb) || a.host.localeCompare(b.host)
    );
  });
}

const HOST_ROOTS_BY_PRECEDENCE = rootsByPrecedence(EDITOR_PROJECT_SKILL_ROOT);

/** The GLOBAL tier's roots: user-home editor dirs (`~/.claude/skills`, …). */
export const USER_HOST_ROOTS_BY_PRECEDENCE = rootsByPrecedence(EDITOR_USER_SKILL_ROOT);

function hostRootExists(base: string, skillsRoot: string): boolean {
  return existsSync(resolve(base, skillRootActivationPath(skillsRoot)));
}

/** Move a directory; copy+remove fallback ONLY on a cross-device rename. */
function moveDir(from: string, to: string): void {
  tracedMkdirSync(dirname(to), { recursive: true });
  try {
    tracedRenameSync(from, to);
  } catch (err: unknown) {
    if (!(err instanceof Error) || (err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
    tracedCpSync(from, to, { recursive: true });
    tracedRmSync(from, { recursive: true, force: true });
  }
}

export type HostState =
  | { kind: 'absent' }
  | { kind: 'store-link' } // symlink resolving into the store dir — OK projected it
  | { kind: 'same-copy' }
  /** Someone else's. Migration never writes here; `by` only reaches the skip
   *  reason, so an operator can tell a foreign symlink from a hand-edited dir. */
  | { kind: 'occupied'; by: 'foreign-link' | 'different' };

/** Exported for the cross-classifier equivalence suite, which drives this and
 *  `classifyInPlaceDest` over one matrix of on-disk shapes. Not a public API. */
export function classifyHostEntry(
  entryPath: string,
  storeDirReal: string,
  storeHash: string,
): HostState {
  const entry = inspectSkillPathEntry(entryPath, storeDirReal, storeHash);
  switch (entry.kind) {
    case 'absent':
      return { kind: 'absent' };
    case 'other':
      return { kind: 'occupied', by: 'different' };
    case 'symlink':
      // A DANGLING link is foreign here, unlike the projection path. An OK
      // projection whose store source we're about to move would not dangle
      // (source still present), so a dangling one belongs to something else —
      // reconcile's orphan pass owns it. Mapping it to a removable link would
      // make migration delete links it was written to leave behind.
      return entry.resolution === 'target'
        ? { kind: 'store-link' }
        : { kind: 'occupied', by: 'foreign-link' };
    case 'dir':
      // No `canonical-dir` equivalent: the store dir and the host dirs are
      // distinct paths by construction, so a realpath match can only be a
      // bundle byte-identical to the store's — which is what `same-copy`
      // already means for migration's handling.
      return entry.identity === 'different'
        ? { kind: 'occupied', by: 'different' }
        : { kind: 'same-copy' };
  }
}

export interface StoreMigrationResult {
  migrated: Array<{ name: string; to: string }>;
  skipped: Array<{ name: string; reason: string }>;
}

/**
 * The subset of scanned in-place skill names that are GENUINE placements — a
 * real dir, or a symlink NOT pointing into the `.ok/skills` store — for use as
 * `migrateStoreSkillsInPlace`'s `inPlaceNames` skip-set.
 *
 * A same-name skill whose in-place canonical resolves INTO the store is a legacy
 * store PROJECTION (the old `.claude/skills/<name> → ../../.ok/skills/<name>`
 * model), NOT a placement. Passing it as `inPlaceNames` made the drain skip the
 * store dir forever ("placement-of-in-place") so it never drained; excluding it
 * lets the drain migrate the store dir out (move it to a real host + repoint the
 * projections). `base` is the scope root (project `contentDir` / user `home`);
 * `dir` is base-relative (the `InPlaceSkill.dir` shape).
 */
export function genuineInPlaceNames(
  base: string,
  entries: ReadonlyArray<{ name: string; dir: string }>,
): Set<string> {
  let storeReal: string;
  try {
    storeReal = realpathSync(resolve(base, '.ok', 'skills'));
  } catch {
    storeReal = resolve(base, '.ok', 'skills');
  }
  return new Set(
    entries
      .filter((s) => {
        try {
          return !realpathSync(resolve(base, s.dir)).startsWith(storeReal + sep);
        } catch {
          return true;
        }
      })
      .map((s) => s.name),
  );
}

/**
 * Migrate every project `.ok/skills/<name>` bundle to an in-place editor-dir
 * canonical. Best-effort + per-skill isolated: one skill's failure (or
 * conflict-skip) never aborts the pass. Idempotent: an empty store is a no-op.
 */
export async function migrateStoreSkillsInPlace(opts: {
  projectDir: string;
  /** Absolute `.ok/skills` project store root. */
  skillsRoot: string;
  /** Names whose IDENTITY already lives in-place (registry canonicals). A
   *  `.ok/skills/<name>` dir sharing such a name is a user PLACEMENT of that
   *  skill (in-place wins the name), NOT a store resident — migrating it would
   *  clobber the placement on every boot. */
  inPlaceNames?: ReadonlySet<string>;
  /** Host roots to migrate INTO (default: project editor dirs). The GLOBAL
   *  tier passes {@link USER_HOST_ROOTS_BY_PRECEDENCE}. */
  hostRoots?: ReadonlyArray<{ host: SkillHostId; root: string }>;
}): Promise<StoreMigrationResult> {
  const { projectDir, skillsRoot } = opts;
  const inPlaceNames = opts.inPlaceNames ?? new Set<string>();
  const hostRootsByPrecedence = opts.hostRoots ?? HOST_ROOTS_BY_PRECEDENCE;
  const result: StoreMigrationResult = { migrated: [], skipped: [] };
  if (!existsSync(skillsRoot)) return result;
  let entries: string[];
  try {
    entries = readdirSync(skillsRoot);
  } catch {
    return result;
  }

  // Deliberate placements AT this root, from the ledger the placement verb
  // writes. Residue from the retired store has no ledger entry, so this
  // separates "the user chose this folder" from "this is left over".
  const storeRootRel = relative(projectDir, skillsRoot).split(sep).join('/');
  const recordedPlacementRoots = new Set<string>();
  for (const [name, placements] of Object.entries(readSkillPlacements(projectDir))) {
    for (const placement of placements) {
      if (placement.path.split('/').slice(0, -1).join('/') === storeRootRel) {
        recordedPlacementRoots.add(name);
      }
    }
  }

  for (const name of entries) {
    try {
      if (!SKILL_NAME_REGEX.test(name) || INTERNAL_BUNDLE_SKILL_NAMES.has(name)) continue;
      if (inPlaceNames.has(name)) {
        // A placement of an in-place skill — not ours to move. COUNTED so a
        // store resident that never drains is visible in the boot log rather
        // than silently skipped forever.
        result.skipped.push({ name, reason: 'placement-of-in-place' });
        continue;
      }
      if (recordedPlacementRoots.has(name)) {
        // The user placed this skill here on purpose — the ledger says so, the
        // same way it does for `.team/skills`. `.ok/skills` is an ordinary
        // custom root now, and no other root has its contents relocated out
        // from under a deliberate placement. Only UNRECORDED residue drains.
        result.skipped.push({ name, reason: 'recorded-placement' });
        continue;
      }
      const storeDir = resolve(skillsRoot, name);
      if (!existsSync(join(storeDir, 'SKILL.md'))) continue;
      const storeHash = parseSkillDir(storeDir)?.contentHash;
      if (storeHash === undefined) continue;
      const storeDirReal = realpathSync(storeDir);

      // Classify every host slot once.
      const states = hostRootsByPrecedence
        .map(({ host, root }) => {
          const hostRoot = resolve(projectDir, root);
          return {
            host,
            root,
            path: join(hostRoot, name),
            escapes: hostSkillsRootEscapes(projectDir, hostRoot),
            state: classifyHostEntry(join(hostRoot, name), storeDirReal, storeHash),
          };
        })
        .filter((s) => !s.escapes);

      // Target = highest-precedence host already carrying the skill (store link
      // or same-hash copy); an unprojected skill falls back to the first root that
      // ALREADY EXISTS. No existing host means the legacy bundle stays put.
      const target =
        states.find((s) => s.state.kind === 'store-link' || s.state.kind === 'same-copy') ??
        // An existing host root is authorized even when its skill slot is
        // occupied; the branch below reports that conflict without inventing a
        // fallback host.
        states.find((s) => hostRootExists(projectDir, s.root));
      if (!target) {
        result.skipped.push({ name, reason: 'no-usable-target' });
        continue;
      }
      if (target.state.kind === 'occupied') {
        result.skipped.push({
          name,
          reason: `target-occupied:${target.root} (${target.state.by})`,
        });
        continue;
      }

      // Materialize the canonical at the target.
      if (target.state.kind === 'same-copy') {
        // The target real dir already IS the bundle — the store dir is redundant.
        tracedRmSync(storeDir, { recursive: true, force: true });
      } else {
        if (target.state.kind === 'store-link') {
          tracedRmSync(target.path, { recursive: true, force: true });
        }
        moveDir(storeDir, target.path);
      }

      // Other hosts: replace the store symlinks (now pointing at the moved-away
      // store path) with real copies of the new canonical. Same-hash copies stay
      // (the scan dedups them); foreign links + differing dirs are never touched.
      for (const s of states) {
        if (s === target || s.state.kind !== 'store-link') continue;
        tracedRmSync(s.path, { recursive: true, force: true });
        tracedCpSync(target.path, s.path, { recursive: true });
      }

      // The in-place scan is truth now — drop the install-marker entry.
      await removeSkillInstall(projectDir, name);

      result.migrated.push({ name, to: `${target.root}/${name}` });
      logger.info({ skill: name, to: `${target.root}/${name}` }, 'migrated store skill in place');
    } catch (err) {
      result.skipped.push({ name, reason: 'error' });
      logger.warn({ err, skill: name }, 'store-skill migration skipped one entry after error');
    }
  }
  return result;
}
