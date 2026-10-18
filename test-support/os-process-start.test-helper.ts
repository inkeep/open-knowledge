import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

export interface OsProcessStart {
  startedAtMs: number;
  clock: 'creation' | 'boot-derived';
  startTicks?: number;
  bootId?: string;
}

export type OsProcessStartToken = { bootId: string; startTicks: number } | { startedAtMs: number };

export function readProcessStartFromOs(pid: number): OsProcessStart {
  if (process.platform === 'darwin') {
    const lstart = execFileSync('ps', ['-p', String(pid), '-o', 'lstart='], {
      encoding: 'utf8',
      env: { ...process.env, LC_ALL: 'C', TZ: 'UTC0' },
    }).trim();
    return { startedAtMs: Date.parse(`${lstart} UTC`), clock: 'creation' };
  }
  if (process.platform === 'linux') {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const startTicks = Number(
      stat
        .slice(stat.lastIndexOf(')') + 1)
        .trim()
        .split(/\s+/)[19],
    );
    const btime = Number(/^btime (\d+)$/m.exec(readFileSync('/proc/stat', 'utf8'))?.[1]);
    const bootId = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
    return {
      startedAtMs: btime * 1000 + startTicks * 10,
      clock: 'boot-derived',
      startTicks,
      bootId,
    };
  }
  throw new Error(`no independent process-start source on ${process.platform}`);
}

export function processStartTokenFromOs(pid: number): OsProcessStartToken {
  const start = readProcessStartFromOs(pid);
  if (start.bootId !== undefined && start.startTicks !== undefined) {
    return { bootId: start.bootId, startTicks: start.startTicks };
  }
  return { startedAtMs: start.startedAtMs };
}

const USER_HZ_TICKS_PER_SECOND = 100;

export function processStartTokenOffsetFromOs(
  pid: number,
  offsetSeconds: number,
): OsProcessStartToken {
  const token = processStartTokenFromOs(pid);
  return 'bootId' in token
    ? {
        bootId: token.bootId,
        startTicks: token.startTicks + offsetSeconds * USER_HZ_TICKS_PER_SECOND,
      }
    : { startedAtMs: token.startedAtMs + offsetSeconds * 1000 };
}
