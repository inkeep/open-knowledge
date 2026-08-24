/**
 * Index the skills a harness PLUGIN ships, so a project's own copy of one can
 * name where it came from.
 *
 * A repo that fans plugin skills into `.agents/skills/` has already performed
 * the copy the UI calls "edit a copy", but nothing records the relationship —
 * so a copy of a plugin's skill is indistinguishable from a hand-authored one.
 * This is the lookup that makes it distinguishable; the caller turns a hit into
 * a synthesized lock entry (never a written one, matching how OK's own built-in
 * bundles get an origin they never had recorded).
 *
 * Pure so it can be tested without a plugin cache on disk: enumeration and
 * hashing are the caller's, this is only the join.
 */

import type { CatalogSkill } from './schema.ts';

/** One plugin-provided skill, reduced to what an origin needs. */
export interface PluginUpstream {
  /** `<plugin>@<marketplace>` — the import identity an origin reports. */
  readonly source: string;
  /** The two halves of `source`, for consumers that need them un-joined. */
  readonly plugin: string;
  readonly marketplace: string;
  /** The harness whose plugin system serves this bundle (e.g. `claude`). */
  readonly provider: string;
  /** Hash of the PLUGIN's bundle. Doubles as the local baseline, so "modified"
   *  reads as "your copy no longer matches the plugin". */
  readonly contentHash: string;
  readonly version?: string;
  readonly repositoryUrl?: string;
  /** The plugin's bundle dir — where the hash and the timestamp come from. */
  readonly home: string;
}

/**
 * Build `name → upstream` for every PLUGIN-provided skill in a detected catalog.
 *
 * `hashOf` resolves a bundle dir to its content hash; an entry whose hash cannot
 * be read is dropped rather than indexed with an empty one, because a blank hash
 * would make every local copy read as diverged from it.
 *
 * Bare skill dirs are excluded on purpose. They carry no plugin provenance, and
 * their copies are already first-class rows elsewhere — treating one as an
 * upstream would let a skill become its own origin.
 *
 * First writer wins for a duplicated name. The `/api/skills` index is built from
 * the machine-wide enumeration (a copy of a plugin's skill is that plugin's
 * wherever the copy sits, and the registry keys project installs by checkout
 * path), while `/api/skills/installed` stays project-scoped, so name-only
 * consumers may resolve a different plugin for a name than the detected list
 * would. That covers more than the Modified badge: the synthesized lock entry's
 * source is the plugin cache dir, and a reimport fetches from it, so a name
 * collision across project-scoped plugins on one machine could overwrite a
 * hand-authored skill in another project on an explicit reimport. The
 * realpath-verified identity path is unaffected.
 */
export function pluginUpstreamsByName(
  skills: readonly CatalogSkill[],
  hashOf: (home: string) => string | undefined,
): Map<string, PluginUpstream> {
  const byName = new Map<string, PluginUpstream>();
  for (const skill of skills) {
    const plugin = skill.provenance.plugin;
    const marketplace = skill.provenance.marketplace;
    if (!plugin || !marketplace) continue;
    if (byName.has(skill.name)) continue;
    const contentHash = hashOf(skill.home);
    if (!contentHash) continue;
    byName.set(skill.name, {
      source: `${plugin}@${marketplace}`,
      plugin,
      marketplace,
      provider: skill.sourceHarness,
      contentHash,
      ...(skill.provenance.version !== undefined ? { version: skill.provenance.version } : {}),
      ...(skill.provenance.repositoryUrl !== undefined
        ? { repositoryUrl: skill.provenance.repositoryUrl }
        : {}),
      home: skill.home,
    });
  }
  return byName;
}
