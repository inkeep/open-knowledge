import { isDeepStrictEqual } from 'node:util';
import type {
  OkTerminalDockStateWriteResult,
  OkTerminalRestartSnapshot,
} from '@inkeep/open-knowledge-core/desktop-bridge';
import {
  type AppState,
  getTerminalDockState,
  type PersistedTerminalDockState,
  setTerminalDockState,
} from './state-store';

interface CommitTerminalDockStateInput {
  readonly current: AppState;
  readonly stateKey: string;
  readonly update: Partial<{
    terminalVisible: boolean;
    terminalSnapshot: OkTerminalRestartSnapshot;
    agentPanelVisible: boolean;
    editorVisible: boolean;
  }>;
  readonly save: (state: AppState) => boolean;
}

export function commitTerminalDockState({
  current,
  stateKey,
  update,
  save,
}: CommitTerminalDockStateInput): {
  readonly state: AppState;
  readonly result: OkTerminalDockStateWriteResult;
} {
  const retained = getTerminalDockState(current, stateKey);
  const next = setTerminalDockState(current, stateKey, { ...retained, ...update });
  if (isDeepStrictEqual(getTerminalDockState(next, stateKey), retained)) {
    return { state: current, result: { ok: true } };
  }
  if (!save(next)) return { state: current, result: { ok: false, reason: 'persist-failed' } };
  return { state: next, result: { ok: true } };
}

export function resolveRestoredAgentPanelVisible({
  inMemory,
  persisted,
}: {
  readonly inMemory: boolean | undefined;
  readonly persisted: PersistedTerminalDockState | null | undefined;
}): boolean {
  return inMemory ?? persisted?.agentPanelVisible ?? false;
}

export function resolveRestoredEditorVisible({
  inMemory,
  persisted,
}: {
  readonly inMemory: boolean | undefined;
  readonly persisted: PersistedTerminalDockState | null | undefined;
}): boolean {
  return inMemory ?? persisted?.editorVisible ?? true;
}

export interface DockVisibilityUpdateDeps {
  readonly rememberForWindow: (visible: boolean) => void;
  readonly persist: (visible: boolean) => OkTerminalDockStateWriteResult;
  readonly warnPersistFailed: (reason: string) => void;
}

export function applyDockVisibilityUpdate(deps: DockVisibilityUpdateDeps, visible: boolean): void {
  deps.rememberForWindow(visible);
  const result = deps.persist(visible);
  if (!result.ok) deps.warnPersistFailed(result.reason);
}
