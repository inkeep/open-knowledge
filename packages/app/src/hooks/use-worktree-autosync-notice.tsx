/**
 * One-time toast telling the user a newly-opened worktree INHERITED the root
 * project's git sync setting (so the inheritance isn't silent).
 *
 * When a worktree is created, `seedWorktreeAutoSync` (desktop main) seeds the
 * worktree's project-local `autoSync.mode` from the root's resolved choice and
 * arms a one-shot `autoSync.inheritedNoticePending: true` flag (plus
 * `autoSync.inheritedFrom: <project>`) — both loose keys on the `autoSync`
 * `looseObject`, so no schema change. On first open, this hook reads the flag,
 * fires ONE non-blocking toast, and CLEARS the flag on the project-local binding
 * so it never re-fires (persisted — truly one-time, survives restart).
 *
 * `<Trans>` (not an interpolated `t\`\``) carries the project name: the React
 * Compiler cannot lower a tagged template with interpolations, and sonner
 * accepts a ReactNode rendered inside the app's I18nProvider.
 */

import { resolveLocalAutoSyncMode, type SyncMode } from '@inkeep/open-knowledge-core';
import { Trans } from '@lingui/react/macro';
import { useEffect, useRef } from 'react';
import { toast } from 'sonner';
import { useConfigContext } from '@/lib/config-provider';

/** The loose auto-sync notice keys the desktop seed writes (not in the strict schema). */
interface InheritedAutoSync {
  mode?: SyncMode | null;
  enabled?: boolean | null;
  inheritedNoticePending?: unknown;
  inheritedFrom?: unknown;
}

function inheritedNoticeMessage(mode: SyncMode | null, project: string) {
  if (mode === 'follow') {
    return (
      <Trans>
        Follow is on for this worktree, inherited from {project}. Change it in Settings → Sync.
      </Trans>
    );
  }
  if (mode === 'full') {
    return (
      <Trans>
        Auto-sync is on for this worktree, inherited from {project}. Change it in Settings → Sync.
      </Trans>
    );
  }
  return (
    <Trans>
      Auto-sync is off for this worktree, inherited from {project}. Change it in Settings → Sync.
    </Trans>
  );
}

export function useWorktreeAutoSyncNotice(): void {
  const { projectLocalConfig, projectLocalSynced, projectLocalBinding } = useConfigContext();
  // Fire at most once per mounted window — the flag-clear write also stops it,
  // but the ref guards the render-before-clear window.
  const shownRef = useRef(false);

  useEffect(() => {
    if (!projectLocalSynced || shownRef.current || projectLocalBinding === null) return;
    const autoSync = projectLocalConfig?.autoSync as InheritedAutoSync | undefined;
    if (autoSync?.inheritedNoticePending !== true) return;

    shownRef.current = true;
    const project = typeof autoSync.inheritedFrom === 'string' ? autoSync.inheritedFrom : '';
    const mode = resolveLocalAutoSyncMode({ mode: autoSync.mode, enabled: autoSync.enabled });
    toast(inheritedNoticeMessage(mode, project));
    // Clear the one-shot flag so the notice never repeats (persisted).
    projectLocalBinding.patch({ autoSync: { inheritedNoticePending: null } });
  }, [projectLocalSynced, projectLocalConfig, projectLocalBinding]);
}
