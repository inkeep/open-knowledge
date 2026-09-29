import type { ThreadExitDiagnosis } from '@inkeep/open-knowledge-core/acp/thread-protocol';
import { t } from '@lingui/core/macro';

export function exitSummary(exit: ThreadExitDiagnosis): string {
  const signal = exit.signal ?? '';
  const code = exit.exitCode === null ? '' : String(exit.exitCode);
  switch (exit.cause) {
    case 'killed':
      return t`The agent process was killed (SIGKILL). That usually comes from the system, for example when memory runs out, or from another process ending it.`;
    case 'stopped':
      return t`The agent process was told to stop (${signal}) by something outside this chat.`;
    case 'signal':
      return t`The agent process was stopped by a ${signal} signal.`;
    case 'out-of-memory':
      return t`The agent ran out of memory.`;
    case 'command-not-found':
      return t`A command the agent needs was not found (exit code ${code}). Check that the agent's dependencies are installed and on your PATH.`;
    case 'not-executable':
      return t`A command the agent needs could not be run (exit code ${code}). Check that it is executable and that you have permission to run it.`;
    case 'missing-module':
      return t`The agent's installation is missing files (a module could not be found). Reinstalling the agent usually fixes this.`;
    case 'clean':
      return t`The agent process ended on its own.`;
    case 'unknown':
      return exit.exitCode === null
        ? t`The agent process stopped for an unknown reason.`
        : t`The agent process stopped with exit code ${code}.`;
    default: {
      const exhaustive: never = exit.cause;
      return String(exhaustive);
    }
  }
}
