/**
 * Node-only subpath barrel: `@inkeep/open-knowledge-core/skills-catalog`.
 *
 * The enumerator reads the filesystem (node:fs/os/path), so it is kept OUT of
 * the browser-safe root `index.ts` barrel and consumed via this subpath by the
 * server + CLI — mirroring `@inkeep/open-knowledge-core/server`. The pure
 * skill/Pack schemas stay in the root barrel (browser-safe, zod only).
 */

export {
  ALLOWED_GIT_TRANSPORTS,
  type Fetched,
  fetchSource,
  parseSkillsShSource,
  parseSource,
  SkillFetchError,
  type SkillsShSourceRef,
  type SourceSpec,
} from './acquire/fetch.ts';
export {
  emptySkillsLock,
  findByContentHash,
  parseSkillsLock,
  retrofitPackLockEntry,
  SKILLS_LOCK_FILENAME,
  SKILLS_LOCK_REL,
  SKILLS_LOCK_SCHEMA_VERSION,
  type SkillLockEntry,
  SkillLockEntrySchema,
  type SkillsLock,
  SkillsLockSchema,
  upsertLockEntry,
} from './acquire/lockfile.ts';
export {
  type AcquiredFile,
  type AcquiredSkill,
  acquiredBundleTooLarge,
  discoverSkillDirs,
  parseSkillDir,
  readSkillDirMeta,
} from './acquire/parse.ts';
export {
  parseSkillsShWebsiteSource,
  type ResolvedSkillsShImportSource,
  resolveSkillsShImportSource,
  type SkillsShWebsiteSource,
} from './acquire/skills-sh.ts';
export {
  discoverWellKnownSkills,
  type FetchedWellKnownSkill,
  fetchWellKnownSkill,
  readWellKnownIndex,
  type WellKnownFetchOptions,
  type WellKnownIndex,
  type WellKnownSkillSummary,
  type WellKnownSourceSpec,
} from './acquire/well-known.ts';
export {
  groupSkillsByIdentity,
  SKILL_CANONICAL_PRECEDENCE,
  type SkillHostId,
  type SkillIdentityGroup,
  type SkillOccurrence,
} from './dedup.ts';
export {
  type EnumerateOptions,
  enumerateInstalledSkills,
  type InstalledSkillsResult,
} from './enumerate.ts';
export { harnessHomes, userGlobalSkillRoots } from './harness-homes.ts';
export {
  SKILL_IMPORT_MAX_BUNDLE_FILES,
  SKILL_IMPORT_MAX_FILE_BYTES,
  SKILL_IMPORT_MAX_TOTAL_BYTES,
} from './import-limits.ts';
export {
  parseSkillsShLeaderboard,
  parseSkillsShLeaderboardCards,
} from './leaderboard.ts';
export {
  enumeratePluginProvider,
  inspectPluginBundleDir,
  inspectPluginSource,
  pluginRepositoryUrl,
  resolvePluginUpdateSource,
} from './plugin-providers/registry.ts';
export type {
  PluginBundleInspection,
  PluginCapabilities,
  PluginProviderAdapter,
  PluginProviderId,
  PluginSourceInspection,
} from './plugin-providers/types.ts';
export { parseGitHubRepoSearch, parseOpenGraph, parseSkillsShSearch } from './search.ts';
export {
  buildSkillRegistry,
  type LocatedSkillOccurrence,
  type SkillRegistry,
  skillRegistryKey,
} from './skill-registry.ts';
export {
  ownerOf,
  parseSkillsShCatalogSource,
  type SkillsShCatalogSource,
  type SkillsShSkillLinks,
  skillsShSkillLinks,
  slug,
} from './source-fields.ts';
