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

export const USER_HOST_ROOTS_BY_PRECEDENCE = rootsByPrecedence(EDITOR_USER_SKILL_ROOT);

function hostRootExists(base: string, skillsRoot: string): boolean {
  return existsSync(resolve(base, skillRootActivationPath(skillsRoot)));
}

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
  | { kind: 'store-link' }
  | { kind: 'same-copy' }
  | { kind: 'occupied'; by: 'foreign-link' | 'different' };

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
      return entry.resolution === 'target'
        ? { kind: 'store-link' }
        : { kind: 'occupied', by: 'foreign-link' };
    case 'dir':
      return entry.identity === 'different'
        ? { kind: 'occupied', by: 'different' }
        : { kind: 'same-copy' };
  }
}

export interface StoreMigrationResult {
  migrated: Array<{ name: string; to: string }>;
  skipped: Array<{ name: string; reason: string }>;
}

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

export async function migrateStoreSkillsInPlace(opts: {
  projectDir: string;
  skillsRoot: string;
  inPlaceNames?: ReadonlySet<string>;
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
        result.skipped.push({ name, reason: 'placement-of-in-place' });
        continue;
      }
      if (recordedPlacementRoots.has(name)) {
        result.skipped.push({ name, reason: 'recorded-placement' });
        continue;
      }
      const storeDir = resolve(skillsRoot, name);
      if (!existsSync(join(storeDir, 'SKILL.md'))) continue;
      const storeHash = parseSkillDir(storeDir)?.contentHash;
      if (storeHash === undefined) continue;
      const storeDirReal = realpathSync(storeDir);

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

      const target =
        states.find((s) => s.state.kind === 'store-link' || s.state.kind === 'same-copy') ??
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

      if (target.state.kind === 'same-copy') {
        tracedRmSync(storeDir, { recursive: true, force: true });
      } else {
        if (target.state.kind === 'store-link') {
          tracedRmSync(target.path, { recursive: true, force: true });
        }
        moveDir(storeDir, target.path);
      }

      for (const s of states) {
        if (s === target || s.state.kind !== 'store-link') continue;
        tracedRmSync(s.path, { recursive: true, force: true });
        tracedCpSync(target.path, s.path, { recursive: true });
      }

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
