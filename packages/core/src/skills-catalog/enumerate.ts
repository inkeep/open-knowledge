/**
 * `enumerateInstalledSkills()` — the read-only, cross-harness foundation the
 * whole marketplace builds on. Runs each harness adapter, normalizes every
 * skill to the open `CatalogSkill` shape, de-dupes the same skill across
 * harnesses into one entry (the `skills.sh` fan-out lands one skill in many
 * homes), and groups source bundles into `OkPack` envelopes.
 *
 * Robustness contract: a missing/empty home is skipped; a malformed skill is
 * skipped (or degraded to its dir name) — never abort the whole run. A machine
 * with nothing installed returns `{ skills: [], packs: [] }`.
 */

import { realpathSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { parseSkillDir } from './acquire/parse.ts';
import type { RawSkill, SkillBundle } from './adapters/shared.ts';
import { enumerateSkillDir } from './adapters/skill-dir.ts';
import { harnessHomes, projectHarnessHomes } from './harness-homes.ts';
import { enumeratePluginProvider } from './plugin-providers/registry.ts';
import type { CatalogSkill, OkPack } from './schema.ts';
import { OK_PACK_SCHEMA_VERSION } from './schema.ts';
import { catalogRawScopeToOkScope, isDetectedSkillInProject } from './scope.ts';

export interface EnumerateOptions {
  /** User home dir to resolve harness homes under. Defaults to the real one. */
  home?: string;
  /**
   * Open project root. When set, ALSO scan `<projectDir>/.<harness>/skills` for
   * every harness (the only project source for non-Claude harnesses), stamping
   * each as `scope:'project'` bound to this dir so the project/global classifier
   * keeps it here. Pass the SAME value the caller filters with
   * (`isDetectedSkillInProject(..., projectDir)`) — for a git worktree that is
   * the parent-checkout identity, so project scans and plugin records agree.
   */
  projectDir?: string;
}

/** OK's own shipped skills — surfaced via the excluded `/api/skills` surface, not as Detected rows. */
const OK_OWNED_SKILL_PREFIX = 'open-knowledge';

export interface InstalledSkillsResult {
  skills: CatalogSkill[];
  packs: OkPack[];
}

/** True when a raw skill carries any provenance (i.e. a Claude plugin source, or a project stamp). */
function hasProvenance(s: RawSkill): boolean {
  return Object.keys(s.provenance).length > 0;
}

/**
 * True when a raw skill came from a Claude PLUGIN (carries the rich
 * `plugin`/`marketplace`/`version` provenance), as opposed to a bare skill-dir
 * or a project-scan stamp (which only carry `scope`/`projectPath`). Preferred by
 * `pickWinner` so a plugin instance still wins the de-dupe over a same-named
 * project-dir copy now that project scans stamp provenance too.
 */
function isPluginSourced(s: RawSkill): boolean {
  return s.provenance.plugin !== undefined;
}

/** Pick the richest instance to represent a de-duped skill: plugin > any provenance > more files > first. */
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

/**
 * Collapse only identical skill occurrences. Scope and project binding are part
 * of identity, and same-named bundles with different bytes remain distinct.
 */
function dedupeSkills(raw: RawSkill[]): CatalogSkill[] {
  const byIdentity = new Map<string, { winner: RawSkill; harnesses: Set<string> }>();
  for (const s of raw) {
    const scope = catalogRawScopeToOkScope(s.provenance.scope);
    const projectPath = scope === 'project' ? (s.provenance.projectPath ?? '') : '';
    // A bundle that vanished or became unreadable during enumeration must not
    // merge with another occurrence merely because both hashes are unavailable.
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

/** Group bundles into Packs, de-duped by pack name (a bare skill in N homes → one Pack). */
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
    // First concrete version wins; first description/author wins.
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

/**
 * Enumerate every installed skill across all known harness homes. Pure read —
 * no home is mutated. Returns sorted, de-duped skills + their Pack envelopes.
 */
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
          // A new HarnessHomeKind must add a branch here, not silently
          // fall through to one adapter. Throw (not return) so an unhandled
          // kind fails loud instead of returning undefined from this function.
          const _never: never = h;
          throw new Error(`unhandled harness home kind: ${String(_never)}`);
        }
      }
    } catch (err) {
      // One bad home never aborts the cross-harness read, but log so an
      // operator can tell an EACCES/malformed home apart from "nothing installed".
      console.warn('[skills-catalog] failed to enumerate harness home, skipping', {
        harness: h.harness,
        dir: h.dir,
        err,
      });
    }
  }
  if (opts.projectDir !== undefined) {
    bundles.push(...enumerateProjectHarnessSkills(opts.projectDir));
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

/**
 * Scan `<projectDir>/.<harness>/skills` for every bare-skill-dir harness and
 * return the discovered skills stamped `scope:'project'` bound to `projectDir`.
 *
 * The stamp is load-bearing: the `skill-dir` adapter records no provenance, and
 * `catalogRawScopeToOkScope(undefined)` → `'global'`, so an un-stamped project
 * skill would surface in EVERY project. Stamping it as project-scoped (with the
 * same `projectDir` the server filters against) keeps it exactly here.
 *
 * OK's OWN projections are excluded: OK writes `.claude/skills/<name>` etc. as
 * symlinks into `<projectDir>/.ok/skills` (skill-projection.ts), whose canonical
 * home is the separate `/api/skills` surface — surfacing them here would
 * double-list OK's managed skills as Detected rows. A skill whose realpath
 * resolves under `.ok/skills`, or that carries OK's reserved shipped-bundle name
 * prefix, is dropped.
 */
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

/** Stamp a project-scanned skill so the project/global classifier keeps it here. */
function stampProjectScope(s: RawSkill, projectDir: string): RawSkill {
  return { ...s, provenance: { ...s.provenance, scope: 'project', projectPath: projectDir } };
}

/** True when a project-scanned skill is one of OK's own projections (link into `.ok/skills`, or a shipped bundle). */
function isOkOwnedProjection(s: RawSkill, okSkillsRoot: string): boolean {
  if (s.name.startsWith(OK_OWNED_SKILL_PREFIX)) return true;
  const real = realOrSelf(s.home);
  return real === okSkillsRoot || real.startsWith(okSkillsRoot + sep);
}

/** `realpathSync`, or the resolved input when the path can't be resolved (broken link / gone). */
function realOrSelf(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}
