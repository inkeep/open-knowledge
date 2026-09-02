import { WorkspaceSuccessSchema } from '@inkeep/open-knowledge-core';
import { useEffect, useState } from 'react';
import type { Workspace } from './workspace-paths';

export function useWorkspace(): Workspace | null {
  const [workspace, setWorkspace] = useState<Workspace | null>(() => resolveSyncWorkspace());

  useEffect(() => {
    if (workspace !== null) return;
    if (window.okDesktop) return;

    let active = true;
    fetch('/api/workspace')
      .then(async (res) => {
        const data = await res.json().catch(() => null);
        if (!active) return;
        if (!res.ok) return;
        const parsed = WorkspaceSuccessSchema.safeParse(data);
        if (!parsed.success) return;
        setWorkspace({
          contentDir: parsed.data.contentDir,
          pathSeparator: parsed.data.pathSeparator,
        });
      })
      .catch((err) => {
        console.warn('[useWorkspace] /api/workspace fetch failed:', err);
      });
    return () => {
      active = false;
    };
  }, [workspace]);

  return workspace;
}

export function resolveSyncWorkspace(
  windowLike: Window | undefined = typeof window === 'undefined' ? undefined : window,
): Workspace | null {
  if (!windowLike) return null;
  const okDesktop = windowLike.okDesktop;
  if (!okDesktop) return null;
  return {
    contentDir: okDesktop.config.projectPath,
    pathSeparator: okDesktop.platform === 'win32' ? '\\' : '/',
  };
}
