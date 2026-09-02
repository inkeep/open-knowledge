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
