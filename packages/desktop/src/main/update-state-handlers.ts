import type {
  OkStateSnapshot,
  OkV1UpgradeSnapshot,
} from '@inkeep/open-knowledge-core/desktop-bridge';
import { buildAboutInfo } from './about-info.ts';
import {
  type AppState,
  emptyState,
  resolveUpdateMode,
  type SchemaIncompatibilityDiagnostic,
  type UpdateChannel,
} from './state-store.ts';
import { buildDormantV1UpgradeSnapshot } from './v1-upgrade.ts';

export interface UpdateStateHandlerDeps {
  getAppState: () => AppState;
  setAppState: (next: AppState) => void;
  saveAppState: (next: AppState) => boolean;
  getBuildChannel: () => UpdateChannel;
  getPendingSchemaIncompatibility: () => SchemaIncompatibilityDiagnostic | null;
  clearPendingSchemaIncompatibility: () => void;
  getAppVersion: () => string;
  variant: { readonly name: string; readonly productName: string };
  isUpdaterRunning: () => boolean;
  getV1UpgradeSnapshot?: () => OkV1UpgradeSnapshot | undefined;
}

export async function applyResetIncompatible(deps: UpdateStateHandlerDeps): Promise<undefined> {
  const prev = deps.getAppState();
  const fresh = emptyState();
  deps.setAppState(fresh);
  if (!deps.saveAppState(fresh)) {
    deps.setAppState(prev);
    throw new Error('saveAppState failed — incompatibility reset not persisted');
  }
  deps.clearPendingSchemaIncompatibility();
  return undefined;
}

export async function applyStateQuery(
  deps: UpdateStateHandlerDeps,
): Promise<Required<OkStateSnapshot>> {
  const compat = deps.getPendingSchemaIncompatibility();
  const state = deps.getAppState();
  const updateMode = resolveUpdateMode(state.updateMode).mode;
  const v1Upgrade =
    deps.getV1UpgradeSnapshot?.() ??
    buildDormantV1UpgradeSnapshot({
      proactiveAllowed: updateMode !== 'off',
      toastDismissed: state.v1ToastDismissed === true,
      canInstallInApp: false,
    });
  return {
    channel: deps.getBuildChannel(),
    schemaIncompatibility: compat ? { ...compat } : null,
    about: buildAboutInfo({
      version: deps.getAppVersion(),
      variant: deps.variant,
      updateChecksAvailable: deps.isUpdaterRunning(),
    }),
    updateMode,
    v1Upgrade,
  };
}
