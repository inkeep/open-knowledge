/**
 * Resolves the project identity (name + path + branch) shown in the editor
 * footer when the ProjectSwitcher isn't visible — sidebar collapsed or
 * non-Electron host. Returns `null` when the switcher IS visible (Electron +
 * expanded sidebar), so the footer skips the row entirely.
 *
 * Project name + path prefer the Electron bridge; on web they derive from
 * `useWorkspace().contentDir` (basename + raw path).
 */
import { useSidebar } from '@/components/ui/sidebar';
import { useCurrentBranch } from '@/hooks/use-current-branch';
import { extractFolderBasename } from '@/lib/path-utils';
import { useWorkspace } from '@/lib/use-workspace';

export interface EditorFooterIdentity {
  projectName: string | null;
  projectPath: string | null;
  branch: string | null;
}

export function useEditorFooterIdentity(): EditorFooterIdentity | null {
  const branch = useCurrentBranch();
  const workspace = useWorkspace();
  const { state: sidebarState } = useSidebar();
  const desktopBridge = typeof window !== 'undefined' ? window.okDesktop : undefined;
  const projectSwitcherVisible = desktopBridge && sidebarState === 'expanded';

  if (projectSwitcherVisible) return null;

  const projectName =
    desktopBridge?.config.projectName ??
    (workspace ? extractFolderBasename(workspace.contentDir) || null : null);
  const projectPath = desktopBridge?.config.projectPath ?? workspace?.contentDir ?? null;

  if (projectName === null && branch === null) return null;
  return { projectName, projectPath, branch };
}
