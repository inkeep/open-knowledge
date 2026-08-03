/**
 * Compatibility exports for renderer consumers. The desktop host contract is
 * defined by the dedicated core leaf so app and preload consumers share one
 * declaration without importing the core barrel.
 */
import type {
  OkCheckTargetExistsResult,
  OkDesktopBridge,
  OkHeadBranchInfo,
  ShareTarget,
} from '@inkeep/open-knowledge-core/desktop-bridge';

export type * from '@inkeep/open-knowledge-core/desktop-bridge';

export type CheckTargetExistsResult = OkCheckTargetExistsResult;
export type HeadBranchInfo = OkHeadBranchInfo;

export function shareTargetPath(target: ShareTarget): string {
  return target.kind === 'doc' ? target.docPath : target.folderPath;
}

declare global {
  interface Window {
    okDesktop?: OkDesktopBridge;
  }
}
