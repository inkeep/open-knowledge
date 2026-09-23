export type ProcessLiveness = 'signalable' | 'foreign' | 'absent';

export function readProcessLiveness(pid: number): ProcessLiveness {
  try {
    process.kill(pid, 0);
    return 'signalable';
  } catch (err: unknown) {
    if (err && typeof err === 'object' && 'code' in err && err.code === 'EPERM') return 'foreign';
    return 'absent';
  }
}

export function isProcessAlive(pid: number): boolean {
  return readProcessLiveness(pid) !== 'absent';
}

export function isValidLockPid(value: unknown): value is number {
  if (typeof value !== 'number') return false;
  if (!Number.isInteger(value)) return false;
  if (value < 2) return false;
  if (value > 0x7fffffff) return false;
  return true;
}
