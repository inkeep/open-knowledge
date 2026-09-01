import {
  type CatalogSkill,
  parseSkillsShCatalogSource,
  type SkillsListEntry,
} from '@inkeep/open-knowledge-core';

export interface ProvenanceBucket {
  readonly kind: 'source' | 'plugin';
  readonly id: string;
  readonly parent?: ProvenanceParent;
  readonly publisher: string | null;
  readonly url: string | null;
}

function githubOwnerOf(url: string | null): string | null {
  if (!url) return null;
  const m = /^https?:\/\/github\.com\/([^/]+)\//.exec(`${url.replace(/\/?$/, '/')}`);
  return m?.[1] ?? null;
}

interface ProvenanceParent {
  readonly id: string;
  readonly publisher: string | null;
  readonly url: string | null;
  readonly marketplace?: true;
}

function skillsShSourceUrl(source: string): string | null {
  const parsed = parseSkillsShCatalogSource(source);
  if (parsed?.kind === 'github')
    return `https://www.skills.sh/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.repo)}`;
  if (parsed?.kind === 'site')
    return `https://www.skills.sh/site/${encodeURIComponent(parsed.hostname)}`;
  return null;
}

const PLUGIN_CACHE_RE = /\/plugins\/cache\/([^/]+)\/([^/]+)\//;
const PLUGIN_MARKETPLACE_RE = /\/plugins\/marketplaces\/([^/]+)\//;

function pluginNameFromSource(
  source: string,
): { plugin: string; marketplace: string | null } | null {
  const cache = PLUGIN_CACHE_RE.exec(source);
  if (cache) return { plugin: cache[2] as string, marketplace: cache[1] ?? null };
  const marketplace = PLUGIN_MARKETPLACE_RE.exec(source);
  return marketplace ? { plugin: marketplace[1] as string, marketplace: null } : null;
}

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

export function bucketForSkill(skill: SkillsListEntry): ProvenanceBucket | null {
  if (skill.plugin) {
    const url = skill.plugin.url?.trim() || null;
    return { kind: 'plugin', id: skill.plugin.name, publisher: githubOwnerOf(url), url };
  }
  const source = skill.origin?.source?.trim();
  if (!source) return null;

  const fromPlugin = pluginNameFromSource(source);
  if (fromPlugin) {
    const marketplace =
      fromPlugin.marketplace !== null && fromPlugin.marketplace !== fromPlugin.plugin
        ? fromPlugin.marketplace
        : null;
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

  const adopted = /^adopt:(.+)$/.exec(source)?.[1];
  if (adopted) return { kind: 'source', id: adopted, publisher: null, url: null };

  const parsed = parseSkillsShCatalogSource(source);
  const sourceBucket: ProvenanceBucket = {
    kind: 'source',
    id: sourceGroupId(source),
    publisher: skill.origin?.publisher ?? (parsed?.kind === 'github' ? parsed.owner : null),
    url: skillsShSourceUrl(source),
  };
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

export function bucketForDetected(skill: CatalogSkill): ProvenanceBucket | null {
  const plugin = skill.provenance.plugin?.trim();
  if (!plugin) return null;
  const marketplace = skill.provenance.marketplace?.trim();
  return {
    kind: 'plugin',
    id: plugin,
    publisher: null,
    url: skill.provenance.repositoryUrl?.trim() || null,
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

export function bucketKey(bucket: ProvenanceBucket): string {
  const owner = bucket.kind === 'source' ? `\u0001${bucket.publisher ?? ''}` : '';
  return `${bucket.kind}:${bucket.id}${owner}`;
}
