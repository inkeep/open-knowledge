import { useGitSyncStatus } from '@/hooks/use-git-sync-status';
import { useConfigContextOptional } from '@/lib/config-context';
import { type AutolinkEntry, githubWebBase, type ReferenceRulesInput } from './reference-links';

export function useReferenceRules(): ReferenceRulesInput {
  const configContext = useConfigContextOptional();
  const syncStatus = useGitSyncStatus();
  return {
    githubBase: githubWebBase(syncStatus?.remote?.webUrl),
    autolinks: (configContext?.projectConfig?.autolinks ?? []).filter(
      (entry): entry is AutolinkEntry => entry !== null,
    ),
  };
}
