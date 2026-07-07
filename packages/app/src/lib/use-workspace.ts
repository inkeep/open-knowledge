import { WorkspaceSuccessSchema } from '@inkeep/open-knowledge-core';
import { useEffect, useState } from 'react';
import type { Workspace } from './workspace-paths';

/**
 * Host-aware workspace info — the absolute `contentDir` and OS path separator.
 *
 * On **Electron** hosts (`window.okDesktop` present): resolved synchronously
 * from `window.okDesktop.config.projectPath` + `platform`. Returns a
 * populated `Workspace` on the first render.
 *
 * On **web** hosts (no `window.okDesktop`): fetches `/api/workspace` (loopback-
 * only; see `handleWorkspace` in `packages/server/src/api-extension.ts`).
 * Returns `null` while the fetch is pending. Callers should treat `null` as
 * "workspace not yet known" and render disabled UI (e.g. the handoff dropdown
 * trigger disables until we can build an absolute `docPath`).
 *
 * The fetch is fire-once per mount — `contentDir` is stable for a session, so
 * no refresh or subscription is needed. Matches FileTree's existing workspace-
 * fetch shape so the two surfaces stay in lockstep.
 */
export function useWorkspace(): Workspace | null {
  const [workspace, setWorkspace] = useState<Workspace | null>(() => resolveSyncWorkspace());

  useEffect(() => {
    if (workspace !== null) return; // Electron path — already resolved synchronously.
    if (window.okDesktop) return; // Belt-and-braces: never fetch when a bridge is present.

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
    // The effect re-runs after a successful fetch (workspace dep flips from null
    // to non-null); the `workspace !== null` guard short-circuits the second
    // pass so the fetch fires exactly once.
  }, [workspace]);

  return workspace;
}

/**
 * Pure Electron-host resolver. Returns `null` on web / SSR / no-bridge contexts.
 * Extracted so tests (and `useInstalledAgents.isElectronHostDefault`) share the
 * same host-detection shape.
 */
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
