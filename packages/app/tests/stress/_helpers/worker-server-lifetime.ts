import { type ChildProcess, spawn } from 'node:child_process';
import { constants } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { prebuiltServerCommand, type WorkerServing } from './prebuilt/prebuilt-serving.ts';
import {
  APP_PACKAGE_ROOT,
  type ServerLog,
  type ViteStartupRequest,
  type WORKER_SERVER_HANDLE,
} from './server-process.ts';
import { runTeardownPhases } from './teardown-fs.ts';
import type { WorkerServerLaunch } from './worker-server-command.ts';

export type WorkerServerProcess = ChildProcess & { readonly [WORKER_SERVER_HANDLE]: true };

interface Lifetime {
  readonly sendToOwner: (type: 'stop' | 'release') => void;
  readonly stopped: Promise<void>;
  readonly released: Promise<void>;
  readonly exited: Promise<void>;
  readonly ownerExited: () => boolean;
  readonly commandPid: () => number | undefined;
  readonly reapMs: number;
}

const lifetimes = new WeakMap<ChildProcess, Lifetime>();

function lifetimeOf(proc: WorkerServerProcess): Lifetime {
  const lifetime = lifetimes.get(proc);
  if (lifetime === undefined) throw new Error('not a handle acquireWorkerServer returned');
  return lifetime;
}

const commandStatusSchema = z.object({
  code: z.number().int().nullable(),
  signal: z
    .custom<NodeJS.Signals>(
      (value) => typeof value === 'string' && Object.hasOwn(constants.signals, value),
    )
    .nullable(),
});

const commandErrorSchema = z.object({
  name: z.string(),
  message: z.string(),
  stack: z.string().optional(),
  errno: z.number().optional(),
  code: z.string().optional(),
  syscall: z.string().optional(),
  path: z.string().optional(),
  spawnargs: z.array(z.string()).optional(),
});

const lifetimeMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('started'), pid: z.number().int().positive().nullable() }),
  z.object({ type: z.literal('command-exit'), ...commandStatusSchema.shape }),
  z.object({ type: z.literal('command-close'), ...commandStatusSchema.shape }),
  z.object({
    type: z.literal('command-error'),
    status: commandStatusSchema,
    error: commandErrorSchema,
  }),
  z.object({ type: z.literal('launch-error'), message: z.string() }),
  z.object({ type: z.literal('stopped'), error: z.string().nullable() }),
  z.object({ type: z.literal('released'), error: z.string().nullable() }),
]);

export function acquireWorkerServer(
  request: ViteStartupRequest,
  workerServerEnv: Readonly<Record<string, string>>,
  contentDir: string,
  viteCacheDir: string,
  serverLog: ServerLog,
  serving: WorkerServing,
  reapMs: number,
): WorkerServerProcess {
  const command =
    serving.kind === 'prebuilt'
      ? prebuiltServerCommand(request.host, serving, join(APP_PACKAGE_ROOT, '..', '..'))
      : null;
  const launch: WorkerServerLaunch = {
    request,
    workerServerEnv,
    contentDir,
    viteCacheDir,
    serverLog: { path: serverLog.path, fd: 1 },
    serving,
    command,
    reapMs,
  };
  const proc = spawn(
    process.execPath,
    [join(import.meta.dirname, 'worker-server-lifetime.cjs'), JSON.stringify(launch)],
    {
      cwd: APP_PACKAGE_ROOT,
      detached: true,
      env: process.env,
      stdio: ['ignore', serverLog.fd, 'inherit', 'ipc'],
    },
  );
  let commandStatus: z.infer<typeof commandStatusSchema> | undefined;
  let commandPid: number | undefined;
  let nativeExitCode = proc.exitCode;
  let nativeSignalCode = proc.signalCode;
  Object.defineProperties(proc, {
    exitCode: {
      get: () => (commandStatus === undefined ? null : commandStatus.code),
      set: (code: number | null) => {
        nativeExitCode = code;
      },
    },
    signalCode: {
      get: () => (commandStatus === undefined ? null : commandStatus.signal),
      set: (signal: NodeJS.Signals | null) => {
        nativeSignalCode = signal;
      },
    },
  });
  let commandExitEmitted = false;
  let commandCloseEmitted = false;
  let launchFailed = false;
  let releaseCompleted = false;
  let transportFailure: Error | undefined;
  const nativeEmit = proc.emit.bind(proc);
  let resolveStopped: () => void;
  let rejectStopped: (error: Error) => void;
  const stopped = new Promise<void>((resolve, reject) => {
    resolveStopped = resolve;
    rejectStopped = reject;
  });
  let resolveReleased: () => void;
  let rejectReleased: (error: Error) => void;
  const released = new Promise<void>((resolve, reject) => {
    resolveReleased = resolve;
    rejectReleased = reject;
  });
  let resolveExited: () => void;
  let rejectExited: (error: Error) => void;
  const exited = new Promise<void>((resolve, reject) => {
    resolveExited = resolve;
    rejectExited = reject;
  });
  void stopped.catch(() => undefined);
  void released.catch(() => undefined);
  void exited.catch(() => undefined);
  proc.emit = (event: string | symbol, ...args: unknown[]): boolean => {
    if (event === 'exit') return false;
    if (event === 'close') {
      rejectStopped(new Error('worker server lifetime closed before stop completed'));
      rejectReleased(new Error('worker server lifetime closed before release completed'));
      if (
        nativeExitCode === 0 &&
        nativeSignalCode === null &&
        releaseCompleted &&
        (commandCloseEmitted || launchFailed) &&
        transportFailure === undefined
      ) {
        resolveExited();
      } else {
        const error =
          transportFailure ??
          new Error(
            `worker server lifetime closed without completed release (code=${nativeExitCode}, signal=${nativeSignalCode})`,
          );
        rejectExited(error);
        if (!commandCloseEmitted && !launchFailed) nativeEmit('error', error);
      }
      return false;
    }
    if (event === 'error') {
      const [error] = args;
      transportFailure =
        error instanceof Error ? error : new Error('worker server lifetime failed');
      rejectStopped(transportFailure);
      rejectReleased(transportFailure);
    }
    return nativeEmit(event, ...args);
  };
  proc.on('error', () => undefined);
  proc.on('message', (input: unknown) => {
    const result = lifetimeMessageSchema.safeParse(input);
    if (!result.success) {
      transportFailure = new Error('worker server lifetime sent an invalid message');
      rejectStopped(transportFailure);
      rejectReleased(transportFailure);
      nativeEmit('error', transportFailure);
      return;
    }
    const message = result.data;
    switch (message.type) {
      case 'started':
        commandPid = message.pid ?? undefined;
        return;
      case 'command-exit':
        commandStatus = { code: message.code, signal: message.signal };
        if (!commandExitEmitted) {
          commandExitEmitted = true;
          nativeEmit('exit', message.code, message.signal);
        }
        return;
      case 'command-close':
        commandStatus = { code: message.code, signal: message.signal };
        if (!commandCloseEmitted) {
          commandCloseEmitted = true;
          nativeEmit('close', message.code, message.signal);
        }
        return;
      case 'command-error':
        commandStatus = message.status;
        nativeEmit('error', Object.assign(new Error(message.error.message), message.error));
        return;
      case 'launch-error':
        launchFailed = true;
        nativeEmit('error', new Error(message.message));
        return;
      case 'stopped':
        if (message.error === null) resolveStopped();
        else rejectStopped(new Error(message.error));
        return;
      case 'released':
        if (message.error === null) {
          releaseCompleted = true;
          resolveReleased();
        } else rejectReleased(new Error(message.error));
        return;
      default:
        message satisfies never;
    }
  });
  const sendToOwner = (type: 'stop' | 'release') => {
    if (!proc.connected) return;
    proc.send({ type }, (error) => {
      if (error === null) return;
      if (type === 'stop') rejectStopped(error);
      else rejectReleased(error);
    });
  };
  lifetimes.set(proc, {
    sendToOwner,
    stopped,
    released,
    exited,
    ownerExited: () => nativeExitCode !== null || nativeSignalCode !== null,
    commandPid: () => commandPid,
    reapMs,
  });
  return proc as WorkerServerProcess;
}

export function workerServerCommandPid(proc: WorkerServerProcess): number | undefined {
  return lifetimeOf(proc).commandPid();
}

export async function stopWorkerServer(
  proc: WorkerServerProcess,
  timeoutMs: number,
): Promise<void> {
  const lifetime = lifetimeOf(proc);
  if (lifetime.ownerExited()) return lifetime.exited;
  lifetime.sendToOwner('stop');
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      lifetime.stopped,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`worker server lifetime stop exceeded ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function completeWorkerServerRelease(
  proc: WorkerServerProcess,
  cleanup: () => void | Promise<void> = () => undefined,
): Promise<void> {
  await runTeardownPhases(cleanup, async () => {
    const lifetime = lifetimeOf(proc);
    lifetime.sendToOwner('release');
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        runTeardownPhases(
          () => lifetime.released,
          () => lifetime.exited,
        ),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            if (proc.connected) proc.disconnect();
            reject(new Error(`worker server lifetime release exceeded ${lifetime.reapMs}ms`));
          }, lifetime.reapMs);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  });
}
