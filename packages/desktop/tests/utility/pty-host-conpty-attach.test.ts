import { execFileSync } from 'node:child_process';
import { closeSync, constants as fsConstants, mkdtempSync, openSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Worker } from 'node:worker_threads';
import type { IPty } from 'node-pty';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  type PtyHostOutgoingMessage,
  type PtySpawnOptions,
  type SpawnPty,
  setupPtyHost,
} from '../../src/utility/pty-host.ts';

type Backend = 'bundled-conpty-dll' | 'os-conpty-fallback';

type AttachPlan =
  | { kind: 'readiness-bound-fires-before-worker' }
  | { kind: 'worker-cannot-reach-conout' }
  | { kind: 'connect-throws'; message: string }
  | { kind: 'attached-then-silent-exit'; shellPid: number; nativeExitCode: number };

interface NativeConptyFake {
  startProcess(...args: unknown[]): { pty: number; fd: number; conin: string; conout: string };
  connect(...args: unknown[]): { pid: number };
  kill(...args: unknown[]): void;
  resize(...args: unknown[]): void;
  clear(...args: unknown[]): void;
}

interface Scenario {
  backend: Backend;
  plan: AttachPlan;
  dir: string;
  coninPath: string;
  coninReaderFd: number;
  conoutPath: string;
  conoutServer: Server;
  conoutSockets: Socket[];
  pseudoconsoles: number;
  connectCalls: number;
  nativeExit: ((exitCode: number) => void) | null;
  terminals: IPty[];
  nodePtyExit: { pid: number; exitCode: number | undefined } | null;
}

interface CreateOutcome {
  nodePtyExit: { pid: number; exitCode: number | undefined } | null;
  connectCalls: number;
  forwardedData: string;
  terminalMessages: PtyHostOutgoingMessage[];
}

const PTY_ID = 'attach-probe';
const PWSH = 'C:\\Program Files\\PowerShell\\7\\pwsh.exe';
const WINDOWS_ENV = {
  SystemRoot: 'C:\\Windows',
  ProgramFiles: 'C:\\Program Files',
  USERPROFILE: 'C:\\Users\\runneradmin',
  LOCALAPPDATA: 'C:\\Users\\runneradmin\\AppData\\Local',
  Path: 'C:\\Windows\\System32',
};
const ATTACH_OUTCOME_LIVENESS_BOUND_MS = 15_000;
const POLL_INTERVAL_MS = 10;
const ENCODING_WARNING = 'Setting encoding on Windows is not supported';

const realSetTimeout = globalThis.setTimeout;
const requireFromDesktop = createRequire(import.meta.url);
const nodePtyUtils = requireFromDesktop('node-pty/lib/utils.js') as {
  loadNativeModule: (name: string) => { dir: string; module: unknown };
};
const { WindowsPtyAgent } = requireFromDesktop('node-pty/lib/windowsPtyAgent.js') as {
  WindowsPtyAgent: { prototype: { _getConsoleProcessList: () => Promise<number[]> } };
};
const { WindowsTerminal } = requireFromDesktop('node-pty/lib/windowsTerminal.js') as {
  WindowsTerminal: new (file: string, args: string[] | string, options: PtySpawnOptions) => IPty;
};
const workerThreads = requireFromDesktop('node:worker_threads') as {
  Worker: typeof Worker;
};

const RealWorker = workerThreads.Worker;
const originalLoadNativeModule = nodePtyUtils.loadNativeModule;
const originalGetConsoleProcessList = WindowsPtyAgent.prototype._getConsoleProcessList;
const spawnedWorkers: Worker[] = [];
let active: Scenario | null = null;

function activeScenario(): Scenario {
  if (active === null) throw new Error('native ConPTY fake called outside a scenario');
  return active;
}

const nativeConptyFake: NativeConptyFake = {
  startProcess(...args) {
    if (args.length !== 7) {
      throw new Error(
        'Usage: pty.startProcess(file, cols, rows, debug, pipeName, inheritCursor, useConptyDll)',
      );
    }
    const scenario = activeScenario();
    const useConptyDll = args[6] === true;
    if (useConptyDll && scenario.backend === 'os-conpty-fallback') {
      throw new Error(
        'Cannot find conpty.dll at D:\\a\\node-pty\\build\\Release\\conpty\\conpty.dll, error code: 2',
      );
    }
    scenario.pseudoconsoles += 1;
    return {
      pty: scenario.pseudoconsoles,
      fd: -1,
      conin: scenario.coninPath,
      conout:
        scenario.plan.kind === 'worker-cannot-reach-conout'
          ? join(scenario.dir, 'no-conout-listener')
          : scenario.conoutPath,
    };
  },
  connect(...args) {
    if (args.length !== 6) {
      throw new Error('Usage: pty.connect(id, cmdline, cwd, env, useConptyDll, exitCallback)');
    }
    const scenario = activeScenario();
    scenario.connectCalls += 1;
    const plan = scenario.plan;
    if (plan.kind === 'connect-throws') throw new Error(plan.message);
    if (plan.kind !== 'attached-then-silent-exit') {
      throw new Error(`connect reached under plan ${plan.kind}`);
    }
    scenario.nativeExit = args[5] as (exitCode: number) => void;
    return { pid: plan.shellPid };
  },
  kill() {},
  resize() {},
  clear() {},
};

class RecordedWorker extends RealWorker {
  constructor(...args: ConstructorParameters<typeof RealWorker>) {
    super(...args);
    spawnedWorkers.push(this);
  }
}

const recordedSignals: Array<{ pid: number; signal: string | number | undefined }> = [];

function refuseRealSignal(pid: number, signal?: string | number): true {
  recordedSignals.push({ pid, signal });
  throw new Error('the ConPTY attach suite never sends a real signal');
}

async function openScenario(backend: Backend, plan: AttachPlan): Promise<Scenario> {
  const dir = mkdtempSync(join(tmpdir(), 'okcpty-'));
  const coninPath = join(dir, 'conin');
  execFileSync('mkfifo', [coninPath]);
  const coninReaderFd = openSync(coninPath, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK);
  const conoutPath = join(dir, 'conout');
  const conoutSockets: Socket[] = [];
  const conoutServer = createServer((socket) => {
    socket.on('error', () => {});
    conoutSockets.push(socket);
  });
  await new Promise<void>((resolve) => conoutServer.listen(conoutPath, resolve));
  return {
    backend,
    plan,
    dir,
    coninPath,
    coninReaderFd,
    conoutPath,
    conoutServer,
    conoutSockets,
    pseudoconsoles: 0,
    connectCalls: 0,
    nativeExit: null,
    terminals: [],
    nodePtyExit: null,
  };
}

async function closeScenario(scenario: Scenario): Promise<void> {
  await Promise.all(spawnedWorkers.splice(0).map((worker) => worker.terminate()));
  for (const socket of scenario.conoutSockets) socket.destroy();
  await new Promise<void>((resolve) => scenario.conoutServer.close(() => resolve()));
  closeSync(scenario.coninReaderFd);
  rmSync(scenario.dir, { recursive: true, force: true });
}

async function waitFor(predicate: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + ATTACH_OUTCOME_LIVENESS_BOUND_MS;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error(`liveness bound reached waiting for ${what}`);
    }
    await new Promise((resolve) => realSetTimeout(resolve, POLL_INTERVAL_MS));
  }
}

async function createThroughPtyHost(scenario: Scenario): Promise<CreateOutcome> {
  const posted: PtyHostOutgoingMessage[] = [];
  let handler: ((event: { data: unknown }) => void) | null = null;
  const spawn: SpawnPty = (file, args, options) => {
    const terminal = new WindowsTerminal(file, args, options);
    scenario.terminals.push(terminal);
    terminal.onExit(({ exitCode }) => {
      scenario.nodePtyExit = { pid: terminal.pid, exitCode };
    });
    return terminal;
  };
  const host = setupPtyHost({
    parentPort: {
      on(_event, h) {
        handler = h;
      },
      postMessage(message) {
        posted.push(message);
      },
    },
    spawn,
    env: WINDOWS_ENV,
    platform: 'win32',
    shellExists: (path) => path === PWSH,
    pathProbe: () => null,
  });
  const isTerminal = (message: PtyHostOutgoingMessage) =>
    message.ptyId === PTY_ID && (message.type === 'exit' || message.type === 'spawn-error');
  handler?.({
    data: { type: 'create', ptyId: PTY_ID, cwd: scenario.dir, cols: 80, rows: 24 },
  });

  const plan = scenario.plan;
  if (plan.kind === 'readiness-bound-fires-before-worker') {
    expect(vi.getTimerCount(), 'only the ConPTY worker readiness bound is pending').toBe(1);
    vi.advanceTimersToNextTimer();
  } else if (plan.kind === 'attached-then-silent-exit') {
    await waitFor(
      () => scenario.terminals.at(-1)?.pid === plan.shellPid,
      'the shell to attach and report its pid',
    );
    scenario.nativeExit?.(plan.nativeExitCode);
    for (const socket of scenario.conoutSockets) socket.end();
  }
  await waitFor(() => posted.some(isTerminal), 'the pty host to report how the session ended');
  host.killActive();

  return {
    nodePtyExit: scenario.nodePtyExit,
    connectCalls: scenario.connectCalls,
    forwardedData: posted
      .filter((message) => message.ptyId === PTY_ID && message.type === 'data')
      .map((message) => (message.type === 'data' ? message.data : ''))
      .join(''),
    terminalMessages: posted.filter(isTerminal),
  };
}

const BACKENDS: readonly Backend[] = ['bundled-conpty-dll', 'os-conpty-fallback'];

const NEVER_ATTACHED: ReadonlyArray<{
  name: string;
  plan: AttachPlan;
  connectCalls: number;
  nodePtyExitCode: number;
}> = [
  {
    name: 'the ConPTY output worker is not ready within the node-pty readiness bound',
    plan: { kind: 'readiness-bound-fires-before-worker' },
    connectCalls: 0,
    nodePtyExitCode: -1,
  },
  {
    name: 'the ConPTY output worker fails before it is ready',
    plan: { kind: 'worker-cannot-reach-conout' },
    connectCalls: 0,
    nodePtyExitCode: -1,
  },
  {
    name: 'ConPTY cannot create the shell process',
    plan: { kind: 'connect-throws', message: 'Cannot create process, error code: 2' },
    connectCalls: 1,
    nodePtyExitCode: 2,
  },
];

const SILENT_SHELL_PID = 4242;

describe.skipIf(process.platform === 'win32')(
  'pty host over the real node-pty Windows terminal: how a session that ends is reported',
  () => {
    let signalSeam: ReturnType<typeof vi.spyOn>;
    let warnSeam: ReturnType<typeof vi.spyOn>;
    let scenario: Scenario | null = null;

    beforeAll(() => {
      nodePtyUtils.loadNativeModule = (name) => {
        if (name !== 'conpty') throw new Error(`unexpected native module ${name}`);
        return { dir: 'unverified-native-fake', module: nativeConptyFake };
      };
      WindowsPtyAgent.prototype._getConsoleProcessList = () => Promise.resolve([]);
      workerThreads.Worker = RecordedWorker;
    });

    afterAll(() => {
      nodePtyUtils.loadNativeModule = originalLoadNativeModule;
      WindowsPtyAgent.prototype._getConsoleProcessList = originalGetConsoleProcessList;
      workerThreads.Worker = RealWorker;
    });

    beforeEach(() => {
      recordedSignals.length = 0;
      signalSeam = vi.spyOn(process, 'kill').mockImplementation(refuseRealSignal);
      const forwardWarn = console.warn.bind(console);
      warnSeam = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
        if (args[0] !== ENCODING_WARNING) forwardWarn(...args);
      });
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    });

    afterEach(async () => {
      vi.useRealTimers();
      active = null;
      if (scenario !== null) await closeScenario(scenario);
      scenario = null;
      signalSeam.mockRestore();
      warnSeam.mockRestore();
      expect(recordedSignals, 'no real signal may leave the suite').toEqual([]);
    });

    async function run(backend: Backend, plan: AttachPlan): Promise<CreateOutcome> {
      scenario = await openScenario(backend, plan);
      active = scenario;
      return createThroughPtyHost(scenario);
    }

    describe.each(BACKENDS)('%s', (backend) => {
      test.each(NEVER_ATTACHED)(
        'reports a start failure, not a shell exit, when $name',
        async ({ plan, connectCalls, nodePtyExitCode }) => {
          const outcome = await run(backend, plan);

          expect(outcome.connectCalls, 'scenario reached the intended attach step').toBe(
            connectCalls,
          );
          expect(
            outcome.nodePtyExit,
            'node-pty drift: a never-attached Windows pty must still report pid 0 at exit',
          ).toEqual({ pid: 0, exitCode: nodePtyExitCode });
          expect(outcome.forwardedData).toBe('');
          expect(outcome.terminalMessages).toEqual([
            {
              type: 'spawn-error',
              ptyId: PTY_ID,
              shellNeverAttached: true,
              exitCode: nodePtyExitCode,
            },
          ]);
        },
      );

      test('still reports a shell exit when an attached shell exits -1 without output', async () => {
        const outcome = await run(backend, {
          kind: 'attached-then-silent-exit',
          shellPid: SILENT_SHELL_PID,
          nativeExitCode: -1,
        });

        expect(outcome.connectCalls, 'scenario reached the intended attach step').toBe(1);
        expect(
          outcome.nodePtyExit,
          'node-pty drift: an attached Windows pty must report the shell pid at exit',
        ).toEqual({ pid: SILENT_SHELL_PID, exitCode: -1 });
        expect(outcome.forwardedData).toBe('');
        expect(outcome.terminalMessages).toEqual([
          { type: 'exit', ptyId: PTY_ID, exitCode: -1, signal: null },
        ]);
      });
    });
  },
);
