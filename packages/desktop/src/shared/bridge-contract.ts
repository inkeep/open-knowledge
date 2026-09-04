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
