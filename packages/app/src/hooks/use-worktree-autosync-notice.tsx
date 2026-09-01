import { resolveLocalAutoSyncMode, type SyncMode } from '@inkeep/open-knowledge-core';
import { Trans } from '@lingui/react/macro';
import { useEffect, useRef } from 'react';
import { toast } from 'sonner';
import { useConfigContext } from '@/lib/config-provider';

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
        Sync is set to Auto (Pull only) for this worktree, inherited from {project}. Change it in
        Settings → Sync.
      </Trans>
    );
  }
  if (mode === 'full') {
    return (
      <Trans>
        Sync is set to Auto (Pull and Push) for this worktree, inherited from {project}. Change it
        in Settings → Sync.
      </Trans>
    );
  }
  return (
    <Trans>
      Sync is set to Manual for this worktree, inherited from {project}. Change it in Settings →
      Sync.
    </Trans>
  );
}

export function useWorktreeAutoSyncNotice(): void {
  const { projectLocalConfig, projectLocalSynced, projectLocalBinding } = useConfigContext();
  const shownRef = useRef(false);

  useEffect(() => {
    if (!projectLocalSynced || shownRef.current || projectLocalBinding === null) return;
    const autoSync = projectLocalConfig?.autoSync as InheritedAutoSync | undefined;
    if (autoSync?.inheritedNoticePending !== true) return;

    shownRef.current = true;
    const project = typeof autoSync.inheritedFrom === 'string' ? autoSync.inheritedFrom : '';
    const mode = resolveLocalAutoSyncMode({ mode: autoSync.mode, enabled: autoSync.enabled });
    toast(inheritedNoticeMessage(mode, project));
    projectLocalBinding.patch({ autoSync: { inheritedNoticePending: null } });
  }, [projectLocalSynced, projectLocalConfig, projectLocalBinding]);
}
