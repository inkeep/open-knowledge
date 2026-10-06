type PtyPhase =
  | 'module-entry'
  | 'logger-import'
  | 'native-import'
  | 'listener-ready'
  | 'message-received'
  | 'shell-resolution'
  | 'paths'
  | 'ipc-create'
  | 'configured-shell'
  | 'reservation'
  | 'ipc-start'
  | 'ipc-adopt'
  | 'utility-fork'
  | 'utility-spawn'
  | 'utility-exit'
  | 'pty-spawn'
  | 'pty-first-output'
  | 'pty-first-forward'
  | 'pty-exit'
  | 'trace-limit';

interface PtyPhaseContext {
  scope?: string;
  ptyId?: string;
  windowId?: number;
  webContentsId?: number;
  forkId?: number;
  utilityPid?: number;
  userDataDir?: string;
  logDir?: string;
  rung?: string;
  ok?: boolean;
  exitCode?: number;
  backend?: 'bundled' | 'inbox' | 'posix';
  attempt?: number;
  currentSession?: boolean;
}

export interface PtyPhaseRecord extends PtyPhaseContext {
  event: 'pty-phase';
  producer: 'main' | 'utility';
  pid: number;
  sequence: number;
  phase: PtyPhase;
  edge: 'begin' | 'end' | 'error' | 'point';
  atMs: number;
  wallTimeMs: number;
  timeOriginMs: number;
  previousWriteMs: number;
  droppedWrites: number;
}

export interface PtyPhaseTrace {
  mark(phase: PtyPhase, edge: PtyPhaseRecord['edge'], context?: PtyPhaseContext): void;
}

export function createPtyPhaseTrace(
  env: Record<string, string | undefined>,
  producer: PtyPhaseRecord['producer'],
  write: (record: PtyPhaseRecord) => void,
): PtyPhaseTrace | undefined {
  if (env.OK_PTY_PHASE_TRACE !== '1') return undefined;
  let sequence = 0;
  let previousWriteMs = 0;
  let droppedWrites = 0;
  return {
    mark(phase, edge, context = {}) {
      if (sequence >= 256) return;
      sequence += 1;
      const record: PtyPhaseRecord = {
        ...context,
        event: 'pty-phase',
        producer,
        pid: process.pid,
        sequence,
        phase: sequence === 256 ? 'trace-limit' : phase,
        edge: sequence === 256 ? 'point' : edge,
        atMs: performance.now(),
        wallTimeMs: Date.now(),
        timeOriginMs: performance.timeOrigin,
        previousWriteMs,
        droppedWrites,
      };
      const writeStarted = performance.now();
      try {
        write(record);
      } catch {
        droppedWrites += 1;
      }
      previousWriteMs = performance.now() - writeStarted;
    },
  };
}
