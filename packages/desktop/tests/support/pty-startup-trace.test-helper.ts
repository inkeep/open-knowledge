import { getEnvironmentData, setEnvironmentData, type Worker } from 'node:worker_threads';
import type {
  PtyStartupNativeSnapshot,
  PtyStartupSpawnContext,
  PtyStartupTraceOptions,
} from '../../src/utility/pty-host.ts';

export const PTY_STARTUP_WORKER_CONTEXT = 'ok-pty-startup-worker-trace-v1';

const NATIVE_BYTES = 0;
const WORKER_SUBMITTED_BYTES = 1;
const NATIVE_CONNECTED = 2;
const FORWARDING_CONNECTED = 3;
const NATIVE_CLOSED = 4;
const FORWARDING_CLOSED = 5;
const NATIVE_ERROR = 6;
const FORWARDING_ERROR = 7;
const WORKER_WRITER_ERROR = 8;
const CAPTURE_INSTALLED = 9;
const COUNTER_LENGTH = 11;

interface WorkerTraceContext {
  tag: 'ok-pty-startup-worker-trace-v1';
  traceId: number;
  attempt: number;
  startedAt: number;
  backend: PtyStartupSpawnContext['backend'];
  counters: SharedArrayBuffer;
  outputFd?: number;
}

interface EventSource {
  on(event: string, listener: (...args: never[]) => void): unknown;
  off(event: string, listener: (...args: never[]) => void): unknown;
  prependListener(event: string, listener: (...args: never[]) => void): unknown;
}

interface SocketState extends EventSource {
  destroyed: boolean;
  connecting: boolean;
  bytesRead: number;
  readableLength: number;
  writableLength: number;
}

interface ConoutState {
  _worker: Worker;
  _isDisposed: boolean;
}

interface AgentState {
  _conoutSocketWorker: ConoutState;
  _outSocket: SocketState;
  _inSocket: SocketState;
  _completePtyConnection: () => unknown;
  _$onProcessExit: (exitCode: number) => unknown;
  _pendingPtyInfo: unknown;
  innerPid: number;
  exitCode: number | undefined;
}

interface TerminalState {
  _agent: AgentState;
}

function isEventSource(value: unknown): value is EventSource {
  if (typeof value !== 'object' || value === null) return false;
  const source = value as Partial<EventSource>;
  return (
    typeof source.on === 'function' &&
    typeof source.off === 'function' &&
    typeof source.prependListener === 'function'
  );
}

function isSocketState(value: unknown): value is SocketState {
  if (!isEventSource(value)) return false;
  const socket = value as Partial<SocketState>;
  return (
    typeof socket.destroyed === 'boolean' &&
    typeof socket.connecting === 'boolean' &&
    typeof socket.bytesRead === 'number' &&
    typeof socket.readableLength === 'number' &&
    typeof socket.writableLength === 'number'
  );
}

function inspectTerminal(value: unknown): TerminalState | null {
  if (typeof value !== 'object' || value === null || !('_agent' in value)) return null;
  const agent = value._agent;
  if (typeof agent !== 'object' || agent === null) return null;
  if (!('_conoutSocketWorker' in agent) || !('_outSocket' in agent) || !('_inSocket' in agent))
    return null;
  if (!isSocketState(agent._outSocket) || !isSocketState(agent._inSocket)) return null;
  const conout = agent._conoutSocketWorker;
  if (typeof conout !== 'object' || conout === null || !('_worker' in conout)) return null;
  const worker = conout._worker;
  if (
    !isEventSource(worker) ||
    !('threadId' in worker) ||
    typeof worker.threadId !== 'number' ||
    !('_isDisposed' in conout) ||
    typeof conout._isDisposed !== 'boolean' ||
    !('_completePtyConnection' in agent) ||
    typeof agent._completePtyConnection !== 'function' ||
    !('_$onProcessExit' in agent) ||
    typeof agent._$onProcessExit !== 'function' ||
    !('_pendingPtyInfo' in agent) ||
    !('innerPid' in agent) ||
    typeof agent.innerPid !== 'number' ||
    ('exitCode' in agent && agent.exitCode !== undefined && typeof agent.exitCode !== 'number')
  )
    return null;
  return value as TerminalState;
}

export function createPtyStartupWorkerContext(
  context: PtyStartupSpawnContext,
  outputFd?: number,
): WorkerTraceContext {
  return {
    tag: 'ok-pty-startup-worker-trace-v1',
    traceId: context.traceId,
    attempt: context.attempt,
    startedAt: context.startedAt,
    backend: context.backend,
    counters: new SharedArrayBuffer(BigInt64Array.BYTES_PER_ELEMENT * COUNTER_LENGTH),
    ...(outputFd === undefined ? {} : { outputFd }),
  };
}

export const windowsPtyStartupTrace: PtyStartupTraceOptions = {
  aroundSpawn(next, context) {
    const previous = getEnvironmentData(PTY_STARTUP_WORKER_CONTEXT);
    const workerContext = createPtyStartupWorkerContext(context);
    let pty: ReturnType<typeof next>;
    setEnvironmentData(PTY_STARTUP_WORKER_CONTEXT, workerContext);
    try {
      pty = next();
    } finally {
      setEnvironmentData(PTY_STARTUP_WORKER_CONTEXT, previous);
    }

    const terminal = inspectTerminal(pty);
    if (terminal === null) {
      context.emit({ stage: 'observer-unavailable', reason: 'unsupported-node-pty-shape' });
      return { pty };
    }

    const agent = terminal._agent;
    const conout = agent._conoutSocketWorker;
    const worker = conout._worker;
    const output = agent._outSocket;
    const input = agent._inSocket;
    const counters = new BigInt64Array(workerContext.counters);
    let online = false;
    let readyReceived = false;
    let errorObserved = false;
    let workerExitCode: number | null = null;
    let nativeExitObserved = false;
    let nativeExitCode: number | null = null;
    let connection: PtyStartupNativeSnapshot['console']['connection'] = 'pending';
    let disposed = false;

    const listeners: Array<{
      source: EventSource;
      event: string;
      listener: (...args: never[]) => void;
    }> = [];
    const observe = (
      source: EventSource,
      event: string,
      listener: (...args: never[]) => void,
      prepend = false,
    ) => {
      if (prepend) source.prependListener(event, listener);
      else source.on(event, listener);
      listeners.push({ source, event, listener });
    };

    observe(worker, 'online', () => {
      online = true;
      context.emit({ stage: 'worker-online' });
    });
    observe(
      worker,
      'message',
      (message: unknown) => {
        if (message !== 1 || readyReceived) return;
        readyReceived = true;
        context.emit({ stage: 'worker-ready-received' });
      },
      true,
    );
    observe(
      worker,
      'error',
      () => {
        errorObserved = true;
        context.emit({ stage: 'worker-error' });
      },
      true,
    );
    observe(
      worker,
      'exit',
      (code: number) => {
        workerExitCode = code;
        context.emit({ stage: 'worker-exit', exitCode: code });
      },
      true,
    );
    observe(output, 'connect', () => context.emit({ stage: 'data-pipe-connected' }));

    const complete = agent._completePtyConnection;
    const observedComplete = function (this: AgentState) {
      if (!this._pendingPtyInfo) return Reflect.apply(complete, this, []);
      connection = 'entered';
      context.emit({ stage: 'native-connect-enter', boundary: 'agent-complete-connection' });
      try {
        const result = Reflect.apply(complete, this, []);
        if (this.innerPid > 0 && this.exitCode === undefined) {
          connection = 'returned';
          context.emit({ stage: 'native-connect-return', shellPid: this.innerPid });
        } else {
          connection = 'failed';
          context.emit({ stage: 'native-connect-failed' });
        }
        return result;
      } catch (error) {
        connection = 'failed';
        context.emit({ stage: 'native-connect-failed' });
        throw error;
      }
    };
    agent._completePtyConnection = observedComplete;

    const onProcessExit = agent._$onProcessExit;
    const observedExit = function (this: AgentState, exitCode: number) {
      nativeExitObserved = true;
      nativeExitCode = exitCode;
      context.emit({
        stage: 'native-shell-exit',
        shellPid: this.innerPid > 0 ? this.innerPid : null,
        exitCode,
      });
      return Reflect.apply(onProcessExit, this, [exitCode]);
    };
    agent._$onProcessExit = observedExit;

    return {
      pty,
      snapshot() {
        return {
          shell: {
            pid: agent.innerPid > 0 ? agent.innerPid : null,
            nativeExitObserved,
            exitCode: nativeExitCode,
            osState: 'unobserved',
          },
          console: {
            backend: context.backend,
            connection,
            outputConnectionDisposed: conout._isDisposed,
            osState: 'unobserved',
          },
          worker: {
            threadId: worker.threadId,
            online,
            readyReceived,
            errorObserved,
            writerError: Atomics.load(counters, WORKER_WRITER_ERROR) !== 0n,
            exitCode: workerExitCode,
            osState: 'unobserved',
          },
          transport: {
            capture: Atomics.load(counters, CAPTURE_INSTALLED) !== 0n ? 'installed' : 'missing',
            nativeBytes: Number(Atomics.load(counters, NATIVE_BYTES)),
            workerSubmittedBytes: Number(Atomics.load(counters, WORKER_SUBMITTED_BYTES)),
            mainBytes: output.bytesRead,
            nativeConnected: Atomics.load(counters, NATIVE_CONNECTED) !== 0n,
            forwardingConnected: Atomics.load(counters, FORWARDING_CONNECTED) !== 0n,
            nativeClosed: Atomics.load(counters, NATIVE_CLOSED) !== 0n,
            forwardingClosed: Atomics.load(counters, FORWARDING_CLOSED) !== 0n,
            nativeError: Atomics.load(counters, NATIVE_ERROR) !== 0n,
            forwardingError: Atomics.load(counters, FORWARDING_ERROR) !== 0n,
            mainDestroyed: output.destroyed,
            mainConnecting: output.connecting,
            mainReadableLength: output.readableLength,
            inputWritableLength: input.writableLength,
          },
        } satisfies PtyStartupNativeSnapshot;
      },
      dispose() {
        if (disposed) return;
        disposed = true;
        for (const { source, event, listener } of listeners) source.off(event, listener);
        if (agent._completePtyConnection === observedComplete)
          agent._completePtyConnection = complete;
        if (agent._$onProcessExit === observedExit) agent._$onProcessExit = onProcessExit;
      },
    };
  },
};

interface HarnessScenarioHost {
  snapshot(): void;
  release(): void;
}

interface HarnessScenarioRunnerOptions {
  titles: readonly string[];
  grantMs(before: string): number;
  isRefusal(error: unknown): boolean;
  print(line: string): void;
}

type ScenarioOutcome = 'passed' | 'failed' | 'refused';

export function createHarnessScenarioRunner(options: HarnessScenarioRunnerOptions) {
  const results: Array<{ name: string; outcome: ScenarioOutcome; detail?: string }> = [];
  const unrun = new Set(options.titles);
  const owned: HarnessScenarioHost[] = [];
  let inFlight: string | null = null;

  const tally = (outcome: ScenarioOutcome): number =>
    results.filter((result) => result.outcome === outcome).length;

  const producedNoResult = (): number => unrun.size + (inFlight === null ? 0 : 1);

  const verdictLine = (detail: string): string =>
    `HARNESS_RESULT ok=${tally('passed')} fail=${tally('failed') + producedNoResult()} refused=${tally('refused')}${detail}`;

  return {
    own(host: HarnessScenarioHost): void {
      owned.push(host);
    },
    async run(name: string, fn: (deadlineAt: number) => Promise<void>): Promise<void> {
      if (!unrun.delete(name)) {
        results.push({
          name,
          outcome: 'failed',
          detail: 'not a title the harness roster declares',
        });
        options.print(`FAIL ${name} :: not a title the harness roster declares`);
        return;
      }
      inFlight = name;
      try {
        const deadlineAt = performance.now() + options.grantMs('this scenario started');
        await fn(deadlineAt);
        results.push({ name, outcome: 'passed' });
        options.print(`PASS ${name}`);
      } catch (err) {
        for (const host of owned) host.snapshot();
        const outcome = options.isRefusal(err) ? 'refused' : 'failed';
        results.push({ name, outcome, detail: (err as Error).message });
        options.print(
          `${outcome === 'refused' ? 'REFUSED' : 'FAIL'} ${name} :: ${(err as Error).message}`,
        );
      } finally {
        inFlight = null;
        for (const host of owned.splice(0)) host.release();
      }
    },
    verdictLine,
    hardTimeoutVerdict(): string {
      for (const host of owned) host.snapshot();
      return verdictLine(` :: hard timeout during ${inFlight ?? 'startup'}`);
    },
    unrunTitles: (): string[] => [...unrun],
    passed: (): boolean => tally('failed') === 0 && tally('refused') === 0,
  };
}
