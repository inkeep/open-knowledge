import {
  exitStderrWindow,
  type ThreadExitCause,
  type ThreadExitDiagnosis,
  type ThreadFailureDetail,
} from '@inkeep/open-knowledge-core/acp/thread-protocol';

interface AgentExit {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  tail: string | undefined;
}

const COMMAND_NOT_FOUND_RE = /command not found|not recognized as an internal or external command/i;
const PERMISSION_DENIED_RE = /permission denied/i;
const MODULE_NOT_FOUND_RE = /cannot find module|ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND/i;
const OUT_OF_MEMORY_RE = /out of memory|ENOMEM/i;
const STOP_SIGNALS: ReadonlySet<string> = new Set(['SIGTERM', 'SIGINT', 'SIGHUP']);

function exitCause({ exitCode, signal, tail }: AgentExit): ThreadExitCause {
  if (signal !== null) {
    if (signal === 'SIGKILL') return 'killed';
    return STOP_SIGNALS.has(signal) ? 'stopped' : 'signal';
  }
  if (exitCode === 0) return 'clean';
  if (exitCode === null) return 'unknown';
  if (exitCode === 127) return 'command-not-found';
  if (exitCode === 126) return 'not-executable';
  const output = tail === undefined ? '' : exitStderrWindow(tail);
  if (OUT_OF_MEMORY_RE.test(output)) return 'out-of-memory';
  if (COMMAND_NOT_FOUND_RE.test(output)) return 'command-not-found';
  if (PERMISSION_DENIED_RE.test(output)) return 'not-executable';
  if (MODULE_NOT_FOUND_RE.test(output)) return 'missing-module';
  return 'unknown';
}

export function classifyExit(exit: AgentExit): ThreadExitDiagnosis {
  return { exitCode: exit.exitCode, signal: exit.signal, cause: exitCause(exit) };
}

export function exitFailureDetail(exit: AgentExit): ThreadFailureDetail {
  return { reason: 'exited', exit: classifyExit(exit), machineDetail: exit.tail };
}
