import { type ChildProcess, spawn } from 'node:child_process';
import { resolve } from 'node:path';

type WriterProcess = Pick<ChildProcess, 'stderr' | 'kill' | 'pid' | 'exitCode' | 'signalCode'> & {
  on(event: 'message', listener: (message: unknown) => void): void;
  on(event: 'error', listener: (error: Error) => void): void;
  once(
    event: 'close',
    listener: (exitCode: number | null, signal: NodeJS.Signals | null) => void,
  ): void;
};
export type SpawnWriter = (configPath: string, serverKey: string) => WriterProcess;
export type WriterMessage =
  | 'started'
  | 'ready'
  | 'written'
  | { type: 'module-loaded'; url: string };

const WORKER_PATH = resolve(import.meta.dirname, 'config-race-worker.ts');
const NO_PROGRESS_MS = 30_000;
const PHASES = ['spawned', 'started', 'ready', 'written'];

export function spawnConfigWriter(configPath: string, serverKey: string) {
  return spawn(process.execPath, [WORKER_PATH, configPath, serverKey], {
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
}

interface WorkerOutcome {
  serverKey: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  phase: string;
  stderr: string;
}

interface WriterState {
  proc: WriterProcess;
  serverKey: string;
  phase: number;
  loadedModules: Set<string>;
  stderr: string;
  stopRequested: boolean;
}

type WriterReport = Pick<WriterState, 'serverKey' | 'phase' | 'stderr'>;

const describeWriter = (state: WriterReport) =>
  `${state.serverKey}: phase=${PHASES[state.phase]} stderr=${state.stderr.trim()}`;

const writerFailure = (state: WriterReport, cause: unknown) =>
  new Error(`Config writer failed: ${describeWriter(state)}`, { cause });

export async function runConfigWriters(
  configPath: string,
  serverKeys: string[],
  options: { spawnWriter?: SpawnWriter; signal?: AbortSignal } = {},
): Promise<WorkerOutcome[]> {
  options.signal?.throwIfAborted();
  const spawnWriter = options.spawnWriter ?? spawnConfigWriter;
  const pending = new Set<WriterState>();
  const completions: Promise<WorkerOutcome>[] = [];
  let failure: Error | undefined;
  let watchdog: ReturnType<typeof setTimeout> | undefined;

  const stop = () => {
    clearTimeout(watchdog);
    for (const state of pending) {
      if (
        !state.stopRequested &&
        state.proc.pid !== undefined &&
        state.proc.exitCode === null &&
        state.proc.signalCode === null
      ) {
        state.stopRequested = true;
        state.proc.kill('SIGKILL');
      }
    }
  };
  const fail = (error: unknown) => {
    failure ??= error instanceof Error ? error : new Error(String(error));
    stop();
  };
  const progress = () => {
    clearTimeout(watchdog);
    if (failure || pending.size === 0) return;
    watchdog = setTimeout(() => {
      fail(
        new Error(
          `Config writers made no progress for ${NO_PROGRESS_MS}ms:\n${[...pending]
            .map(describeWriter)
            .join('\n')}`,
        ),
      );
    }, NO_PROGRESS_MS);
  };
  const abort = () => fail(options.signal?.reason);
  options.signal?.addEventListener('abort', abort, { once: true });

  try {
    for (const serverKey of serverKeys) {
      if (failure) break;
      let proc: WriterProcess;
      try {
        proc = spawnWriter(configPath, serverKey);
      } catch (error) {
        throw writerFailure({ serverKey, phase: 0, stderr: '' }, error);
      }
      const state: WriterState = {
        proc,
        serverKey,
        phase: 0,
        loadedModules: new Set(),
        stderr: '',
        stopRequested: false,
      };
      pending.add(state);
      completions.push(
        new Promise((resolveClose) => {
          proc.stderr?.on('data', (chunk: Buffer) => {
            state.stderr += chunk.toString('utf-8');
          });
          proc.on('message', (message: unknown) => {
            if (
              !failure &&
              pending.has(state) &&
              state.phase === PHASES.indexOf('started') &&
              typeof message === 'object' &&
              message !== null &&
              'type' in message &&
              message.type === 'module-loaded' &&
              'url' in message &&
              typeof message.url === 'string' &&
              !state.loadedModules.has(message.url)
            ) {
              state.loadedModules.add(message.url);
              progress();
            }
            const phase = typeof message === 'string' ? PHASES.indexOf(message) : -1;
            if (phase > state.phase) {
              state.phase = phase;
              progress();
            }
          });
          proc.on('error', (error) => fail(writerFailure(state, error)));
          proc.once('close', (exitCode, signal) => {
            pending.delete(state);
            resolveClose({
              serverKey,
              exitCode,
              signal: signal ?? null,
              phase: PHASES[state.phase],
              stderr: state.stderr,
            });
            progress();
          });
        }),
      );
      progress();
    }
  } catch (error) {
    fail(error);
  }

  try {
    const outcomes = await Promise.all(completions);
    if (failure) throw failure;
    return outcomes;
  } finally {
    clearTimeout(watchdog);
    options.signal?.removeEventListener('abort', abort);
  }
}
