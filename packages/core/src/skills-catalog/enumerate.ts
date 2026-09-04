import { realpathSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { parseSkillDir } from './acquire/parse.ts';
import type { RawSkill, SkillBundle } from './adapters/shared.ts';
import { enumerateSkillDir } from './adapters/skill-dir.ts';
import { harnessHomes, projectHarnessHomes } from './harness-homes.ts';
import { enumerateAgentPluginsRoot } from './plugin-providers/manifest-providers.ts';
import { enumeratePluginProvider } from './plugin-providers/registry.ts';
import type { CatalogSkill, OkPack } from './schema.ts';
import { OK_PACK_SCHEMA_VERSION } from './schema.ts';
import { catalogRawScopeToOkScope, isDetectedSkillInProject } from './scope.ts';

export interface EnumerateOptions {
  home?: string;
  projectDir?: string;
}

const OK_OWNED_SKILL_PREFIX = 'open-knowledge';

export interface InstalledSkillsResult {
  skills: CatalogSkill[];
  packs: OkPack[];
}

function hasProvenance(s: RawSkill): boolean {
  return Object.keys(s.provenance).length > 0;
}

function isPluginSourced(s: RawSkill): boolean {
  return s.provenance.plugin !== undefined;
}

function pickWinner(a: RawSkill, b: RawSkill): RawSkill {
  if (isPluginSourced(a) !== isPluginSourced(b)) return isPluginSourced(a) ? a : b;
  if (hasProvenance(a) !== hasProvenance(b)) return hasProvenance(a) ? a : b;
  const af = a.scripts.length + a.references.length;
  const bf = b.scripts.length + b.references.length;
  return bf > af ? b : a;
}

function toInstalledSkill(winner: RawSkill, harnesses: string[]): CatalogSkill {
  return {
    name: winner.name,
    description: winner.description,
    files: { skillMd: winner.skillMd, scripts: winner.scripts, references: winner.references },
    sourceHarness: winner.harness,
    sourceHarnesses: harnesses,
    home: winner.home,
    provenance: winner.provenance,
    inert: winner.inert,
  };
}

function contentIdentity(s: RawSkill): string {
  try {
    return parseSkillDir(s.home)?.contentHash ?? `unreadable:${s.home}`;
  } catch {
    return `unreadable:${s.home}`;
  }
}

function dedupeSkills(raw: RawSkill[]): CatalogSkill[] {
  const byIdentity = new Map<string, { winner: RawSkill; harnesses: Set<string> }>();
  for (const s of raw) {
    const scope = catalogRawScopeToOkScope(s.provenance.scope);
    const projectPath = scope === 'project' ? (s.provenance.projectPath ?? '') : '';
    const key = `${scope}\0${projectPath}\0${s.name}\0${contentIdentity(s)}`;
    const cur = byIdentity.get(key);
    if (!cur) {
      byIdentity.set(key, { winner: s, harnesses: new Set([s.harness]) });
    } else {
      cur.winner = pickWinner(cur.winner, s);
      cur.harnesses.add(s.harness);
    }
  }
  return [...byIdentity.values()]
    .map(({ winner, harnesses }) => toInstalledSkill(winner, [...harnesses].sort()))
    .sort(
      (a, b) =>
        a.name.localeCompare(b.name) ||
        catalogRawScopeToOkScope(a.provenance.scope).localeCompare(
          catalogRawScopeToOkScope(b.provenance.scope),
        ) ||
        a.home.localeCompare(b.home),
    );
}

function toPacks(bundles: SkillBundle[]): OkPack[] {
  const byName = new Map<
    string,
    {
      version: string;
      description?: string;
      author?: string;
      skills: Set<string>;
      hosts: Set<string>;
    }
  >();
  for (const b of bundles) {
    const cur = byName.get(b.packName);
    const acc = cur ?? { version: '0.0.0', skills: new Set<string>(), hosts: new Set<string>() };
    if (acc.version === '0.0.0' && b.packVersion !== '0.0.0') acc.version = b.packVersion;
    if (!acc.description && b.packDescription) acc.description = b.packDescription;
    if (!acc.author && b.packAuthor) acc.author = b.packAuthor;
    for (const s of b.skills) acc.skills.add(s.name);
    acc.hosts.add(b.harness);
    if (!cur) byName.set(b.packName, acc);
  }
  return [...byName.entries()]
    .map(([name, acc]) => ({
      schema: OK_PACK_SCHEMA_VERSION as typeof OK_PACK_SCHEMA_VERSION,
      name,
      version: acc.version,
      ...(acc.description ? { description: acc.description } : {}),
      ...(acc.author ? { author: { name: acc.author } } : {}),
      skills: [...acc.skills].sort(),
      hostCompatibility: [...acc.hosts].sort(),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function enumerateInstalledSkills(opts: EnumerateOptions = {}): InstalledSkillsResult {
  const bundles: SkillBundle[] = [];
  for (const h of harnessHomes(opts.home)) {
    try {
      switch (h.kind) {
        case 'plugin-provider':
          bundles.push(...enumeratePluginProvider(h.provider, h.dir, h.harness));
          break;
        case 'skill-dir':
          bundles.push(...enumerateSkillDir(h.dir, h.harness));
          break;
        default: {
          const _never: never = h;
          throw new Error(`unhandled harness home kind: ${String(_never)}`);
        }
      }
    } catch (err) {
      console.warn('[skills-catalog] failed to enumerate harness home, skipping', {
        harness: h.harness,
        dir: h.dir,
        err,
      });
    }
  }
  if (opts.projectDir !== undefined) {
    bundles.push(...enumerateProjectHarnessSkills(opts.projectDir));
    bundles.push(
      ...enumerateAgentPluginsRoot(resolve(opts.projectDir, 'plugins'), 'agent-plugins', {
        scope: 'project',
        projectPath: opts.projectDir,
      }),
    );
  }
  const localBundles =
    opts.projectDir === undefined
      ? bundles
      : bundles
          .map((bundle) => ({
            ...bundle,
            skills: bundle.skills.filter((skill) =>
              isDetectedSkillInProject(skill.provenance, opts.projectDir),
            ),
          }))
          .filter((bundle) => bundle.skills.length > 0);
  const raw = localBundles.flatMap((b) => b.skills);
  return { skills: dedupeSkills(raw), packs: toPacks(localBundles) };
}

function enumerateProjectHarnessSkills(projectDir: string): SkillBundle[] {
  const okSkillsRoot = realOrSelf(resolve(projectDir, '.ok', 'skills'));
  const out: SkillBundle[] = [];
  for (const h of projectHarnessHomes(projectDir)) {
    try {
      for (const bundle of enumerateSkillDir(h.dir, h.harness)) {
        const skills = bundle.skills.filter((s) => !isOkOwnedProjection(s, okSkillsRoot));
        if (skills.length === 0) continue;
        out.push({ ...bundle, skills: skills.map((s) => stampProjectScope(s, projectDir)) });
      }
    } catch (err) {
      console.warn('[skills-catalog] failed to enumerate project harness skills, skipping', {
        harness: h.harness,
        dir: h.dir,
        err,
      });
    }
  }
  return out;
}

function stampProjectScope(s: RawSkill, projectDir: string): RawSkill {
  return { ...s, provenance: { ...s.provenance, scope: 'project', projectPath: projectDir } };
}

function isOkOwnedProjection(s: RawSkill, okSkillsRoot: string): boolean {
  if (s.name.startsWith(OK_OWNED_SKILL_PREFIX)) return true;
  const real = realOrSelf(s.home);
  return real === okSkillsRoot || real.startsWith(okSkillsRoot + sep);
}

function realOrSelf(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}
