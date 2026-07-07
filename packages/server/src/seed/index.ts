/**
 * Public entry point for the `ok seed` shared module.
 *
 * Consumed by:
 *   - `packages/cli/src/commands/seed.ts` — Commander CLI wrapper
 *   - `packages/desktop/src/main/ipc/seed.ts` — Electron IPC handler
 *   - `packages/server/src/index.ts` — re-exported for external workspace consumers
 *
 */

export { applySeed } from './apply.ts';
export { planSeed } from './plan.ts';
export { formatPackRationale } from './rationale.ts';
export {
  buildStarterFolderFrontmatterYaml,
  coercePackId,
  DEFAULT_PACK_ID,
  isKnownPackId,
  // Back-compat public export; new code should read STARTER_PACKS['knowledge-base'].
  // oxlint-disable-next-line typescript/no-deprecated
  LOG_MD_TEMPLATE,
  listStarterPacks,
  type PackId,
  resolvePack,
  STARTER_FOLDER_FRONTMATTER_FILENAME,
  // Back-compat public export; new code should read STARTER_PACKS['knowledge-base'].
  // oxlint-disable-next-line typescript/no-deprecated
  STARTER_FOLDERS,
  STARTER_PACK_IDS,
  STARTER_PACKS,
  // Back-compat public export; new code should read STARTER_PACKS['knowledge-base'].
  // oxlint-disable-next-line typescript/no-deprecated
  STARTER_TEMPLATES,
  type StarterFolder,
  type StarterPack,
  type StarterPackEntryCounts,
  type StarterPackFolderInfo,
  type StarterPackInfo,
} from './starter.ts';
export type {
  ApplyError,
  ApplyResult,
  FileEntry,
  ScaffoldPlan,
  SeedOptions,
  SkipEntry,
} from './types.ts';
export { SeedPrerequisiteError, SeedRootDirError } from './types.ts';
