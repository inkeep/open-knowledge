import {
  modeFromCommittedDefault,
  resolveLocalAutoSyncMode,
  type StoredSyncMode,
} from '@inkeep/open-knowledge-core';

export type AutoSyncOnboardingVariant = 'full' | 'follow';

export interface AutoSyncOnboardingGateInputs {
  autoSyncOnboardingDismissed: boolean;
  hasRemote: boolean | undefined;
  projectLocalSynced: boolean | undefined;
  projectSynced: boolean | undefined;
  projectLocalConfig: {
    autoSync?: { mode?: StoredSyncMode | null; enabled?: boolean | null } | null;
  } | null;
  projectConfig: { autoSync?: { default?: boolean | StoredSyncMode | null } | null } | null;
  pushPermissionCheckStatus: 'allowed' | 'denied' | 'unknown' | undefined;
}

export function resolveAutoSyncOnboarding(
  inputs: AutoSyncOnboardingGateInputs,
): AutoSyncOnboardingVariant | null {
  const aligned =
    !inputs.autoSyncOnboardingDismissed &&
    inputs.hasRemote === true &&
    inputs.projectLocalSynced === true &&
    inputs.projectSynced === true &&
    inputs.projectLocalConfig !== null &&
    resolveLocalAutoSyncMode(inputs.projectLocalConfig.autoSync ?? undefined) === null &&
    modeFromCommittedDefault(inputs.projectConfig?.autoSync?.default) === null;
  if (!aligned) return null;

  switch (inputs.pushPermissionCheckStatus) {
    case 'allowed':
      return 'full';
    case 'denied':
      return 'follow';
    default:
      return null;
  }
}
