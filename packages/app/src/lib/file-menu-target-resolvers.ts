import type { HandoffDispatchInput } from '@/components/handoff/useHandoffDispatch';
import {
  buildFolderHandoffInput,
  buildHandoffInput,
  buildProjectScopedHandoffInput,
} from '@/components/handoff/useHandoffDispatch';
import type { ResolvedNavigationTarget } from '@/components/navigation-targets';
import { docNameToRelativePath, joinWorkspacePath, type Workspace } from './workspace-paths';

export function resolveActiveTargetAbsPath(
  activeTarget: ResolvedNavigationTarget | null,
  activeDocName: string | null,
  workspace: Workspace,
): string {
  if (activeTarget?.kind === 'doc' && activeDocName) {
    return joinWorkspacePath(
      workspace.contentDir,
      docNameToRelativePath(activeDocName),
      workspace.pathSeparator,
    );
  }
  if (activeTarget?.kind === 'folder-index' && activeDocName) {
    return joinWorkspacePath(
      workspace.contentDir,
      docNameToRelativePath(activeDocName),
      workspace.pathSeparator,
    );
  }
  if (activeTarget?.kind === 'folder') {
    return joinWorkspacePath(
      workspace.contentDir,
      activeTarget.folderPath,
      workspace.pathSeparator,
    );
  }
  if (activeTarget?.kind === 'asset') {
    return joinWorkspacePath(workspace.contentDir, activeTarget.assetPath, workspace.pathSeparator);
  }
  return workspace.contentDir;
}

export function resolveActiveTargetRelativePath(
  activeTarget: ResolvedNavigationTarget | null,
  activeDocName: string | null,
): string {
  if ((activeTarget?.kind === 'doc' || activeTarget?.kind === 'folder-index') && activeDocName) {
    return docNameToRelativePath(activeDocName);
  }
  if (activeTarget?.kind === 'folder') {
    return activeTarget.folderPath;
  }
  if (activeTarget?.kind === 'asset') {
    return activeTarget.assetPath;
  }
  return '';
}

export function buildSendToAiInputForActiveTarget(
  activeTarget: ResolvedNavigationTarget | null,
  activeDocName: string | null,
  workspace: Workspace | null,
): HandoffDispatchInput | null {
  if (activeTarget === null) {
    return buildProjectScopedHandoffInput({ workspace });
  }
  if (activeTarget.kind === 'folder') {
    if (!workspace) return null;
    return buildFolderHandoffInput({
      folderRelativePath: activeTarget.folderPath,
      workspace,
    });
  }
  if (activeTarget.kind === 'doc' || activeTarget.kind === 'folder-index') {
    return buildHandoffInput({ docName: activeDocName, workspace });
  }
  return null;
}
