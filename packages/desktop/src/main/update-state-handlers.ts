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
}

interface StateQueryResult {
  channel: UpdateChannel;
  schemaIncompatibility: SchemaIncompatibilityDiagnostic | null;
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

export async function applyStateQuery(deps: UpdateStateHandlerDeps): Promise<StateQueryResult> {
  const compat = deps.getPendingSchemaIncompatibility();
  return {
    channel: deps.getBuildChannel(),
    schemaIncompatibility: compat ? { ...compat } : null,
  };
}
