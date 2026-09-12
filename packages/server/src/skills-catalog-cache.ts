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
  function enumerateInstalledSkillsCached(
    opts: Parameters<typeof enumerateInstalledSkills>[0],
  ): ReturnType<typeof enumerateInstalledSkills> {
    const key = `${opts?.projectDir ?? ''}|${opts && 'home' in opts ? opts.home : ''}`;
    const now = Date.now();
    if (
      installedCatalogCache !== null &&
      installedCatalogCache.gen === skillsCatalogGen &&
      installedCatalogCache.key === key &&
      now - installedCatalogCache.at < 5_000
    ) {
      return installedCatalogCache.value;
    }
    const value = enumerateInstalledSkills(opts);
    installedCatalogCache = { at: now, gen: skillsCatalogGen, key, value };
    return value;
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
    try {
      byName = pluginUpstreamsByName(
        enumerateInstalledSkillsCached(
          homeDirOverride !== undefined ? { home: homeDirOverride } : {},
        ).skills,
        (home) => parseSkillDir(home)?.contentHash,
      );
    } catch (err) {
      log.warn({ err }, 'plugin upstream index failed; origins will be omitted');
    }
    pluginIndex = { at: now, identity, byName };
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
