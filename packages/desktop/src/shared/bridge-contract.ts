/**
 * Compatibility exports for desktop consumers. The renderer-facing host
 * contract is defined in the dedicated core leaf; this path remains stable
 * for existing main and preload imports.
 */
import type {
  OkCheckTargetExistsResult,
  OkDesktopBridge,
  OkHeadBranchInfo,
  OkSeedApplyOptions,
  OkSeedPlanOptions,
} from '@inkeep/open-knowledge-core/desktop-bridge';

export type * from '@inkeep/open-knowledge-core/desktop-bridge';

export type CheckTargetExistsResult = OkCheckTargetExistsResult;
export type HeadBranchInfo = OkHeadBranchInfo;
export type SeedPlanOptions = OkSeedPlanOptions;
export type SeedApplyOptions = OkSeedApplyOptions;

declare global {
  interface Window {
    okDesktop?: OkDesktopBridge;
  }
}
