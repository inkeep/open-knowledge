import { useLingui } from '@lingui/react/macro';
import { useEffect, useSyncExternalStore } from 'react';
import { toast } from 'sonner';
import { hasNonGitHubRemote, remoteTakesStoredToken } from '@/components/SyncStatusBadge';
import type { GitSyncStatus } from '@/hooks/use-git-sync-status';
import { authPromptStore } from '@/lib/auth-prompt-store';
import { openAccountSettings } from '@/lib/use-settings-route';

export function useSyncAuthPrompt(
  remote: GitSyncStatus['remote'] | undefined,
  onPrompt: () => void,
): void {
  const { t } = useLingui();
  const pending = useSyncExternalStore(
    authPromptStore.subscribe,
    authPromptStore.getSnapshot,
    () => false,
  );
  const nonGitHub = hasNonGitHubRemote(remote ?? null);
  const takesToken = remoteTakesStoredToken(remote);
  useEffect(() => {
    if (!pending) return;
    authPromptStore.clear();
    if (!nonGitHub) {
      onPrompt();
      return;
    }
    if (!takesToken) {
      toast.info(
        t`Git couldn't authenticate with this host. Check the SSH key or saved credentials git uses for it.`,
      );
      return;
    }
    toast.info(
      t`OpenKnowledge has no credential stored for this host. Add a token in Settings, or let git use the credentials it already has.`,
      { action: { label: t`Add token`, onClick: () => openAccountSettings() } },
    );
  }, [pending, nonGitHub, takesToken, onPrompt, t]);
}
