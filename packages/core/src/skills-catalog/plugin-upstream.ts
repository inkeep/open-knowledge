import type { CatalogSkill } from './schema.ts';

export interface PluginUpstream {
  readonly source: string;
  readonly plugin: string;
  readonly marketplace: string;
  readonly provider: string;
  readonly contentHash: string;
  readonly version?: string;
  readonly repositoryUrl?: string;
  readonly home: string;
}

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
