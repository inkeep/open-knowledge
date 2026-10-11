import type { PtyPhaseTrace } from '../shared/pty-phase-trace.ts';

interface ObservedUtility {
  readonly pid: number | undefined;
  readonly stderr?: NodeJS.ReadableStream | null;
  once(event: 'spawn', listener: () => void): unknown;
  once(event: 'exit', listener: (code: number) => void): unknown;
}

export function observePtyFork<T extends ObservedUtility>(
  trace: PtyPhaseTrace | undefined,
  windowId: number,
  forkId: number,
  fork: () => T,
  destination?: NodeJS.WritableStream,
): T {
  if (!trace) return fork();
  const context = { windowId, forkId, scope: `fork-${forkId}` };
  trace.mark('utility-fork', 'begin', context);
  let utility: T;
  try {
    utility = fork();
  } catch (error) {
    trace.mark('utility-fork', 'error', context);
    throw error;
  }
  trace.mark('utility-fork', 'end', context);
  utility.stderr?.pipe(destination ?? process.stderr, { end: false });
  let utilityPid: number | undefined;
  utility.once('spawn', () => {
    utilityPid = utility.pid;
    trace.mark('utility-spawn', 'point', { ...context, utilityPid });
  });
  utility.once('exit', (exitCode) => {
    trace.mark('utility-exit', 'point', { ...context, utilityPid, exitCode });
  });
  return utility;
}
