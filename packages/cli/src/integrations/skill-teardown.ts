import { existsSync, lstatSync, readdirSync, rmdirSync, rmSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { USER_SKILL_HOSTS } from '@inkeep/open-knowledge-core';
import {
  BUNDLE_SKILL_NAME,
  type BundleId,
  USER_GLOBAL_BUNDLE_IDS,
} from '@inkeep/open-knowledge-server';

interface LegacyFanoutHost {
  readonly hostDir: string;
  readonly pruneRoot: string;
}

const LEGACY_FANOUT_HOSTS: readonly LegacyFanoutHost[] = [
  { hostDir: '.adal', pruneRoot: '.adal' },
  { hostDir: '.aider-desk', pruneRoot: '.aider-desk' },
  { hostDir: '.astrbot/data', pruneRoot: '.astrbot' },
  { hostDir: '.augment', pruneRoot: '.augment' },
  { hostDir: '.autohand', pruneRoot: '.autohand' },
  { hostDir: '.bob', pruneRoot: '.bob' },
  { hostDir: '.codeartsdoer', pruneRoot: '.codeartsdoer' },
  { hostDir: '.codebuddy', pruneRoot: '.codebuddy' },
  { hostDir: '.codeium/windsurf', pruneRoot: '.codeium' },
  { hostDir: '.codemaker', pruneRoot: '.codemaker' },
  { hostDir: '.codestudio', pruneRoot: '.codestudio' },
  { hostDir: '.commandcode', pruneRoot: '.commandcode' },
  { hostDir: '.config/crush', pruneRoot: '.config/crush' },
  { hostDir: '.config/devin', pruneRoot: '.config/devin' },
  { hostDir: '.config/goose', pruneRoot: '.config/goose' },
  { hostDir: '.config/kimchi/harness', pruneRoot: '.config/kimchi' },
  { hostDir: '.continue', pruneRoot: '.continue' },
  { hostDir: '.factory', pruneRoot: '.factory' },
  { hostDir: '.forge', pruneRoot: '.forge' },
  { hostDir: '.grok', pruneRoot: '.grok' },
  { hostDir: '.iflow', pruneRoot: '.iflow' },
  { hostDir: '.inferencesh', pruneRoot: '.inferencesh' },
  { hostDir: '.jazz', pruneRoot: '.jazz' },
  { hostDir: '.junie', pruneRoot: '.junie' },
  { hostDir: '.kilocode', pruneRoot: '.kilocode' },
  { hostDir: '.kiro', pruneRoot: '.kiro' },
  { hostDir: '.kode', pruneRoot: '.kode' },
  { hostDir: '.lingma', pruneRoot: '.lingma' },
  { hostDir: '.mcpjam', pruneRoot: '.mcpjam' },
  { hostDir: '.moxby', pruneRoot: '.moxby' },
  { hostDir: '.mux', pruneRoot: '.mux' },
  { hostDir: '.neovate', pruneRoot: '.neovate' },
  { hostDir: '.ona', pruneRoot: '.ona' },
  { hostDir: '.openhands', pruneRoot: '.openhands' },
  { hostDir: '.pochi', pruneRoot: '.pochi' },
  { hostDir: '.qoder', pruneRoot: '.qoder' },
  { hostDir: '.qoder-cn', pruneRoot: '.qoder-cn' },
  { hostDir: '.qwen', pruneRoot: '.qwen' },
  { hostDir: '.reasonix', pruneRoot: '.reasonix' },
  { hostDir: '.roo', pruneRoot: '.roo' },
  { hostDir: '.rovodev', pruneRoot: '.rovodev' },
  { hostDir: '.snowflake/cortex', pruneRoot: '.snowflake' },
  { hostDir: '.tabnine/agent', pruneRoot: '.tabnine' },
  { hostDir: '.terramind', pruneRoot: '.terramind' },
  { hostDir: '.tinycloud', pruneRoot: '.tinycloud' },
  { hostDir: '.trae', pruneRoot: '.trae' },
  { hostDir: '.trae-cn', pruneRoot: '.trae-cn' },
  { hostDir: '.vibe', pruneRoot: '.vibe' },
  { hostDir: '.zcode', pruneRoot: '.zcode' },
  { hostDir: '.zencoder', pruneRoot: '.zencoder' },
];

const LEGACY_SWEEPABLE_SKILL_NAMES: readonly string[] = [
  ...USER_GLOBAL_BUNDLE_IDS.map((id) => BUNDLE_SKILL_NAME[id]),
  'open-knowledge',
];

export interface LegacyFanoutSweepPlan {
  readonly skillDirs: string[];
  readonly emptyDirs: string[];
}

function assertUsableHome(home: string): string {
  if (!isAbsolute(home)) {
    throw new Error(
      `skill cleanup requires an absolute home directory; got ${JSON.stringify(home)}`,
    );
  }
  const normalized = resolve(home);
  if (normalized === sep || dirname(normalized) === normalized) {
    throw new Error(`skill cleanup refuses to operate on the filesystem root (${normalized})`);
  }
  return normalized;
}

function isSymlinkFreeUnder(home: string, dir: string): boolean {
  const rel = relative(home, dir);
  if (rel.startsWith('..') || isAbsolute(rel)) return false;
  let cur = home;
  for (const segment of rel.split(sep)) {
    cur = join(cur, segment);
    try {
      if (!lstatSync(cur).isDirectory()) return false;
    } catch {
      return false;
    }
  }
  return true;
}

function willBeEmpty(dir: string, doomed: ReadonlySet<string>): boolean {
  try {
    return readdirSync(dir).every((name) => doomed.has(join(dir, name)));
  } catch {
    return false;
  }
}

export function planLegacyFanoutSweep(homeInput: string): LegacyFanoutSweepPlan {
  const home = assertUsableHome(homeInput);
  const skillDirs: string[] = [];
  const emptyDirs: string[] = [];
  const doomed = new Set<string>();

  for (const entry of LEGACY_FANOUT_HOSTS) {
    const skillsDir = join(home, entry.hostDir, 'skills');
    if (!isSymlinkFreeUnder(home, skillsDir)) continue;
    const present = LEGACY_SWEEPABLE_SKILL_NAMES.map((name) => join(skillsDir, name)).filter(
      (path) => existsSync(path),
    );
    skillDirs.push(...present);
    for (const path of present) doomed.add(path);

    const stopAt = join(home, entry.pruneRoot);
    let cur = skillsDir;
    while (willBeEmpty(cur, doomed)) {
      emptyDirs.push(cur);
      doomed.add(cur);
      if (cur === stopAt) break;
      const parent = dirname(cur);
      if (parent === cur || parent === home || !parent.startsWith(home + sep)) break;
      cur = parent;
    }
  }

  return { skillDirs, emptyDirs };
}

function isRemovableBundleDir(dir: string): boolean {
  try {
    if (!lstatSync(dir).isDirectory()) return false;
    const entries = readdirSync(dir);
    return entries.length === 0 || entries.includes('SKILL.md');
  } catch {
    return false;
  }
}

function legalSweepPaths(home: string): { skillDirs: Set<string>; emptyDirs: Set<string> } {
  const skillDirs = new Set<string>();
  const emptyDirs = new Set<string>();
  for (const entry of LEGACY_FANOUT_HOSTS) {
    const skillsDir = join(home, entry.hostDir, 'skills');
    for (const name of LEGACY_SWEEPABLE_SKILL_NAMES) skillDirs.add(join(skillsDir, name));
    const stopAt = join(home, entry.pruneRoot);
    let cur = skillsDir;
    while (true) {
      emptyDirs.add(cur);
      if (cur === stopAt) break;
      const parent = dirname(cur);
      if (parent === cur || parent === home || !parent.startsWith(home + sep)) break;
      cur = parent;
    }
  }
  return { skillDirs, emptyDirs };
}

export function applyLegacyFanoutSweep(homeInput: string, plan: LegacyFanoutSweepPlan): string[] {
  const home = assertUsableHome(homeInput);
  const legal = legalSweepPaths(home);

  const illegal = [
    ...plan.skillDirs.filter((p) => !legal.skillDirs.has(p)),
    ...plan.emptyDirs.filter((p) => !legal.emptyDirs.has(p)),
  ];
  if (illegal.length > 0) {
    throw new Error(
      `refusing skill cleanup — ${illegal.length} path(s) outside the known legacy set: ${illegal.join(', ')}`,
    );
  }

  const removed: string[] = [];
  for (const dir of plan.skillDirs) {
    if (!isSymlinkFreeUnder(home, dir)) continue;
    if (!isRemovableBundleDir(dir)) continue;
    try {
      rmSync(dir, { recursive: true, force: true });
      removed.push(dir);
    } catch {}
  }
  for (const dir of plan.emptyDirs) {
    if (!isSymlinkFreeUnder(home, dir)) continue;
    try {
      rmdirSync(dir);
      removed.push(dir);
    } catch {}
  }
  return removed;
}

export interface SkillBundleTarget {
  path: string;
  bundleId: BundleId;
  scope: 'central' | 'host';
  hostDir?: string;
}

export function userGlobalSkillBundleTargets(homeInput: string): SkillBundleTarget[] {
  const home = assertUsableHome(homeInput);
  const targets: SkillBundleTarget[] = [];
  for (const bundleId of USER_GLOBAL_BUNDLE_IDS) {
    const name = BUNDLE_SKILL_NAME[bundleId];
    targets.push({
      path: join(home, '.agents', 'skills', name),
      bundleId,
      scope: 'central',
    });
    for (const host of USER_SKILL_HOSTS) {
      targets.push({
        path: join(home, host.skillsRoot, name),
        bundleId,
        scope: 'host',
        hostDir: host.hostDir,
      });
    }
  }
  return targets;
}

export function removeUserGlobalSkillBundle(home: string, bundleId: BundleId): void {
  const failures: Error[] = [];
  for (const target of userGlobalSkillBundleTargets(home)) {
    if (target.bundleId !== bundleId) continue;
    try {
      rmSync(target.path, { recursive: true, force: true });
    } catch (err) {
      failures.push(err instanceof Error ? err : new Error(String(err)));
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      `Failed to remove ${failures.length} path(s) for ${bundleId}`,
    );
  }
}
