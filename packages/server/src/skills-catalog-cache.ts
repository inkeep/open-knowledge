import {
  enumerateInstalledSkills,
  type PluginUpstream,
  parseSkillDir,
  pluginUpstreamsByName,
} from '@inkeep/open-knowledge-core/skills-catalog';
import type { PinoLogger } from './logger.ts';

export type SkillsCatalogCache = ReturnType<typeof createSkillsCatalogCache>;

export function createSkillsCatalogCache({
  homeDirOverride,
  log,
}: {
  homeDirOverride: string | undefined;
  log: PinoLogger;
}) {
  let skillsCatalogGen = 0;
  let skillsListCache: { at: number; gen: number; fp: string; body: unknown } | null = null;
  let installedCatalogCache: {
    at: number;
    gen: number;
    key: string;
    value: ReturnType<typeof enumerateInstalledSkills>;
  } | null = null;
  function bumpSkillsCatalogGen(): void {
    skillsCatalogGen += 1;
  }
  function lookupInstalledSkillsCached(opts: Parameters<typeof enumerateInstalledSkills>[0]): {
    freshBuild: boolean;
    key: string;
    value: ReturnType<typeof enumerateInstalledSkills>;
  } {
    const key = `${opts?.projectDir ?? ''}|${opts && 'home' in opts ? opts.home : ''}`;
    const now = Date.now();
    if (
      installedCatalogCache !== null &&
      installedCatalogCache.gen === skillsCatalogGen &&
      installedCatalogCache.key === key &&
      now - installedCatalogCache.at < 5_000
    ) {
      return { freshBuild: false, key, value: installedCatalogCache.value };
    }
    const value = enumerateInstalledSkills(opts);
    installedCatalogCache = { at: Date.now(), gen: skillsCatalogGen, key, value };
    return { freshBuild: true, key, value };
  }

  function enumerateInstalledSkillsCached(
    opts: Parameters<typeof enumerateInstalledSkills>[0],
  ): ReturnType<typeof enumerateInstalledSkills> {
    return lookupInstalledSkillsCached(opts).value;
  }

  function readList(inPlaceFp: string): { readonly body: unknown } | null {
    if (skillsListCache !== null && skillsListCache.fp !== inPlaceFp) {
      bumpSkillsCatalogGen();
    }
    if (
      skillsListCache !== null &&
      skillsListCache.gen === skillsCatalogGen &&
      skillsListCache.fp === inPlaceFp &&
      Date.now() - skillsListCache.at < 5_000
    ) {
      return { body: skillsListCache.body };
    }
    return null;
  }

  function writeList(inPlaceFp: string, responseBody: unknown): void {
    skillsListCache = {
      at: Date.now(),
      gen: skillsCatalogGen,
      fp: inPlaceFp,
      body: responseBody,
    };
  }

  const PLUGIN_INDEX_TTL_MS = 30_000;
  let pluginIndex: { at: number; identity: string; byName: Map<string, PluginUpstream> } | null =
    null;

  function pluginSkillsByName(identity: string): Map<string, PluginUpstream> {
    const now = Date.now();
    if (
      pluginIndex &&
      pluginIndex.identity === identity &&
      now - pluginIndex.at < PLUGIN_INDEX_TTL_MS
    )
      return pluginIndex.byName;
    let byName = new Map<string, PluginUpstream>();
    let catalogLookup: ReturnType<typeof lookupInstalledSkillsCached> | null = null;
    try {
      catalogLookup = lookupInstalledSkillsCached(
        homeDirOverride !== undefined
          ? { home: homeDirOverride, projectDir: identity }
          : { projectDir: identity },
      );
      byName = pluginUpstreamsByName(
        catalogLookup.value.skills,
        (home) => parseSkillDir(home)?.contentHash,
      );
    } catch (err) {
      log.warn({ err }, 'plugin upstream index failed; origins will be omitted');
    }
    const completedAt = Date.now();
    if (
      catalogLookup?.freshBuild === true &&
      installedCatalogCache?.gen === skillsCatalogGen &&
      installedCatalogCache.key === catalogLookup.key &&
      installedCatalogCache.value === catalogLookup.value
    ) {
      installedCatalogCache.at = completedAt;
    }
    pluginIndex = { at: completedAt, identity, byName };
    return byName;
  }

  return {
    bumpSkillsCatalogGen,
    enumerateInstalledSkillsCached,
    readList,
    writeList,
    pluginSkillsByName,
  };
}
