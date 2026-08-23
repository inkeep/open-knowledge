import {
  type CatalogSkill,
  parseSkillsShCatalogSource,
  type SkillsListEntry,
} from '@inkeep/open-knowledge-core';

/**
 * Where a skill came from, reduced to the one key the sidebar groups on.
 *
 * Grouping is an OK-side navigation aid and nothing more. No grouping survives
 * install: every harness flattens a bundle to `<root>/<name>/SKILL.md`, and only
 * Claude namespaces anything (by plugin). So this key exists to make a long list
 * readable, not to mirror what an agent sees.
 *
 * `null` means ungrouped — a skill you authored here. That is the default state
 * and carries no label, exactly as your own files carry none in the file tree;
 * only content from elsewhere gets a row naming where it came from.
 */
export interface ProvenanceBucket {
  /** `plugin` rows keep their namespace when flattened; `source` rows do not. */
  readonly kind: 'source' | 'plugin';
  /** The group's label, and half its identity. */
  readonly id: string;
  /**
   * The tier ABOVE this group, when the skill's provenance carries two levels:
   * the repo/marketplace it was distributed through (parent) over the
   * pack/plugin it belongs to (this bucket). The tree nests parent → child →
   * skills when the parent would hold more than one row; a parent of one
   * collapses away and the child renders alone.
   */
  readonly parent?: ProvenanceParent;
  /** GitHub login behind the publisher avatar; absent for a source we cannot resolve. */
  readonly publisher: string | null;
  /**
   * Where the group's mark goes, or `null` for nowhere.
   *
   * An imported source resolves to its skills.sh page; a plugin resolves to the
   * marketplace repo the harness registry recorded, stamped onto provenance at
   * enumeration (a client cannot derive it — the marketplace NAME is a local
   * alias that addresses nothing). Null is a real case either way: a local path,
   * a bare git URL, or a marketplace installed from a directory.
   */
  readonly url: string | null;
}

/** GitHub owner segment of a repo URL, or null — the parent tier's avatar. */
function githubOwnerOf(url: string | null): string | null {
  if (!url) return null;
  const m = /^https?:\/\/github\.com\/([^/]+)\//.exec(`${url.replace(/\/?$/, '/')}`);
  return m?.[1] ?? null;
}

/** The distribution tier above a plugin/pack bucket — a repo or marketplace. */
interface ProvenanceParent {
  readonly id: string;
  readonly publisher: string | null;
  readonly url: string | null;
  /**
   * True when `id` is a harness-registry marketplace NAME rather than a repo
   * tail. Registry names are unique per installation, so two marketplace
   * parents sharing an id are provably the same marketplace — the one case
   * where a publisher-less population may adopt a sibling's known owner. Repo
   * tails carry no such guarantee (a bare-URL import whose tail matches
   * someone's owner/repo shorthand is not provably that repo) and never adopt.
   */
  readonly marketplace?: true;
}

/** The skills.sh page for a SOURCE (not a skill): the group row names the source,
 *  so it lands on the source, and `skillsShSkillLinks` only builds per-skill URLs. */
function skillsShSourceUrl(source: string): string | null {
  const parsed = parseSkillsShCatalogSource(source);
  if (parsed?.kind === 'github')
    return `https://www.skills.sh/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.repo)}`;
  if (parsed?.kind === 'site')
    return `https://www.skills.sh/site/${encodeURIComponent(parsed.hostname)}`;
  return null;
}

/** Recognises a plugin-cache path and names the plugin that owns it. */
const PLUGIN_CACHE_RE = /\/plugins\/cache\/([^/]+)\/([^/]+)\//;
const PLUGIN_MARKETPLACE_RE = /\/plugins\/marketplaces\/([^/]+)\//;

/**
 * A plugin the skill was copied OUT of still counts as that plugin's, which is
 * why this reads the raw source rather than only `provenance.plugin`: the copy's
 * lockfile source is the plugin-cache dir it came from. `use-skill-origin`
 * derives its "From the {plugin} plugin" label the same way, so a copy lands
 * back in the group holding the originals.
 */
function pluginNameFromSource(
  source: string,
): { plugin: string; marketplace: string | null } | null {
  const cache = PLUGIN_CACHE_RE.exec(source);
  if (cache) return { plugin: cache[2] as string, marketplace: cache[1] ?? null };
  const marketplace = PLUGIN_MARKETPLACE_RE.exec(source);
  return marketplace ? { plugin: marketplace[1] as string, marketplace: null } : null;
}

/**
 * The repo half of an `owner/repo` source, which is what a skills.sh listing is
 * addressed by. Falls back to the whole trimmed source so a self-hosted git URL
 * or a local path still buckets with its siblings under a stable, if uglier, id.
 */
function sourceGroupId(source: string): string {
  const parsed = parseSkillsShCatalogSource(source);
  if (parsed?.kind === 'github') return parsed.repo;
  if (parsed?.kind === 'site') return parsed.hostname;
  const trimmed = source
    .trim()
    .replace(/\.git$/, '')
    .replace(/\/+$/, '');
  const tail = trimmed.split('/').filter(Boolean).pop();
  return tail && tail.length > 0 ? tail : trimmed;
}

/**
 * Bucket for a managed (OK-tracked) skill. Built-ins are NOT special-cased: they
 * publish to `inkeep/open-knowledge-skills` like anything else and carry a lock
 * entry saying so, so they bucket under that source and only their lock glyph
 * marks them apart. A skill with no lock entry — hand-authored, or a project
 * whose skills are checked in rather than seeded — is ungrouped.
 */
export function bucketForSkill(skill: SkillsListEntry): ProvenanceBucket | null {
  // Identity first: a skill that IS a plugin's skill (served in place from a
  // directory-sourced marketplace) groups under that plugin exactly like the
  // plugin's cache residents do — same kind, same id, so the two populations
  // can never split into twin groups.
  if (skill.plugin) {
    const url = skill.plugin.url?.trim() || null;
    return { kind: 'plugin', id: skill.plugin.name, publisher: githubOwnerOf(url), url };
  }
  const source = skill.origin?.source?.trim();
  if (!source) return null;

  const fromPlugin = pluginNameFromSource(source);
  if (fromPlugin) {
    // A single-plugin marketplace names the marketplace after the plugin
    // (`ponytail@ponytail`) — a parent tier repeating the child's name is
    // noise, so it collapses away.
    const marketplace =
      fromPlugin.marketplace !== null && fromPlugin.marketplace !== fromPlugin.plugin
        ? fromPlugin.marketplace
        : null;
    // The server resolves the marketplace's repo from the harness registry
    // (`known_marketplaces.json`) at list time, so a cache-copied skill's
    // parent owner is verified data — not a client-side inference.
    const url = skill.origin?.marketplaceUrl?.trim() || null;
    return {
      kind: 'plugin',
      id: fromPlugin.plugin,
      publisher: null,
      url,
      ...(marketplace !== null
        ? {
            parent: {
              id: marketplace,
              publisher: githubOwnerOf(url),
              url,
              marketplace: true as const,
            },
          }
        : {}),
    };
  }

  // `adopt:<harness>` is a copy of an editor's own skill with no fetchable
  // remote. It names a harness, not a publisher, so it groups by that name.
  const adopted = /^adopt:(.+)$/.exec(source)?.[1];
  if (adopted) return { kind: 'source', id: adopted, publisher: null, url: null };

  // Only an `owner/repo` shorthand yields a trustworthy login. A URL or a local
  // path has no owner segment — `ownerOf` would hand back `https:` or a home
  // directory — so those get no publisher and no avatar, and the row's trailing
  // arrow is what discloses that it still goes somewhere.
  const parsed = parseSkillsShCatalogSource(source);
  const sourceBucket: ProvenanceBucket = {
    kind: 'source',
    id: sourceGroupId(source),
    publisher: skill.origin?.publisher ?? (parsed?.kind === 'github' ? parsed.owner : null),
    url: skillsShSourceUrl(source),
  };
  // A `metadata.pack` marker names the pack/plugin WITHIN the source repo —
  // the child tier. The repo stays the parent, so several packs from one repo
  // collect under it instead of pooling into one undifferentiated group.
  if (skill.pack !== undefined && skill.pack.trim().length > 0) {
    return {
      kind: 'plugin',
      id: skill.pack.trim(),
      publisher: null,
      url: sourceBucket.url,
      parent: { id: sourceBucket.id, publisher: sourceBucket.publisher, url: sourceBucket.url },
    };
  }
  return sourceBucket;
}

/**
 * Bucket for a DETECTED skill — one OK found in another tool but does not track.
 * Only Claude populates plugin provenance ("rich for Claude plugins; empty for
 * bare skill-dirs"), so off Claude this returns `null` for everything and the
 * tree simply shows no plugin groups.
 */
export function bucketForDetected(skill: CatalogSkill): ProvenanceBucket | null {
  const plugin = skill.provenance.plugin?.trim();
  if (!plugin) return null;
  const marketplace = skill.provenance.marketplace?.trim();
  return {
    kind: 'plugin',
    id: plugin,
    publisher: null,
    url: skill.provenance.repositoryUrl?.trim() || null,
    // The marketplace the plugin was installed through is the tier above it —
    // six sibling plugin cubes from one marketplace collect under one parent.
    // A single-plugin marketplace named after its plugin collapses away.
    ...(marketplace && marketplace !== plugin
      ? {
          parent: {
            id: marketplace,
            publisher: githubOwnerOf(skill.provenance.repositoryUrl?.trim() || null),
            url: skill.provenance.repositoryUrl?.trim() || null,
            marketplace: true as const,
          },
        }
      : {}),
  };
}

/** Stable identity for a bucket within one scope. Deliberately EXCLUDES the
 *  parent tier: a managed copy knows its marketplace while the detected
 *  resident of the same plugin may not, and a parent-aware key would split
 *  those populations into twin groups — the exact bug kind:id exists to
 *  prevent. A SOURCE bucket's key DOES include its publisher: the id is only
 *  the repo TAIL, and two owners' repos sharing a tail (anthropics/skills vs
 *  mattpocock/skills) are different sources that must never merge. Plugin
 *  buckets keep publisher out of the key — it is always null there, and the
 *  copy/resident populations must keep matching. */
export function bucketKey(bucket: ProvenanceBucket): string {
  const owner = bucket.kind === 'source' ? `\u0001${bucket.publisher ?? ''}` : '';
  return `${bucket.kind}:${bucket.id}${owner}`;
}
