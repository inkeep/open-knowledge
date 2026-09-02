import type { HandoffDispatchInput } from '@/components/handoff/useHandoffDispatch';
import {
  buildFolderHandoffInput,
  buildHandoffInput,
  buildProjectScopedHandoffInput,
  buildSkillHandoffInput,
} from '@/components/handoff/useHandoffDispatch';
import type { ResolvedNavigationTarget } from '@/components/navigation-targets';
import { docNameToRelativePath, joinWorkspacePath, type Workspace } from './workspace-paths';

export function resolveActiveTargetAbsPath(
  activeTarget: ResolvedNavigationTarget | null,
  workspace: Workspace,
): string {
  if (activeTarget?.kind === 'doc') {
    return joinWorkspacePath(
      workspace.contentDir,
      docNameToRelativePath(activeTarget.docName),
      workspace.pathSeparator,
    );
  }
  if (activeTarget?.kind === 'folder-index') {
    return joinWorkspacePath(
      workspace.contentDir,
      docNameToRelativePath(activeTarget.docName),
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
): string {
  if (activeTarget?.kind === 'doc' || activeTarget?.kind === 'folder-index') {
    return docNameToRelativePath(activeTarget.docName);
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
    return buildHandoffInput({ docName: activeTarget.docName, workspace });
  }
  if (activeTarget.kind === 'skill-preview') {
    return buildSkillHandoffInput({
      skillName: activeTarget.name,
      scope: activeTarget.level ?? 'project',
      workspace,
    });
  }
  if (activeTarget.kind === 'skill-file') {
    return buildSkillHandoffInput({
      skillName: activeTarget.name,
      scope: activeTarget.scope,
      workspace,
    });
  }
  return null;
}
