/**
 * Active-target → path / handoff-input projections for the macOS File menu's
 * state-aware items. The menu handler in `FileSidebar` reads
 * `useDocumentContext().activeTarget` and routes each menu pick through the
 * corresponding sidebar primitive — but the in-renderer surfaces (right-click
 * menus, toolbar) already carry their own per-row resolvers (the
 * `ContextMenuItem` carries the tree path; toolbar reads workspace +
 * initialCreateDir). The File menu doesn't have that ambient row context, so
 * it derives the same projections from `activeTarget` here.
 *
 * Kept pure (no React, no IPC) for unit-test coverage — each surface that
 * picks a menu item has a different scope (doc / folder / asset / project), and the
 * branching is the load-bearing logic worth pinning.
 *
 * Folder vs file scope is the discriminator the File menu cares about:
 *   - doc / folder-index → file scope (act on the doc's on-disk file)
 *   - folder → folder scope (act on the folder path)
 *   - asset → file scope (act on the asset's on-disk file)
 *   - null / missing → project scope (act on contentDir)
 *
 * `asset` intentionally stays file-scoped for Reveal / Rename / Move to
 * Trash / Copy Path. Send to AI still returns null for assets because that
 * flow is doc/folder/project scoped.
 */

import type { HandoffDispatchInput } from '@/components/handoff/useHandoffDispatch';
import {
  buildFolderHandoffInput,
  buildHandoffInput,
  buildProjectScopedHandoffInput,
} from '@/components/handoff/useHandoffDispatch';
import type { ResolvedNavigationTarget } from '@/components/navigation-targets';
import { docNameToRelativePath, joinWorkspacePath, type Workspace } from './workspace-paths';

/**
 * Resolve the absolute on-disk path for the active target's primary asset
 * (file / folder / project root). Drives Reveal in Finder + Copy Full Path.
 *
 * Falls back to `workspace.contentDir` for null / missing scopes because
 * those surfaces don't carry a concrete on-disk file the user targeted
 * directly.
 */
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

/**
 * Project-relative path string for Copy Relative Path. Doc / folder-index
 * scopes return the `.md`-suffixed relative path; folder scope returns the
 * folder path with no trailing slash; asset scope returns the asset path;
 * everything else (null / missing) returns `''` matching the contentDir-
 * itself convention.
 */
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

/**
 * Build the right `HandoffDispatchInput` for the active scope. Mirrors the
 * EditorHeader sparkle icon's input-builder cascade (file / folder / project).
 * Returns null when the workspace hasn't resolved or the scope can't
 * meaningfully dispatch (asset / missing surfaces).
 */
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
