import { createHook } from 'node:async_hooks';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { type MessagePort, receiveMessageOnPort, workerData } from 'node:worker_threads';
import { setupUtility } from '../../src/utility/server-entry.ts';
import { QUIT_DRAIN_FLAG, type QuitDrainMode } from './project-server-quit-drain.test-helper.ts';

type ServerModule = typeof import('@inkeep/open-knowledge-server');

interface QuitDrainWorkerData {
  port: MessagePort;
  flags: SharedArrayBuffer;
  desktopPackageJson: string;
  mode: QuitDrainMode;
}

const { port, flags: flagBuffer, desktopPackageJson, mode } = workerData as QuitDrainWorkerData;
const flags = new Int32Array(flagBuffer);
const pendingNativeWatcherOps = new Set<number>();
let serverStartSubscribeHeld = false;

function signalHarness(): void {
  Atomics.add(flags, QUIT_DRAIN_FLAG.workerEvents, 1);
  Atomics.notify(flags, QUIT_DRAIN_FLAG.workerEvents);
}

function parcelOperation(): 'subscribe' | 'unsubscribe' | 'other' | null {
  const limit = Error.stackTraceLimit;
  Error.stackTraceLimit = 80;
  const stack = new Error('native watcher operation').stack ?? '';
  Error.stackTraceLimit = limit;
  const frame = stack.split('\n').find((line) => line.includes('@parcel/watcher'));
  if (frame === undefined) return null;
  const operation = /at (?:[\w$]+\.)?(subscribe|unsubscribe) \(/.exec(frame)?.[1];
  return operation === 'subscribe' || operation === 'unsubscribe' ? operation : 'other';
}

const messageListeners: Array<(event: { data: unknown }) => void> = [];
let resolveShutdownReceived!: () => void;
const shutdownReceived = new Promise<void>((resolve) => {
  resolveShutdownReceived = resolve;
});

function deliverFromParent(data: unknown): void {
  if ((data as { type?: unknown }).type === 'shutdown') {
    Atomics.store(flags, QUIT_DRAIN_FLAG.shutdownReceived, 1);
    resolveShutdownReceived();
  }
  for (const listener of messageListeners) listener({ data });
}

function holdNativeOperationUntilReleased(): void {
  const hold = Atomics.add(flags, QUIT_DRAIN_FLAG.holdsBegun, 1) + 1;
  signalHarness();
  for (
    let released = Atomics.load(flags, QUIT_DRAIN_FLAG.holdsReleased);
    released < hold;
    released = Atomics.load(flags, QUIT_DRAIN_FLAG.holdsReleased)
  ) {
    Atomics.wait(flags, QUIT_DRAIN_FLAG.holdsReleased, released);
  }
  if (Atomics.exchange(flags, QUIT_DRAIN_FLAG.deliverParentMessagesOnRelease, 0) === 1) {
    for (
      let queued = receiveMessageOnPort(port);
      queued !== undefined;
      queued = receiveMessageOnPort(port)
    ) {
      deliverFromParent(queued.message);
    }
  }
}

createHook({
  init(asyncId, type) {
    if (type !== 'undefined') return;
    const operation = parcelOperation();
    if (operation === null) return;
    pendingNativeWatcherOps.add(asyncId);
    Atomics.add(flags, QUIT_DRAIN_FLAG.nativeOpsPending, 1);
    if (operation === 'subscribe') Atomics.add(flags, QUIT_DRAIN_FLAG.nativeSubscribes, 1);
    if (operation === 'unsubscribe') Atomics.add(flags, QUIT_DRAIN_FLAG.nativeUnsubscribes, 1);
    if (Atomics.load(flags, QUIT_DRAIN_FLAG.shutdownReceived) === 1) {
      Atomics.add(flags, QUIT_DRAIN_FLAG.nativeOpsStartedDuringShutdown, 1);
      queueMicrotask(holdNativeOperationUntilReleased);
    } else if (
      mode === 'quit-during-start' &&
      operation === 'subscribe' &&
      !serverStartSubscribeHeld
    ) {
      serverStartSubscribeHeld = true;
      queueMicrotask(holdNativeOperationUntilReleased);
    }
  },
  before(asyncId) {
    if (!pendingNativeWatcherOps.delete(asyncId)) return;
    Atomics.sub(flags, QUIT_DRAIN_FLAG.nativeOpsPending, 1);
  },
}).enable();

const serverModuleUrl = pathToFileURL(
  createRequire(desktopPackageJson).resolve('@inkeep/open-knowledge-server'),
).href;

async function importServer(): Promise<ServerModule> {
  const server: ServerModule = await import(serverModuleUrl);
  const bootServer: ServerModule['bootServer'] = async (opts) => {
    const booted = await server.bootServer(opts);
    const noteInitSettled = () => {
      Atomics.store(flags, QUIT_DRAIN_FLAG.serverInitSettled, 1);
      signalHarness();
    };
    void booted.ready.then(noteInitSettled, noteInitSettled);
    if (mode === 'quit-during-start') {
      await shutdownReceived;
      await booted.ready.catch(() => {});
    }
    Atomics.store(flags, QUIT_DRAIN_FLAG.serverStartSettled, 1);
    return booted;
  };
  return { ...server, bootServer };
}

port.on('message', deliverFromParent);

setupUtility({
  parentPort: {
    on(event: 'message', handler: (event: { data: unknown }) => void) {
      if (event === 'message') messageListeners.push(handler);
    },
    postMessage(value: unknown) {
      port.postMessage(value);
    },
  },
  importServer,
  exit: (code: number) => {
    Atomics.store(
      flags,
      QUIT_DRAIN_FLAG.nativeOpsPendingAtExit,
      Atomics.load(flags, QUIT_DRAIN_FLAG.nativeOpsPending),
    );
    Atomics.store(
      flags,
      QUIT_DRAIN_FLAG.subscriptionsUnreleasedAtExit,
      Atomics.load(flags, QUIT_DRAIN_FLAG.nativeSubscribes) -
        Atomics.load(flags, QUIT_DRAIN_FLAG.nativeUnsubscribes),
    );
    Atomics.store(
      flags,
      QUIT_DRAIN_FLAG.serverStartSettledAtExit,
      Atomics.load(flags, QUIT_DRAIN_FLAG.serverStartSettled),
    );
    Atomics.store(flags, QUIT_DRAIN_FLAG.exitCode, code);
    Atomics.store(flags, QUIT_DRAIN_FLAG.exitCalled, 1);
    signalHarness();
    port.postMessage({ type: 'quit-drain-harness:exit', code });
  },
  parentPid: process.pid,
  killProbe: () => {},
  onSignal: () => {},
  setInterval: (cb: () => void, intervalMs: number) => {
    const handle = setInterval(cb, intervalMs);
    return { unref: () => handle.unref(), clear: () => clearInterval(handle) };
  },
});
