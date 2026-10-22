import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { MessageChannel, Worker } from 'node:worker_threads';
import { drainAppOwnedWork } from '../../src/main/app-quit-drain.ts';
import { createTerminalQuitDrain, type QuitEventLike } from '../../src/main/terminal-quit-drain.ts';
import {
  type BrowserWindowLike,
  type UtilityProcessLike,
  WindowManager,
} from '../../src/main/window-manager.ts';
import {
  isQuitDrainMode,
  QUIT_DRAIN_FLAG,
  QUIT_DRAIN_FLAG_COUNT,
  QUIT_DRAIN_RESULT_PREFIX,
  type QuitDrainHarnessResult,
} from './project-server-quit-drain.test-helper.ts';

process.stdin.on('end', () => process.exit(70));
process.stdin.resume();
process.stdin.unref();

const [projectDir, mode] = process.argv.slice(2);
if (projectDir === undefined || !isQuitDrainMode(mode)) {
  throw new Error(
    'usage: project-server-quit-drain.harness.ts <projectDir> <quit-after-start|quit-during-start>',
  );
}
const flags = new Int32Array(
  new SharedArrayBuffer(QUIT_DRAIN_FLAG_COUNT * Int32Array.BYTES_PER_ELEMENT),
);
const flag = (name: keyof typeof QUIT_DRAIN_FLAG): number =>
  Atomics.load(flags, QUIT_DRAIN_FLAG[name]);
const desktopPackageJson = fileURLToPath(new URL('../../package.json', import.meta.url));
type EventListener = Parameters<EventEmitter['on']>[1];

const utilityWorkers: Worker[] = [];
const postedToUtility: unknown[] = [];

function forkUtilityInWorker(): UtilityProcessLike {
  const { port1, port2 } = new MessageChannel();
  const events = new EventEmitter();
  const worker = new Worker(
    new URL('./project-server-quit-drain.worker.harness.ts', import.meta.url),
    {
      workerData: { port: port2, flags: flags.buffer, desktopPackageJson, mode },
      transferList: [port2],
    },
  );
  utilityWorkers.push(worker);
  port1.unref();
  port1.on('message', (msg: unknown) => {
    const message = msg as { type?: unknown; code?: unknown };
    if (message.type === 'quit-drain-harness:exit') {
      events.emit('exit', typeof message.code === 'number' ? message.code : null);
      return;
    }
    events.emit('message', msg);
  });
  return {
    pid: undefined,
    postMessage(msg: unknown) {
      postedToUtility.push(msg);
      port1.postMessage(msg);
    },
    on(event: 'message' | 'exit', cb: EventListener) {
      events.on(event, cb);
    },
    once(event: 'message' | 'spawn', cb: EventListener) {
      events.once(event, cb);
    },
    removeListener(event: 'message' | 'exit', cb: EventListener) {
      events.removeListener(event, cb);
    },
    kill: () => true,
  };
}

function makeProjectWindow(): BrowserWindowLike & { closeForQuit(): void } {
  const closedHandlers: Array<() => void> = [];
  let destroyed = false;
  return {
    focus() {},
    isDestroyed: () => destroyed,
    on(_event: 'closed', cb: () => void) {
      closedHandlers.push(cb);
    },
    once() {},
    webContents: {
      send() {},
      once() {},
      executeJavaScript: async () => undefined,
      setWindowOpenHandler() {},
      on() {},
    },
    loadFile: async () => {},
    loadURL: async () => {},
    closeForQuit() {
      destroyed = true;
      for (const handler of closedHandlers) handler();
    },
  };
}

async function untilWorker(condition: () => boolean): Promise<void> {
  for (;;) {
    const events = flag('workerEvents');
    if (condition()) return;
    const wake = Atomics.waitAsync(flags, QUIT_DRAIN_FLAG.workerEvents, events);
    if (wake.async) await wake.value;
  }
}

function releaseHeldNativeWork(): void {
  Atomics.store(flags, QUIT_DRAIN_FLAG.holdsReleased, flag('holdsBegun'));
  Atomics.notify(flags, QUIT_DRAIN_FLAG.holdsReleased);
}

const projectWindows: Array<ReturnType<typeof makeProjectWindow>> = [];
const wm = new WindowManager({
  createWindow: () => {
    const window = makeProjectWindow();
    projectWindows.push(window);
    return window;
  },
  forkUtility: () => forkUtilityInWorker(),
  utilityEntryPath: 'project-server-quit-drain.worker.harness.ts',
  rendererEntryPath: 'renderer-is-not-loaded.html',
  terminalAuthAvailable: false,
  appVersion: '0.0.0-quit-drain-harness',
  setTimeout: (cb, ms) => setTimeout(cb, ms).unref(),
  killProbe: () => {},
  readProcessStart: () => ({ startedAtMs: Date.now(), clock: 'creation' }),
  activateApp: () => {},
  showGate: { register: () => () => {}, fireThemeApplied: () => {} },
});

let quitDrainSettled = false;
let resolveQuitProceeds!: () => void;
const quitProceeds = new Promise<void>((resolve) => {
  resolveQuitProceeds = resolve;
});
const runQuitDrain = createTerminalQuitDrain({
  defer: (callback) => setImmediate(callback),
  drain: async () => {
    try {
      await drainAppOwnedWork({
        stopTerminals: async () => {},
        reapSlideDecks: async () => {},
        drainProjectServers: () => wm.drainOwnedUtilities(),
        onTerminalStopFailed: () => {},
      });
    } finally {
      quitDrainSettled = true;
    }
  },
  resumeQuit: () => emitWillQuit(),
});
function emitWillQuit(): void {
  let prevented = false;
  const event: QuitEventLike = {
    preventDefault() {
      prevented = true;
    },
  };
  runQuitDrain(event);
  if (!prevented) resolveQuitProceeds();
}

let nativeWorkReleasedWhileQuitHeld = 0;
async function untilElectronWouldFreeTheUtility(): Promise<QuitDrainHarnessResult['teardown']> {
  for (;;) {
    const events = flag('workerEvents');
    const held = flag('holdsBegun') - flag('holdsReleased');
    if (held > 0) {
      if (quitDrainSettled) return 'native-work-held';
      nativeWorkReleasedWhileQuitHeld += held;
      releaseHeldNativeWork();
      continue;
    }
    if (flag('exitCalled') === 1) {
      await quitProceeds;
      return 'utility-exited';
    }
    const wake = Atomics.waitAsync(flags, QUIT_DRAIN_FLAG.workerEvents, events);
    if (wake.async) await wake.value;
  }
}

let projectOpenOutcome: string | null = null;
let quitBeganWithNativeWorkHeld = false;
const opening = wm.createProjectWindow({ projectPath: projectDir }).then(
  () => 'opened',
  (err: unknown) => (err as { kind?: unknown }).kind?.toString() ?? 'failed',
);

if (mode === 'quit-after-start') {
  projectOpenOutcome = await opening;
  await untilWorker(() => flag('serverInitSettled') === 1);
  for (const window of projectWindows) window.closeForQuit();
  emitWillQuit();
} else {
  await untilWorker(() => flag('holdsBegun') > 0 || flag('serverInitSettled') === 1);
  quitBeganWithNativeWorkHeld = flag('holdsBegun') > 0;
  Atomics.store(flags, QUIT_DRAIN_FLAG.deliverParentMessagesOnRelease, 1);
  emitWillQuit();
}
const shutdownPostedToUtility = postedToUtility.some(
  (msg) => (msg as { type?: unknown }).type === 'shutdown',
);

const teardown = await untilElectronWouldFreeTheUtility();
const nativeOpsPendingAtTeardown = flag('nativeOpsPending');
if (teardown === 'utility-exited' && projectOpenOutcome === null) {
  projectOpenOutcome = await opening;
}

const utilityExited = flag('exitCalled') === 1;
const result: QuitDrainHarnessResult = {
  mode,
  quitBeganWithNativeWorkHeld,
  shutdownPostedToUtility,
  nativeOpsStartedDuringShutdown: flag('nativeOpsStartedDuringShutdown'),
  nativeWorkReleasedWhileQuitHeld,
  teardown,
  nativeOpsPendingAtTeardown,
  nativeSubscribes: flag('nativeSubscribes'),
  utilityExitCode: utilityExited ? flag('exitCode') : null,
  nativeOpsPendingAtExit: utilityExited ? flag('nativeOpsPendingAtExit') : null,
  subscriptionsUnreleasedAtExit: utilityExited ? flag('subscriptionsUnreleasedAtExit') : null,
  serverStartSettledBeforeExit: utilityExited ? flag('serverStartSettledAtExit') === 1 : null,
  projectOpenOutcome,
};
process.stdout.write(`${QUIT_DRAIN_RESULT_PREFIX}${JSON.stringify(result)}\n`);
await Promise.all(utilityWorkers.map((worker) => worker.terminate()));
