import { isDeepStrictEqual } from 'node:util';
import type {
  OkTerminalDockStateWriteResult,
  OkTerminalRestartSnapshot,
} from '@inkeep/open-knowledge-core/desktop-bridge';
import { type AppState, getTerminalDockState, setTerminalDockState } from './state-store';

interface CommitTerminalDockStateInput {
  readonly current: AppState;
  readonly stateKey: string;
  readonly update: Partial<{
    terminalVisible: boolean;
    terminalSnapshot: OkTerminalRestartSnapshot;
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
