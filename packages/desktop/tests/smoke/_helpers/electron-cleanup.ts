import type { ChildProcess } from 'node:child_process';
import { spawn } from 'node:child_process';
import { type Dirent, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ElectronApplication } from '@playwright/test';

export interface TaskkillOutcome {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  error?: Error;
  timedOut: boolean;
}

export interface CloseAppBoundedOpts {
  gracefulMs?: number;
  postKillReapMs?: number;
  kill?: (pid: number, signal: NodeJS.Signals | string) => void;
  taskkill?: (pid: number) => Promise<TaskkillOutcome>;
  platform?: NodeJS.Platform;
}

const POST_KILL_REAP_MS = 2_000;
const TASKKILL_TIMEOUT_MS = 5_000;
const KILL_ATTEMPTS = 2;

export function taskkillTree(pid: number): Promise<TaskkillOutcome> {
  return new Promise<TaskkillOutcome>((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true });
    } catch (error) {
      resolve({
        status: null,
        signal: null,
        stdout: '',
        stderr: '',
        error: error instanceof Error ? error : new Error(String(error)),
        timedOut: false,
      });
      return;
    }
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    let settled = false;
    const settle = (outcome: Omit<TaskkillOutcome, 'stdout' | 'stderr'>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ...outcome, stdout, stderr });
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      settle({ status: null, signal: null, timedOut: true });
    }, TASKKILL_TIMEOUT_MS);
    timer.unref();
    child.once('error', (error: Error) =>
      settle({ status: null, signal: null, error, timedOut: false }),
    );
    child.once('close', (status: number | null, signal: NodeJS.Signals | null) =>
      settle({ status, signal, timedOut: false }),
    );
  });
}

const closed = new WeakSet<ChildProcess>();
const watched = new WeakSet<ChildProcess>();
const incomplete = new WeakMap<ChildProcess, AppCleanupIncompleteError>();

function watchForClose(proc: ChildProcess): void {
  if (watched.has(proc)) return;
  watched.add(proc);
  proc.once('close', () => {
    closed.add(proc);
  });
  if (closedBeforeFirstSight(proc)) closed.add(proc);
}

export function captureAppProcess(app: ElectronApplication): ChildProcess {
  const proc = app.process();
  watchForClose(proc);
  return proc;
}

const LOCK_SEARCH_DEPTH = 3;

function collectServerLockPids(dir: string, depth: number, out: number[]): void {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true, encoding: 'utf8' });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name === '.ok') {
      try {
        const raw = readFileSync(join(dir, '.ok', 'local', 'server.lock'), 'utf8');
        const pid = (JSON.parse(raw) as { pid?: unknown }).pid;
        if (typeof pid === 'number' && Number.isInteger(pid) && pid > 1) out.push(pid);
      } catch {}
      continue;
    }
    if (depth > 0) collectServerLockPids(join(dir, entry.name), depth - 1, out);
  }
}

export function reapDetachedServers(dirs: readonly string[]): void {
  const pids: number[] = [];
  for (const dir of dirs) collectServerLockPids(dir, LOCK_SEARCH_DEPTH, pids);
  for (const pid of new Set(pids)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {}
  }
}

function openStdioCount(proc: ChildProcess): number {
  const slots = Array.isArray(proc.stdio) ? proc.stdio : [];
  let open = 0;
  for (const slot of slots) {
    if (slot === null || slot === undefined) continue;
    if (slot.destroyed) continue;
    open += 1;
  }
  return open;
}

function hasExited(proc: ChildProcess): boolean {
  return proc.exitCode !== null || proc.signalCode !== null;
}

function closedBeforeFirstSight(proc: ChildProcess): boolean {
  return hasExited(proc) && openStdioCount(proc) === 0;
}

function hasClosed(proc: ChildProcess): boolean {
  return closed.has(proc);
}

function usablePid(proc: ChildProcess): number | undefined {
  const pid = proc.pid;
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return undefined;
  return pid;
}

function waitForClose(proc: ChildProcess, timeoutMs: number): Promise<void> {
  return new Promise<void>((resolve) => {
    if (hasClosed(proc)) {
      resolve();
      return;
    }
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      proc.off('close', onClose);
      clearTimeout(timer);
      resolve();
    };
    const onClose = () => finish();
    const timer = setTimeout(finish, timeoutMs);
    timer.unref();
    proc.on('close', onClose);
  });
}

export type KillAttempt = { elapsedMs: number } & (
  | { lever: 'taskkill'; outcome: TaskkillOutcome }
  | { lever: 'group-kill'; thrown: unknown }
  | { lever: 'no-pid' }
);

async function escalate(proc: ChildProcess, opts: CloseAppBoundedOpts): Promise<KillAttempt> {
  const startedAt = Date.now();
  const pid = usablePid(proc);
  if (pid === undefined) return { lever: 'no-pid', elapsedMs: Date.now() - startedAt };
  if ((opts.platform ?? process.platform) === 'win32') {
    const outcome = await (opts.taskkill ?? taskkillTree)(pid);
    return { lever: 'taskkill', outcome, elapsedMs: Date.now() - startedAt };
  }
  const killFn = opts.kill ?? process.kill.bind(process);
  try {
    killFn(-pid, 'SIGKILL');
    return { lever: 'group-kill', thrown: undefined, elapsedMs: Date.now() - startedAt };
  } catch (thrown) {
    return { lever: 'group-kill', thrown, elapsedMs: Date.now() - startedAt };
  }
}

function quote(text: string): string {
  const trimmed = text.trim();
  return trimmed.length === 0 ? 'none' : JSON.stringify(trimmed);
}

function describeAttempt(attempt: KillAttempt, slot: number): string {
  const label = `attempt ${slot + 1} after ${attempt.elapsedMs}ms`;
  if (attempt.lever === 'no-pid') return `${label}: no usable pid, no kill lever available`;
  if (attempt.lever === 'group-kill') {
    const thrown = attempt.thrown;
    if (thrown === undefined) return `${label}: kill(-pid, SIGKILL) sent`;
    const detail = thrown instanceof Error ? thrown.message : String(thrown);
    return `${label}: kill(-pid, SIGKILL) threw ${detail}`;
  }
  const { status, signal, error, stdout, stderr, timedOut } = attempt.outcome;
  return `${label}: taskkill /T /F status=${String(status)} signal=${signal ?? 'none'} timedOut=${timedOut} error=${
    error === undefined ? 'none' : error.message
  } stdout=${quote(stdout)} stderr=${quote(stderr)}`;
}

export class AppCleanupIncompleteError extends Error {
  readonly pid: number | undefined;
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;
  readonly openStdioStreams: number;
  readonly gracefulWaitMs: number;
  readonly attempts: readonly KillAttempt[];

  constructor(proc: ChildProcess, attempts: readonly KillAttempt[], gracefulWaitMs: number) {
    const openStdioStreams = openStdioCount(proc);
    const header = [
      `closeAppBounded could not establish close for pid ${proc.pid ?? 'unknown'}`,
      `exitCode=${String(proc.exitCode)}`,
      `signalCode=${proc.signalCode ?? 'none'}`,
      `openStdioStreams=${openStdioStreams}`,
      `gracefulWaitMs=${gracefulWaitMs}`,
    ].join(' ');
    super([header, ...attempts.map(describeAttempt)].join('\n  '));
    this.name = 'AppCleanupIncompleteError';
    this.pid = proc.pid;
    this.exitCode = proc.exitCode;
    this.signalCode = proc.signalCode;
    this.openStdioStreams = openStdioStreams;
    this.gracefulWaitMs = gracefulWaitMs;
    this.attempts = attempts;
  }
}

export async function closeAppBounded(
  proc: ChildProcess | null,
  opts: CloseAppBoundedOpts = {},
): Promise<void> {
  if (proc === null) return;

  watchForClose(proc);
  if (hasClosed(proc)) return;
  const prior = incomplete.get(proc);
  if (prior !== undefined) throw prior;

  const gracefulMs = opts.gracefulMs ?? 5_000;
  const reapMs = opts.postKillReapMs ?? POST_KILL_REAP_MS;

  const gracefulStartedAt = Date.now();
  await waitForClose(proc, gracefulMs);
  const gracefulWaitMs = Date.now() - gracefulStartedAt;
  if (hasClosed(proc)) return;

  const escalationDeadline = Date.now() + KILL_ATTEMPTS * (TASKKILL_TIMEOUT_MS + reapMs);
  const attempts: KillAttempt[] = [];
  for (let round = 0; round < KILL_ATTEMPTS; round += 1) {
    const attempt = await escalate(proc, opts);
    attempts.push(attempt);
    if (hasClosed(proc)) return;
    if (attempt.lever === 'no-pid') break;
    const remainingMs = escalationDeadline - Date.now();
    if (remainingMs <= 0) break;
    await waitForClose(proc, Math.min(reapMs, remainingMs));
    if (hasClosed(proc)) return;
  }

  const failure = new AppCleanupIncompleteError(proc, attempts, gracefulWaitMs);
  incomplete.set(proc, failure);
  throw failure;
}
