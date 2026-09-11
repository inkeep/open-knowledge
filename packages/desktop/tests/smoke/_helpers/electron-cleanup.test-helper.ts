import type { TaskkillOutcome } from './electron-cleanup';

export function timedOutTaskkill(): TaskkillOutcome {
  return { status: null, signal: null, stdout: '', stderr: '', timedOut: true };
}

export function reapedTaskkill(pid: number): TaskkillOutcome {
  return {
    status: 0,
    signal: null,
    stdout: `SUCCESS: The process with PID ${pid} has been terminated.\r\n`,
    stderr: '',
    timedOut: false,
  };
}
