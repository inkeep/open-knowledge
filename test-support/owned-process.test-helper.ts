import { type ChildProcess, spawn } from 'node:child_process';
import { once } from 'node:events';
import { hostname } from 'node:os';

export interface OwnedProcess {
  readonly child: ChildProcess;
  readonly pid: number;
  readonly spawnRequestedAtMs: number;
  readonly readyAtMs: number;
}

const OWNED_PROCESS_SOURCE = [
  "process.on('disconnect', () => process.exit(0));",
  'setInterval(() => {}, 1000);',
  "process.send('ready');",
].join('\n');

const LOCK_WRITTEN_BEFORE_RESTART_MS = 36 * 60 * 60 * 1000;

export async function startOwnedProcess(): Promise<OwnedProcess> {
  const spawnRequestedAtMs = Date.now();
  const child = spawn(process.execPath, ['-e', OWNED_PROCESS_SOURCE], {
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  await new Promise<void>((resolveReady, rejectReady) => {
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      rejectReady(new Error(`owned process exited before it was ready (${code ?? signal})`));
    };
    child.once('exit', onExit);
    child.once('error', rejectReady);
    child.once('message', () => {
      child.off('exit', onExit);
      child.off('error', rejectReady);
      resolveReady();
    });
  });
  const pid = child.pid;
  if (pid === undefined) throw new Error('owned process has no pid');
  return { child, pid, spawnRequestedAtMs, readyAtMs: Date.now() };
}

export async function stopOwnedProcess(owned: OwnedProcess): Promise<void> {
  const { child } = owned;
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.kill('SIGKILL');
  await exited;
}

export function ownedProcessHasExited(owned: OwnedProcess): boolean {
  return owned.child.exitCode !== null || owned.child.signalCode !== null;
}

export function lockWrittenBeforeProcessStarted(owned: OwnedProcess): string {
  return new Date(owned.spawnRequestedAtMs - LOCK_WRITTEN_BEFORE_RESTART_MS).toISOString();
}

export function lockWrittenByRunningProcess(owned: OwnedProcess): string {
  return new Date(owned.readyAtMs).toISOString();
}

export function legacyServerLock(args: {
  pid: number;
  startedAt: string;
  machineId: string;
  worktreeRoot: string;
  port?: number;
}): Record<string, unknown> {
  const port = args.port ?? 47_931;
  return {
    pid: args.pid,
    hostname: hostname(),
    port,
    url: `http://127.0.0.1:${port}`,
    startedAt: args.startedAt,
    worktreeRoot: args.worktreeRoot,
    machineId: args.machineId,
    kind: 'interactive',
    capabilities: ['http', 'ws', 'ui'],
    protocolVersion: 2,
    runtimeVersion: '0.79.13',
  };
}
