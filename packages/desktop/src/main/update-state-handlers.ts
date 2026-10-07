import type { OkStateSnapshot } from '@inkeep/open-knowledge-core/desktop-bridge';
import { buildAboutInfo } from './about-info.ts';
import {
  type AppState,
  emptyState,
  type SchemaIncompatibilityDiagnostic,
  type UpdateChannel,
} from './state-store.ts';

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
  return {
    channel: deps.getBuildChannel(),
    schemaIncompatibility: compat ? { ...compat } : null,
    about: buildAboutInfo({
      version: deps.getAppVersion(),
      variant: deps.variant,
      updateChecksAvailable: deps.isUpdaterRunning(),
    }),
  };
}
