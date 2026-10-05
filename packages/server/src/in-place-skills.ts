import { existsSync, lstatSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import {
  AGENTS_SKILLS_ROOT,
  EDITOR_PROJECT_SKILL_ROOT,
  EDITOR_USER_SKILL_ROOT,
  type EditorId,
  estimateSkillCost,
  HUB_READER_EDITORS,
  LEGACY_SKILL_STORE_ROOT,
  OK_DIR,
  parseFrontmatterRecord,
  SKILLS_STORE_DIRNAME,
  type SkillCostTiers,
  type SkillScope,
  skillRootActivationPath,
} from '@inkeep/open-knowledge-core';
import {
  buildSkillRegistry,
  groupSkillsByIdentity,
  type LocatedSkillOccurrence,
  packMarkerOf,
  parseSkillDir,
  SKILL_CANONICAL_PRECEDENCE,
  type SkillHostId,
} from '@inkeep/open-knowledge-core/skills-catalog';
import { isInternalBundleSkillName, isUserGlobalBundleSkillName } from './skill-bundles.ts';
import {
  observeSkillPlacementInputsForScan,
  readKnownSkillPlacementRoots as readPlacementRoots,
} from './skill-placements-store.ts';

function hostRoots(
  map: Record<EditorId, string | null>,
  agentsRoot: string,
): ReadonlyArray<{ editor: SkillHostId; root: string }> {
  return [
    ...(Object.entries(map) as [EditorId, string | null][])
      .filter((e): e is [EditorId, string] => e[1] !== null)
      .map(([editor, root]) => ({ editor: editor as SkillHostId, root })),
    { editor: 'agents' as SkillHostId, root: agentsRoot },
  ];
}

const EDITOR_SKILL_ROOTS = hostRoots(EDITOR_PROJECT_SKILL_ROOT, AGENTS_SKILLS_ROOT);

const USER_SKILL_ROOTS = hostRoots(EDITOR_USER_SKILL_ROOT, AGENTS_SKILLS_ROOT);

export interface InPlaceSkill {
  readonly name: string;
  readonly description: string;
  readonly dir: string;
  readonly hosts: readonly string[];
  readonly linkedHosts: readonly string[];
  readonly conflictHosts: readonly string[];
  readonly copyDirs: readonly string[];
  readonly pack?: string;
  readonly contentHash: string;
  readonly size: SkillCostTiers;
}

interface ScanOccurrence extends LocatedSkillOccurrence {
  readonly description: string;
  readonly size: SkillCostTiers;
  readonly pack?: string;
  readonly viaLink: boolean;
  readonly aliasRooted?: boolean;
}

type SkillScanFailure =
  | { readonly scope: 'scan'; readonly error: unknown }
  | { readonly scope: 'ledger-parse'; readonly error: unknown }
  | { readonly scope: 'bundle'; readonly dir: string; readonly error: unknown };

interface SkillScanObservation {
  readonly skills: InPlaceSkill[];
  readonly occurrences: readonly ScanOccurrence[];
  readonly failures: readonly SkillScanFailure[];
}

function isAbsentPath(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

export function scanHostRootAliases(base: string, scope: SkillScope): Record<string, string> {
  const roots = knownSkillRootsFor(base, scope);
  const out: Record<string, string> = {};
  let baseReal: string;
  try {
    baseReal = realpathSync(base);
  } catch {
    return out;
  }
  for (const { editor, root } of roots) {
    let real: string;
    try {
      real = realpathSync(join(base, root));
    } catch {
      continue;
    }
    if (real === join(baseReal, root)) continue;
    const rel = relative(baseReal, real);
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) continue;
    out[editor] = rel.split(sep).join('/');
  }
  return out;
}

function hostSkillRootsFor(
  scope: SkillScope,
): ReadonlyArray<{ editor: SkillHostId; root: string }> {
  return scope === 'project' ? EDITOR_SKILL_ROOTS : USER_SKILL_ROOTS;
}

export function globalSkillGraphRoots(home: string): string[] {
  const roots = knownSkillRootsFor(home, 'global').map((r) => join(home, r.root));
  const legacyStore = join(home, OK_DIR, SKILLS_STORE_DIRNAME);
  return roots.includes(legacyStore) ? roots : [...roots, legacyStore];
}

export function knownSkillRootsFor(
  base: string,
  scope: SkillScope,
): ReadonlyArray<{ editor: string; root: string }> {
  return skillRootsWithCustom(scope, readPlacementRoots(base));
}

function skillRootsWithCustom(
  scope: SkillScope,
  customRoots: readonly string[],
): ReadonlyArray<{ editor: string; root: string }> {
  const std = hostSkillRootsFor(scope);
  const seen = new Set(std.map((r) => r.root));
  return [...std, ...customRoots.filter((r) => !seen.has(r)).map((r) => ({ editor: r, root: r }))];
}

export function standardSkillRoots(scope: SkillScope): ReadonlySet<string> {
  const roots = scope === 'project' ? EDITOR_SKILL_ROOTS : USER_SKILL_ROOTS;
  return new Set(roots.map((r) => r.root));
}

export function isActivatedSkillRoot(
  base: string,
  scope: SkillScope,
  root: string,
  home: string,
): boolean {
  if (!standardSkillRoots(scope).has(root)) return true;
  if (existsSync(join(base, skillRootActivationPath(root)))) return true;
  return (
    root === AGENTS_SKILLS_ROOT &&
    HUB_READER_EDITORS.some((r) => r.scope === scope && existsSync(join(home, r.dotDir)))
  );
}

export function removableSkillOccurrenceDirs(
  base: string,
  scope: SkillScope,
  name: string,
  contentHash: string,
): string[] {
  const roots = new Set<string>([
    ...knownSkillRootsFor(base, scope).map((r) => r.root),
    LEGACY_SKILL_STORE_ROOT,
  ]);
  const dirs: string[] = [];
  for (const root of roots) {
    const dir = join(base, root, name);
    let stat: ReturnType<typeof lstatSync>;
    try {
      stat = lstatSync(dir);
    } catch {
      continue;
    }
    if (stat.isSymbolicLink()) {
      dirs.push(dir);
      continue;
    }
    if (parseSkillDir(dir)?.contentHash === contentHash) dirs.push(dir);
  }
  return dirs;
}

export function aliasedSourceRoots(
  aliases: Record<string, string>,
  scope: SkillScope,
): Set<string> {
  const roots = scope === 'project' ? EDITOR_SKILL_ROOTS : USER_SKILL_ROOTS;
  const byHost = new Map(roots.map((r) => [r.editor as string, r.root]));
  const out = new Set<string>();
  for (const host of Object.keys(aliases)) {
    const root = byHost.get(host);
    if (root !== undefined) out.add(root);
    else if (host.includes('/')) out.add(host);
  }
  return out;
}

export function resolveDefaultSkillHomeRel(base: string, scope: SkillScope): string | null {
  const roots = scope === 'project' ? EDITOR_SKILL_ROOTS : USER_SKILL_ROOTS;
  if (existsSync(join(base, '.agents'))) return AGENTS_SKILLS_ROOT;
  const byPrecedence = [...roots]
    .filter((r) => r.editor !== 'agents')
    .sort((a, b) => {
      const ra = SKILL_CANONICAL_PRECEDENCE.indexOf(a.editor);
      const rb = SKILL_CANONICAL_PRECEDENCE.indexOf(b.editor);
      return (
        (ra === -1 ? SKILL_CANONICAL_PRECEDENCE.length : ra) -
        (rb === -1 ? SKILL_CANONICAL_PRECEDENCE.length : rb)
      );
    });
  for (const { root } of byPrecedence) {
    if (existsSync(join(base, skillRootActivationPath(root)))) return root;
  }
  return null;
}

export function skillHomeCandidateFolders(scope: SkillScope): string[] {
  const roots = scope === 'project' ? EDITOR_SKILL_ROOTS : USER_SKILL_ROOTS;
  return [...new Set(roots.map((r) => `${skillRootActivationPath(r.root)}/`))];
}

function bundleStamp(absDir: string): string | null {
  try {
    if (!statSync(join(absDir, 'SKILL.md')).isFile()) return null;
  } catch (error) {
    if (isAbsentPath(error)) return null;
    throw error;
  }
  const parts: string[] = [];
  const walk = (dir: string, rel: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      const r = rel === '' ? e.name : `${rel}/${e.name}`;
      if (e.isDirectory()) walk(p, r);
      else if (e.isFile()) {
        const st = statSync(p);
        parts.push(`${r}:${st.size}:${st.mtimeMs}`);
      }
    }
  };
  walk(absDir, '');
  return parts.sort().join('|');
}

const parseCache = new Map<
  string,
  { stamp: string; contentHash: string; description: string; size: SkillCostTiers }
>();

function parseSkillDirCached(
  absDir: string,
): { contentHash: string; description: string; size: SkillCostTiers; pack?: string } | null {
  const stamp = bundleStamp(absDir);
  if (stamp === null) return null;
  const hit = parseCache.get(absDir);
  if (hit !== undefined && hit.stamp === stamp) return hit;
  const parsed = parseSkillDir(absDir);
  if (!parsed) return null;
  const pack = packMarkerOf(parseFrontmatterRecord(parsed.skillMd) ?? {});
  const entry = {
    stamp,
    contentHash: parsed.contentHash,
    description: parsed.description,
    size: estimateSkillCost(parsed),
    ...(pack !== undefined ? { pack } : {}),
  };
  parseCache.set(absDir, entry);
  return entry;
}

function scanBase(base: string, scope: SkillScope): SkillScanObservation {
  const occurrences: ScanOccurrence[] = [];
  const failures: SkillScanFailure[] = [];
  const recordFailure = (error: unknown): void => {
    failures.push({ scope: 'scan', error });
  };
  let sourcePrefs: Record<string, string> = {};
  let customRoots: string[] = [];
  try {
    const inputs = observeSkillPlacementInputsForScan(base);
    sourcePrefs = inputs.sources;
    customRoots = inputs.roots;
    if (inputs.kind === 'incomplete') recordFailure(inputs.error);
    if (inputs.kind === 'unparsable') failures.push({ scope: 'ledger-parse', error: inputs.error });
  } catch (error) {
    recordFailure(error);
  }
  const allRoots = skillRootsWithCustom(scope, customRoots);

  let baseReal: string | null = null;
  try {
    baseReal = realpathSync(base);
  } catch (error) {
    if (!isAbsentPath(error)) recordFailure(error);
  }
  for (const { editor, root } of allRoots) {
    const absRoot = join(base, root);
    let entries: string[];
    let rootAliased = false;
    try {
      const rootStat = statSync(absRoot);
      if (!rootStat.isDirectory()) continue;
    } catch (error) {
      if (!isAbsentPath(error)) recordFailure(error);
      continue;
    }
    try {
      rootAliased = baseReal !== null && realpathSync(absRoot) !== join(baseReal, root);
      entries = readdirSync(absRoot);
    } catch (error) {
      recordFailure(error);
      continue;
    }
    for (const entry of entries) {
      const absDir = join(absRoot, entry);
      try {
        if (!statSync(absDir).isDirectory()) continue;
      } catch (error) {
        if (!isAbsentPath(error)) recordFailure(error);
        continue;
      }
      let parsed: ReturnType<typeof parseSkillDirCached>;
      try {
        parsed = parseSkillDirCached(absDir);
      } catch (error) {
        failures.push({ scope: 'bundle', dir: `${root}/${entry}`, error });
        continue;
      }
      if (!parsed) continue;
      try {
        occurrences.push({
          name: entry,
          scope,
          editor: editor as SkillHostId,
          contentHash: parsed.contentHash,
          dir: `${root}/${entry}`,
          description: parsed.description,
          size: parsed.size,
          ...(parsed.pack !== undefined ? { pack: parsed.pack } : {}),
          viaLink: rootAliased || lstatSync(absDir).isSymbolicLink(),
          ...(rootAliased ? { aliasRooted: true } : {}),
          ...(sourcePrefs[entry] === editor ? { preferredSource: true } : {}),
        });
      } catch (error) {
        recordFailure(error);
      }
    }
  }

  const { admittedDirs, canonicalDir } = buildSkillRegistry(occurrences);
  const byNameDefaults = new Set(canonicalDir.values());
  const skills = groupSkillsByIdentity(occurrences)
    .filter((g) => admittedDirs.has(g.canonical.dir))
    .filter((g) => byNameDefaults.has(g.canonical.dir) || !isInternalBundleSkillName(g.name))
    .sort(
      (a, b) =>
        a.name.localeCompare(b.name) ||
        Number(byNameDefaults.has(b.canonical.dir)) - Number(byNameDefaults.has(a.canonical.dir)) ||
        a.contentHash.localeCompare(b.contentHash),
    )
    .map((g) => {
      let canonicalReal: string | null = null;
      try {
        canonicalReal = realpathSync(join(base, g.canonical.dir));
      } catch {
        canonicalReal = null;
      }
      const isSameInode = (dir: string): boolean => {
        if (canonicalReal === null) return false;
        try {
          return realpathSync(join(base, dir)) === canonicalReal;
        } catch {
          return false;
        }
      };
      const realCopies = g.copies.filter(
        (c) => c.aliasRooted !== true && (c.viaLink || !isSameInode(c.dir)),
      );
      const conflictHosts = isInternalBundleSkillName(g.canonical.name)
        ? []
        : occurrences
            .filter((o) => o.name === g.canonical.name && o.contentHash !== g.contentHash)
            .map((o) => o.editor);
      return {
        name: g.canonical.name,
        description: g.canonical.description,
        dir: g.canonical.dir,
        hosts: [g.canonical.editor, ...realCopies.map((c) => c.editor)],
        linkedHosts: [g.canonical, ...realCopies].filter((o) => o.viaLink).map((o) => o.editor),
        conflictHosts,
        copyDirs: realCopies.filter((c) => !c.viaLink).map((c) => c.dir),
        contentHash: g.contentHash,
        size: g.canonical.size,
        ...(g.canonical.pack !== undefined ? { pack: g.canonical.pack } : {}),
      };
    });
  return { skills, occurrences, failures };
}

function projectInPlaceSkills(skills: readonly InPlaceSkill[]): InPlaceSkill[] {
  return skills.filter((skill) => !isUserGlobalBundleSkillName(skill.name));
}

export function scanInPlaceSkills(contentDir: string): InPlaceSkill[] {
  return projectInPlaceSkills(scanBase(contentDir, 'project').skills);
}

export function scanGlobalInPlaceSkills(home: string): InPlaceSkill[] {
  return scanBase(home, 'global').skills;
}

const USER_ROOTS_BY_PRECEDENCE = [...USER_SKILL_ROOTS].sort((a, b) => {
  const ra = SKILL_CANONICAL_PRECEDENCE.indexOf(a.editor);
  const rb = SKILL_CANONICAL_PRECEDENCE.indexOf(b.editor);
  const na = ra === -1 ? SKILL_CANONICAL_PRECEDENCE.length : ra;
  const nb = rb === -1 ? SKILL_CANONICAL_PRECEDENCE.length : rb;
  return na - nb || a.editor.localeCompare(b.editor);
});

export function resolveGlobalNativeSkillDir(home: string, name: string): string | null {
  for (const { root } of USER_ROOTS_BY_PRECEDENCE) {
    const dir = join(home, root, name);
    try {
      if (existsSync(join(dir, 'SKILL.md'))) return dir;
    } catch {}
  }
  return null;
}

export function skillRootPathsFor(contentDir: string): ReadonlySet<string> {
  return new Set(knownSkillRootsFor(contentDir, 'project').map((r) => r.root));
}

function skillNameOfDir(dir: string): string {
  return dir.slice(dir.lastIndexOf('/') + 1);
}

function skillRootOfDir(dir: string): string {
  return dir.slice(0, dir.lastIndexOf('/'));
}

function retainUndecidedAdmissions(
  prior: ReadonlySet<string>,
  observed: ReadonlySet<string>,
  observation: SkillScanObservation,
): ReadonlySet<string> {
  const ledgerUnparsable = observation.failures.some((f) => f.scope === 'ledger-parse');
  const failedBundles = new Set(
    observation.failures.flatMap((f) => (f.scope === 'bundle' ? [f.dir] : [])),
  );
  const occurrenceDirs = new Set(observation.occurrences.map((o) => o.dir));
  const occurrencesByName = new Map<string, number>();
  for (const { name } of observation.occurrences) {
    occurrencesByName.set(name, (occurrencesByName.get(name) ?? 0) + 1);
  }
  const standardRoots = standardSkillRoots('project');
  const undecided = (dir: string): boolean =>
    failedBundles.has(dir) ||
    (ledgerUnparsable &&
      (!standardRoots.has(skillRootOfDir(dir)) ||
        (occurrenceDirs.has(dir) && (occurrencesByName.get(skillNameOfDir(dir)) ?? 0) >= 2)));
  const retainedNames = new Set([...prior].filter(undecided).map(skillNameOfDir));
  return new Set([
    ...[...prior].filter(
      (dir) =>
        retainedNames.has(skillNameOfDir(dir)) && (undecided(dir) || occurrenceDirs.has(dir)),
    ),
    ...[...observed].filter((dir) => !retainedNames.has(skillNameOfDir(dir))),
  ]);
}

export function scanInPlaceSkillDirs(
  contentDir: string,
  priorAdmission?: ReadonlySet<string>,
): ReadonlySet<string> {
  const observation = scanBase(contentDir, 'project');
  const observed = new Set(projectInPlaceSkills(observation.skills).map((skill) => skill.dir));
  const [firstFailure] = observation.failures;
  if (firstFailure === undefined) return observed;
  if (priorAdmission === undefined || observation.failures.some((f) => f.scope === 'scan')) {
    throw firstFailure.error;
  }
  return retainUndecidedAdmissions(priorAdmission, observed, observation);
}
