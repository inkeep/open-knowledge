import fs, {
  chmodSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  open,
  openSync,
  renameSync,
  type StatWatcher,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { stat } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { dirname } from 'node:path';
import timers from 'node:timers';
import { promisify } from 'node:util';
import type {
  ContractCommand,
  ContractSpec,
  LoggedError,
  MutationTiming,
  ReadinessScenario,
  ReadinessSpec,
  Recovery,
  WatcherEntry,
  WatcherEvent,
  WatcherProcessReport,
  WatcherProcessSpec,
} from './forked-watcher-process.test-helper.ts';
import { loggerFactory, PinoLogger } from './logger.ts';

type StopWatcher = () => Promise<void>;

type StartWatcher = (
  watch: readonly string[],
  deliver: (event: WatcherEvent) => void,
) => Promise<StopWatcher>;

type AnyFunction = (...args: never[]) => unknown;

type BarrierState = 'not-engaged' | 'held' | 'released';

type SampleOutcome = { size: number } | { listed: number } | { code: string };

type SampleForm = 'callback' | 'promise' | 'sync';

interface SampleHook {
  before?(form: SampleForm): void;
  hold?(form: SampleForm): Promise<void> | undefined;
  after?(outcome: SampleOutcome): void;
}

type ErrorPhase = 'landing' | 'establishing' | 'persisting';

type StagePhase = 'entering' | 'landing' | 'establishing';

type OutcomeTest = (outcome: SampleOutcome) => boolean;

interface ErrorStage {
  enteredAt: string;
  observedAt: string;
  enter?(): void;
  holds: OutcomeTest;
}

type CommandOf<Op extends ContractCommand['op']> = Extract<ContractCommand, { op: Op }>;

const NS_PER_MS = 1_000_000n;

const TIMESTAMP_GRANULE_NS = 1_000_000_000n;

function report(message: WatcherProcessReport): void {
  if (process.connected) process.send?.(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function text(record: Record<string, unknown>, name: string): string {
  const value = record[name];
  if (typeof value !== 'string' || value === '') {
    throw new Error(`watcher process: ${name} must be a non-empty string`);
  }
  return value;
}

function oneOf<Choice extends string>(value: string, choices: readonly Choice[]): Choice {
  const choice = choices.find((candidate) => candidate === value);
  if (choice === undefined) throw new Error(`watcher process: unexpected ${value}`);
  return choice;
}

function paths(record: Record<string, unknown>, name: string): string[] {
  const value = record[name];
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`watcher process: ${name} must list at least one path`);
  }
  return value.map((path) => {
    if (typeof path !== 'string' || path === '') {
      throw new Error(`watcher process: ${name} must list paths`);
    }
    return path;
  });
}

function parseSpec(raw: string | undefined): WatcherProcessSpec {
  const spec: unknown = JSON.parse(raw ?? 'null');
  if (!isRecord(spec)) throw new Error('watcher process: missing spec');
  const entry = oneOf<WatcherEntry>(text(spec, 'entry'), ['managed', 'config', 'multi-config']);
  const watch = paths(spec, 'watch');
  if (oneOf(text(spec, 'mode'), ['readiness', 'contract']) === 'contract') {
    if (spec.coarseTimestampsAt === undefined) return { mode: 'contract', entry, watch };
    return { mode: 'contract', entry, watch, coarseTimestampsAt: text(spec, 'coarseTimestampsAt') };
  }
  return {
    mode: 'readiness',
    entry,
    watch,
    scenario: oneOf<ReadinessScenario>(text(spec, 'scenario'), ['create', 'edit']),
    timing: oneOf<MutationTiming>(text(spec, 'timing'), [
      'as-start-resolves',
      'while-first-baseline-stat-held',
      'after-first-baseline-stat',
    ]),
    target: text(spec, 'target'),
    held: text(spec, 'held'),
    content: text(spec, 'content'),
    barrier: text(spec, 'barrier'),
  };
}

function parseCommand(message: unknown): ContractCommand {
  if (!isRecord(message)) throw new Error('watcher process: malformed command');
  const op = oneOf(text(message, 'op'), [
    'write-in-two-steps',
    'unreadable-until-sampled',
    'close-while-sampling',
    'hold-next-sample',
    'unreadable-across-polls',
    'unreadable-again-after-recovery',
    'error-code-changes-while-failing',
    'close-between-polls',
    'close-while-sample-held',
    'two-step-write-across-interruption',
    'rewrite-in-place',
  ]);
  if (op === 'close-between-polls') return { op, path: text(message, 'path') };
  if (op === 'close-while-sample-held') {
    return {
      op,
      path: text(message, 'path'),
      dir: text(message, 'dir'),
      barrier: text(message, 'barrier'),
    };
  }
  if (op === 'two-step-write-across-interruption') {
    return {
      op,
      path: text(message, 'path'),
      dir: text(message, 'dir'),
      partial: text(message, 'partial'),
      complete: text(message, 'complete'),
      interruption: oneOf(text(message, 'interruption'), ['unreadable', 'removed'] as const),
    };
  }
  if (op === 'write-in-two-steps') {
    return {
      op,
      path: text(message, 'path'),
      partial: text(message, 'partial'),
      complete: text(message, 'complete'),
    };
  }
  if (op === 'unreadable-until-sampled') {
    return { op, dir: text(message, 'dir'), leaf: text(message, 'leaf') };
  }
  if (op === 'hold-next-sample') {
    return {
      op,
      path: text(message, 'path'),
      content: text(message, 'content'),
      barrier: text(message, 'barrier'),
    };
  }
  if (op === 'unreadable-across-polls') {
    return { op, dir: text(message, 'dir'), path: text(message, 'path') };
  }
  if (op === 'unreadable-again-after-recovery') {
    return {
      op,
      dir: text(message, 'dir'),
      failingAt: text(message, 'failingAt'),
      sampledEveryPoll: text(message, 'sampledEveryPoll'),
      recovery: oneOf<Recovery>(text(message, 'recovery'), [
        'readable',
        'removed',
        'replaced-by-file',
      ]),
      aside: text(message, 'aside'),
    };
  }
  if (op === 'error-code-changes-while-failing') {
    return {
      op,
      dir: text(message, 'dir'),
      failingAt: text(message, 'failingAt'),
      aside: text(message, 'aside'),
    };
  }
  return { op, path: text(message, 'path'), content: text(message, 'content') };
}

async function loadWatcher(entry: WatcherEntry): Promise<StartWatcher> {
  if (entry === 'managed') {
    const { startManagedArtifactWatcher } = await import('./managed-artifact-watcher.ts');
    return (watch, deliver) =>
      startManagedArtifactWatcher(
        watch,
        (path, content) => deliver({ kind: 'change', path, content }),
        (path) => deliver({ kind: 'unlink', path }),
      );
  }
  const { startConfigFileWatcher, startMultiPathConfigFileWatcher } = await import(
    './config-file-watcher.ts'
  );
  if (entry === 'multi-config') {
    return (watch, deliver) =>
      startMultiPathConfigFileWatcher(watch, (path, content) =>
        deliver({ kind: 'change', path, content }),
      );
  }
  return (watch, deliver) => {
    const [path] = watch;
    if (path === undefined || watch.length !== 1) {
      throw new Error('watcher process: startConfigFileWatcher watches exactly one path');
    }
    return startConfigFileWatcher(path, (content) => deliver({ kind: 'change', path, content }));
  };
}

function assertFifo(fifo: string): void {
  if (!statSync(fifo).isFIFO()) throw new Error(`watcher process: ${fifo} is not a FIFO`);
}

function blockTheOnlyWorker(fifo: string): () => void {
  let releaseFd: number | undefined;
  let released = false;
  open(fifo, 'r', (error, readFd) => {
    if (error) throw error;
    closeSync(readFd);
    if (releaseFd !== undefined) closeSync(releaseFd);
    releaseFd = undefined;
  });
  const release = (): void => {
    if (released) return;
    released = true;
    releaseFd = openSync(fifo, 'r+');
  };
  process.on('exit', release);
  return release;
}

function holdFirstBaselineStat(
  samples: ReturnType<typeof observeWatcherSamples>,
  heldPath: string,
  fifo: string,
  onHeld: (heldBy: 'watchFile' | 'sample') => void,
) {
  assertFifo(fifo);
  let watchFileState: BarrierState = 'not-engaged';
  let sampleState: BarrierState = 'not-engaged';
  let sampleLanded = false;
  let starting = true;
  let releaseWorker: () => void = () => {};
  let releaseSample: () => void = () => {};
  let markReleased: () => void = () => {};
  const released = new Promise<void>((resolve) => {
    markReleased = resolve;
  });
  const letSampleRun = (): void => {
    if (sampleState !== 'held') return;
    releaseSample();
    sampleState = 'released';
  };
  const release = (): void => {
    letSampleRun();
    if (watchFileState === 'held') {
      releaseWorker();
      watchFileState = 'released';
    }
    markReleased();
  };
  const originalWatchFile = fs.watchFile;
  function watchFileBehindBarrier(this: unknown, ...args: unknown[]): StatWatcher {
    if (watchFileState === 'not-engaged' && args[0] === heldPath) {
      watchFileState = 'held';
      releaseWorker = blockTheOnlyWorker(fifo);
      onHeld('watchFile');
    }
    return Reflect.apply(originalWatchFile, this, args);
  }
  Object.assign(fs, { watchFile: watchFileBehindBarrier });
  syncBuiltinESMExports();
  samples.watch(heldPath, {
    hold(form) {
      samples.unwatch(heldPath);
      if (form === 'sync' || !starting) return undefined;
      sampleState = 'held';
      const gate = new Promise<void>((resolve) => {
        releaseSample = resolve;
      });
      onHeld('sample');
      return gate;
    },
    after() {
      sampleLanded = true;
    },
  });
  process.on('exit', release);
  return {
    engaged: (): boolean => watchFileState !== 'not-engaged' || sampleState !== 'not-engaged',
    held: (): boolean =>
      watchFileState === 'held' || (sampleState !== 'not-engaged' && !sampleLanded),
    starting: (): boolean => starting,
    startResolved: (): void => {
      starting = false;
    },
    letSampleRun,
    release,
    released,
  };
}

function trackStartupTimers() {
  const running = new Set<unknown>();
  const beforeNextTick: Array<() => void> = [];
  let armedWhileStarting = 0;
  let starting = false;
  let onStopped: () => void = () => {};
  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;
  const originalClearTimeout = globalThis.clearTimeout;
  function setIntervalTracked(this: unknown, callback: AnyFunction, ...rest: unknown[]): unknown {
    let handle: unknown;
    function tick(this: unknown, ...args: unknown[]): void {
      if (running.has(handle)) for (const action of beforeNextTick.splice(0)) action();
      Reflect.apply(callback, this, args);
    }
    handle = Reflect.apply(originalSetInterval, this, [tick, ...rest]);
    if (starting) {
      armedWhileStarting += 1;
      running.add(handle);
    }
    return handle;
  }
  const clearTracked = (original: AnyFunction) =>
    function (this: unknown, handle: unknown): void {
      if (running.delete(handle)) onStopped();
      Reflect.apply(original, this, [handle]);
    };
  const replacements = {
    setInterval: setIntervalTracked,
    clearInterval: clearTracked(originalClearInterval),
    clearTimeout: clearTracked(originalClearTimeout),
  };
  Object.assign(globalThis, replacements);
  Object.assign(timers, replacements);
  syncBuiltinESMExports();
  return {
    async whileStarting<Started>(start: () => Promise<Started>): Promise<Started> {
      starting = true;
      try {
        return await start();
      } finally {
        starting = false;
      }
    },
    armedWhileStarting: () => armedWhileStarting,
    running: () => running.size,
    allStopped: () =>
      new Promise<void>((resolve) => {
        onStopped = () => {
          if (running.size === 0) resolve();
        };
        onStopped();
      }),
    beforeNextTick(action: () => void): boolean {
      if (running.size === 0) return false;
      beforeNextTick.push(action);
      return true;
    },
  };
}

function trackPendingTimers() {
  const pending = new Set<unknown>();
  const settledListeners = new Set<(handle: unknown) => void>();
  const originalSetTimeout = globalThis.setTimeout;
  const settled = (handle: unknown): void => {
    for (const listener of settledListeners) listener(handle);
  };
  const armTracked = (original: AnyFunction, repeats: boolean) =>
    function (this: unknown, callback: AnyFunction, ...rest: unknown[]): unknown {
      let handle: unknown;
      function fire(this: unknown, ...args: unknown[]): void {
        if (repeats ? pending.has(handle) : pending.delete(handle)) settled(handle);
        Reflect.apply(callback, this, args);
      }
      handle = Reflect.apply(original, this, [fire, ...rest]);
      pending.add(handle);
      return handle;
    };
  const clearTracked = (original: AnyFunction) =>
    function (this: unknown, handle: unknown): void {
      if (pending.delete(handle)) settled(handle);
      Reflect.apply(original, this, [handle]);
    };
  const setTimeoutTracked = armTracked(originalSetTimeout, false);
  Object.defineProperty(setTimeoutTracked, promisify.custom, {
    value: Reflect.get(originalSetTimeout, promisify.custom),
  });
  const replacements = {
    setTimeout: setTimeoutTracked,
    setInterval: armTracked(globalThis.setInterval, true),
    clearTimeout: clearTracked(globalThis.clearTimeout),
    clearInterval: clearTracked(globalThis.clearInterval),
  };
  Object.assign(globalThis, replacements);
  Object.assign(timers, replacements);
  syncBuiltinESMExports();
  return {
    eachPendingTimerSettled(): Promise<number> {
      const awaited = new Set(pending);
      const waitedOut = awaited.size;
      return new Promise((resolve) => {
        let done = false;
        const onSettled = (handle: unknown): void => {
          if (awaited.delete(handle)) setImmediate(check);
        };
        function check(): void {
          if (done || awaited.size > 0) return;
          done = true;
          settledListeners.delete(onSettled);
          resolve(waitedOut);
        }
        settledListeners.add(onSettled);
        setImmediate(check);
      });
    },
  };
}

function errnoOf(error: unknown): string {
  if (isRecord(error) && typeof error.code === 'string') return error.code;
  return 'unknown';
}

type OutcomeOf = (error: unknown, result: unknown) => SampleOutcome;

function observeWatcherSamples() {
  const hooks = new Map<string, SampleHook>();
  const statOutcome: OutcomeOf = (error, stats) => {
    if (error) return { code: errnoOf(error) };
    if (isRecord(stats) && (typeof stats.size === 'number' || typeof stats.size === 'bigint')) {
      return { size: Number(stats.size) };
    }
    return { code: 'ENOENT' };
  };
  const listingOutcome: OutcomeOf = (error, entries) => {
    if (error) return { code: errnoOf(error) };
    return { listed: Array.isArray(entries) ? entries.length : 0 };
  };
  const callbackForm = (original: AnyFunction, outcomeOf: OutcomeOf = statOutcome) =>
    function (this: unknown, ...args: unknown[]): unknown {
      const hook = hooks.get(String(args[0]));
      const callback = args.at(-1);
      if (hook === undefined || typeof callback !== 'function') {
        return Reflect.apply(original, this, args);
      }
      hook.before?.('callback');
      const gate = hook.hold?.('callback');
      const sample = (): unknown =>
        Reflect.apply(original, this, [
          ...args.slice(0, -1),
          (error: unknown, stats: unknown) => {
            hook.after?.(outcomeOf(error, stats));
            Reflect.apply(callback, undefined, [error, stats]);
          },
        ]);
      if (gate === undefined) return sample();
      void gate.then(sample);
      return undefined;
    };
  const promiseForm = (original: AnyFunction, outcomeOf: OutcomeOf = statOutcome) =>
    function (this: unknown, ...args: unknown[]): unknown {
      const hook = hooks.get(String(args[0]));
      if (hook === undefined) return Reflect.apply(original, this, args);
      hook.before?.('promise');
      const gate = hook.hold?.('promise');
      const sampled: Promise<unknown> =
        gate === undefined
          ? Reflect.apply(original, this, args)
          : gate.then(() => Reflect.apply(original, this, args));
      return sampled.then(
        (stats) => {
          hook.after?.(outcomeOf(null, stats));
          return stats;
        },
        (error: unknown) => {
          hook.after?.(outcomeOf(error, undefined));
          throw error;
        },
      );
    };
  const syncForm = (original: AnyFunction, outcomeOf: OutcomeOf = statOutcome) =>
    function (this: unknown, ...args: unknown[]): unknown {
      const hook = hooks.get(String(args[0]));
      if (hook === undefined) return Reflect.apply(original, this, args);
      hook.before?.('sync');
      let stats: unknown;
      try {
        stats = Reflect.apply(original, this, args);
      } catch (error) {
        hook.after?.(outcomeOf(error, undefined));
        throw error;
      }
      hook.after?.(outcomeOf(null, stats));
      return stats;
    };
  Object.assign(fs, {
    stat: callbackForm(fs.stat),
    lstat: callbackForm(fs.lstat),
    statSync: syncForm(fs.statSync),
    lstatSync: syncForm(fs.lstatSync),
    readdir: callbackForm(fs.readdir, listingOutcome),
    readdirSync: syncForm(fs.readdirSync, listingOutcome),
  });
  Object.assign(fs.promises, {
    stat: promiseForm(fs.promises.stat),
    lstat: promiseForm(fs.promises.lstat),
    readdir: promiseForm(fs.promises.readdir, listingOutcome),
  });
  syncBuiltinESMExports();
  return {
    watch: (path: string, hook: SampleHook): void => {
      hooks.set(path, hook);
    },
    unwatch: (path: string): void => {
      hooks.delete(path);
    },
  };
}

function wallClockNs(): bigint {
  return BigInt(Date.now()) * NS_PER_MS;
}

function changedAtNs(stats: Record<string, unknown>): bigint | undefined {
  if (typeof stats.ctimeNs === 'bigint') return stats.ctimeNs;
  if (typeof stats.ctimeMs === 'number') return BigInt(Math.floor(stats.ctimeMs)) * NS_PER_MS;
  return undefined;
}

function restampIntoGranule(stats: unknown, granuleStartNs: bigint): unknown {
  if (!isRecord(stats)) return stats;
  const changedNs = changedAtNs(stats);
  if (changedNs === undefined || changedNs >= granuleStartNs + TIMESTAMP_GRANULE_NS) return stats;
  const granuleStartMs = granuleStartNs / NS_PER_MS;
  const stamp = new Date(Number(granuleStartMs));
  if (typeof stats.ctimeNs === 'bigint') {
    Object.assign(stats, {
      mtimeNs: granuleStartNs,
      ctimeNs: granuleStartNs,
      mtimeMs: granuleStartMs,
      ctimeMs: granuleStartMs,
    });
  } else {
    Object.assign(stats, { mtimeMs: Number(granuleStartMs), ctimeMs: Number(granuleStartMs) });
  }
  Object.assign(stats, { mtime: stamp, ctime: stamp });
  return stats;
}

function coarsenTimestampsOf(path: string): void {
  let granuleStartNs: bigint | undefined;
  const issuedFor = (args: readonly unknown[]): bigint | undefined => {
    if (String(args[0]) !== path) return undefined;
    granuleStartNs ??= wallClockNs();
    return granuleStartNs;
  };
  const callbackForm = (original: AnyFunction) =>
    function (this: unknown, ...args: unknown[]): unknown {
      const startNs = issuedFor(args);
      const callback = args.at(-1);
      if (startNs === undefined || typeof callback !== 'function') {
        return Reflect.apply(original, this, args);
      }
      return Reflect.apply(original, this, [
        ...args.slice(0, -1),
        (error: unknown, stats: unknown) =>
          Reflect.apply(callback, undefined, [
            error,
            error ? stats : restampIntoGranule(stats, startNs),
          ]),
      ]);
    };
  const promiseForm = (original: AnyFunction) =>
    function (this: unknown, ...args: unknown[]): unknown {
      const startNs = issuedFor(args);
      if (startNs === undefined) return Reflect.apply(original, this, args);
      const sampled: Promise<unknown> = Reflect.apply(original, this, args);
      return sampled.then((stats) => restampIntoGranule(stats, startNs));
    };
  const syncForm = (original: AnyFunction) =>
    function (this: unknown, ...args: unknown[]): unknown {
      const startNs = issuedFor(args);
      if (startNs === undefined) return Reflect.apply(original, this, args);
      return restampIntoGranule(Reflect.apply(original, this, args), startNs);
    };
  Object.assign(fs, {
    stat: callbackForm(fs.stat),
    lstat: callbackForm(fs.lstat),
    statSync: syncForm(fs.statSync),
    lstatSync: syncForm(fs.lstatSync),
  });
  Object.assign(fs.promises, {
    stat: promiseForm(fs.promises.stat),
    lstat: promiseForm(fs.promises.lstat),
  });
  syncBuiltinESMExports();
}

function carriedError(data: unknown): { code: string; path: string } | undefined {
  const carried = isRecord(data) ? [data, ...Object.values(data)] : [data];
  for (const candidate of carried.flatMap((item) => [item, isRecord(item) ? item.cause : null])) {
    if (isRecord(candidate) && typeof candidate.code === 'string') {
      return {
        code: candidate.code,
        path: typeof candidate.path === 'string' ? candidate.path : '',
      };
    }
  }
  return undefined;
}

function recordLoggedErrors(): () => LoggedError[] {
  const logged: LoggedError[] = [];
  const record = (level: string, data: unknown, message: string): void => {
    const error = carriedError(data);
    if (error !== undefined) logged.push({ level, ...error, message });
  };
  class ErrorRecordingLogger extends PinoLogger {
    override error(data: unknown, message: string): void {
      record('error', data, message);
      super.error(data, message);
    }
    override warn(data: unknown, message: string): void {
      record('warn', data, message);
      super.warn(data, message);
    }
    override info(data: unknown, message: string): void {
      record('info', data, message);
      super.info(data, message);
    }
    override debug(data: unknown, message: string): void {
      record('debug', data, message);
      super.debug(data, message);
    }
  }
  loggerFactory.configure({ loggerFactory: (name) => new ErrorRecordingLogger(name) });
  return () => logged.map((entry) => ({ ...entry }));
}

function failsWith(code: string): OutcomeTest {
  return (outcome) => 'code' in outcome && outcome.code === code;
}

function presentOrAbsent(outcome: SampleOutcome): boolean {
  return !('code' in outcome) || outcome.code === 'ENOENT';
}

function putDirectoryBack(dir: string, mode: number, aside: string): void {
  const atDir = lstatSync(dir, { throwIfNoEntry: false });
  if (atDir?.isSymbolicLink() || (atDir?.isFile() && existsSync(aside))) unlinkSync(dir);
  if (existsSync(aside)) renameSync(aside, dir);
  if (existsSync(dir)) chmodSync(dir, mode);
}

let stopWatcher: StopWatcher | undefined;
let releaseBarrier: () => void = () => {};

async function shutDown(): Promise<void> {
  releaseBarrier();
  await stopWatcher?.();
  process.exit(0);
}

async function runReadiness(spec: ReadinessSpec): Promise<void> {
  let firstBaselineStatHeldAtMutation: boolean | undefined;
  const barrier = holdFirstBaselineStat(
    observeWatcherSamples(),
    spec.held,
    spec.barrier,
    (heldBy) => {
      if (spec.timing === 'after-first-baseline-stat') setImmediate(barrier.release);
      else if (heldBy === 'sample') setImmediate(whileStartWaits);
    },
  );
  const mutate = (): boolean => {
    const heldAtMutation = barrier.held();
    if (spec.scenario === 'create') mkdirSync(dirname(spec.target), { recursive: true });
    writeFileSync(spec.target, spec.content, 'utf-8');
    barrier.release();
    return heldAtMutation;
  };
  const whileStartWaits = (): void => {
    if (!barrier.starting()) return;
    if (spec.timing === 'while-first-baseline-stat-held') {
      firstBaselineStatHeldAtMutation = mutate();
    } else {
      barrier.letSampleRun();
    }
  };
  releaseBarrier = barrier.release;
  const startupTimers = trackStartupTimers();
  const start = await loadWatcher(spec.entry);
  stopWatcher = await startupTimers.whileStarting(() => start(spec.watch, report));
  barrier.startResolved();
  const firstBaselineStatHeldAtResolve = barrier.held();
  report({
    kind: 'started',
    barrierEngaged: barrier.engaged(),
    firstBaselineStatHeldAtResolve,
    startupTimers: startupTimers.armedWhileStarting(),
  });

  if (spec.timing === 'after-first-baseline-stat') {
    if (barrier.engaged()) await barrier.released;
    await stat(spec.held).catch(() => undefined);
  }
  if (firstBaselineStatHeldAtMutation === undefined) {
    await startupTimers.allStopped();
    firstBaselineStatHeldAtMutation = mutate();
  }
  report({
    kind: 'mutated',
    barrierEngaged: barrier.engaged(),
    firstBaselineStatHeldAtResolve,
    firstBaselineStatHeldAtMutation,
    startupTimersWaitedOut: startupTimers.armedWhileStarting(),
  });
}

async function runContract(spec: ContractSpec): Promise<void> {
  const samples = observeWatcherSamples();
  if (spec.coarseTimestampsAt !== undefined) coarsenTimestampsOf(spec.coarseTimestampsAt);
  const startupTimers = trackStartupTimers();
  const pendingTimers = trackPendingTimers();
  const loggedErrors = recordLoggedErrors();
  const eventsAfterClose: WatcherEvent[] = [];
  let closed = false;
  const deliver = (event: WatcherEvent): void => {
    if (closed) eventsAfterClose.push(event);
    else report(event);
  };

  const writeInTwoSteps = (path: string, partial: string, complete: string): void => {
    let stage: 'pending' | 'written' | 'sampled' = 'pending';
    samples.watch(path, {
      before() {
        if (stage !== 'sampled') return;
        samples.unwatch(path);
        writeFileSync(path, complete, 'utf-8');
        report({ kind: 'completed' });
      },
      after(outcome) {
        if (stage !== 'written' || !('size' in outcome)) return;
        if (outcome.size !== Buffer.byteLength(partial)) return;
        stage = 'sampled';
        report({ kind: 'partial-sampled' });
      },
    });
    const writePartial = (atStartupTimerTick: boolean): void => {
      writeFileSync(path, partial, 'utf-8');
      stage = 'written';
      report({ kind: 'partial-written', atStartupTimerTick });
    };
    if (!startupTimers.beforeNextTick(() => writePartial(true))) writePartial(false);
  };

  const unreadableUntilSampled = (dir: string, leaf: string): void => {
    const mode = statSync(dir).mode & 0o7777;
    samples.watch(leaf, {
      after(outcome) {
        if (!('code' in outcome) || outcome.code !== 'EACCES') return;
        samples.unwatch(leaf);
        chmodSync(dir, mode);
        report({ kind: 'readable-again' });
      },
    });
    chmodSync(dir, 0o000);
    report({ kind: 'unreadable' });
  };

  const closeWatcher = async (): Promise<void> => {
    await stopWatcher?.();
    closed = true;
    await stopWatcher?.();
    report({ kind: 'closed' });
    process.once('beforeExit', () => {
      report({ kind: 'quiesced', eventsAfterClose });
    });
    process.channel?.unref();
  };

  const closeWhileSampling = (path: string, content: string): void => {
    let sampledOnce = false;
    samples.watch(path, {
      before() {
        if (!sampledOnce) return;
        samples.unwatch(path);
        report({ kind: 'closing' });
        void closeWatcher();
      },
      after(outcome) {
        if ('size' in outcome && outcome.size === Buffer.byteLength(content)) sampledOnce = true;
      },
    });
    writeFileSync(path, content, 'utf-8');
  };

  const holdNextSample = (path: string, content: string, barrier: string): void => {
    assertFifo(barrier);
    const listedRoots = spec.entry === 'managed' ? spec.watch : [];
    let stage: 'armed' | 'held' | 'checked' = 'armed';
    let samplesBegunWhileHeld = 0;
    const began = (): void => {
      if (stage === 'held') samplesBegunWhileHeld += 1;
    };
    const checked = (timersWaitedOut: number): void => {
      stage = 'checked';
      samples.unwatch(path);
      for (const root of listedRoots) samples.unwatch(root);
      report({ kind: 'overlap-checked', samplesBegunWhileHeld, timersWaitedOut });
      releaseBarrier();
    };
    for (const root of listedRoots) samples.watch(root, { before: began });
    samples.watch(path, {
      before(form) {
        if (stage !== 'armed') {
          began();
          return;
        }
        report({ kind: 'sample-held' });
        if (form === 'sync') {
          checked(0);
          return;
        }
        stage = 'held';
        releaseBarrier = blockTheOnlyWorker(barrier);
        setImmediate(() => {
          void pendingTimers.eachPendingTimerSettled().then(checked);
        });
      },
    });
    writeFileSync(path, content, 'utf-8');
  };

  const unreadableAcrossPolls = (dir: string, path: string): void => {
    const mode = statSync(dir).mode & 0o7777;
    let phase: ErrorPhase = 'landing';
    let failedIn: ErrorPhase | undefined;
    let onceEstablished: LoggedError[] = [];
    samples.watch(path, {
      before() {
        if (failedIn !== phase) return;
        if (phase === 'landing') {
          phase = 'establishing';
          return;
        }
        if (phase === 'establishing') {
          onceEstablished = loggedErrors();
          phase = 'persisting';
          return;
        }
        samples.unwatch(path);
        const afterAnotherPoll = loggedErrors();
        chmodSync(dir, mode);
        report({ kind: 'error-reports', onceEstablished, afterAnotherPoll });
      },
      after(outcome) {
        if ('code' in outcome && outcome.code === 'EACCES') failedIn = phase;
      },
    });
    chmodSync(dir, 0o000);
    report({ kind: 'unreadable' });
  };

  const stepThroughStages = (
    stages: readonly ErrorStage[],
    whenAllEstablished: (snapshots: LoggedError[][]) => void,
  ): (() => void) => {
    const watched = new Set(stages.flatMap((stage) => [stage.enteredAt, stage.observedAt]));
    const snapshots: LoggedError[][] = [];
    let index = 0;
    let phase: StagePhase = 'landing';
    let held = false;
    const stop = (): void => {
      for (const path of watched) samples.unwatch(path);
    };
    const before = (path: string): void => {
      const stage = stages[index];
      if (stage === undefined) return;
      if (phase === 'entering') {
        if (path !== stage.enteredAt) return;
        stage.enter?.();
        phase = 'landing';
        held = false;
        return;
      }
      if (path !== stage.observedAt || !held) return;
      held = false;
      if (phase === 'landing') {
        phase = 'establishing';
        return;
      }
      snapshots.push(loggedErrors());
      index += 1;
      if (index === stages.length) {
        stop();
        whenAllEstablished(snapshots);
        return;
      }
      phase = 'entering';
      before(path);
    };
    for (const path of watched) {
      samples.watch(path, {
        before: () => before(path),
        after(outcome) {
          const stage = stages[index];
          if (stage === undefined || phase === 'entering' || path !== stage.observedAt) return;
          if (stage.holds(outcome)) held = true;
        },
      });
    }
    stages[0]?.enter?.();
    return stop;
  };

  const unreadableAgainAfterRecovery = ({
    dir,
    failingAt,
    sampledEveryPoll,
    recovery,
    aside,
  }: CommandOf<'unreadable-again-after-recovery'>): void => {
    const mode = statSync(dir).mode & 0o7777;
    const stop = stepThroughStages(
      [
        {
          enteredAt: failingAt,
          observedAt: failingAt,
          enter: () => chmodSync(dir, 0o000),
          holds: failsWith('EACCES'),
        },
        {
          enteredAt: sampledEveryPoll,
          observedAt: sampledEveryPoll,
          enter() {
            chmodSync(dir, mode);
            if (recovery !== 'readable') {
              renameSync(dir, aside);
              if (recovery === 'replaced-by-file')
                writeFileSync(dir, 'a regular file where the directory was', 'utf-8');
              report({ kind: 'removed' });
            }
          },
          holds: (outcome) => presentOrAbsent(outcome) || failsWith('ENOTDIR')(outcome),
        },
        {
          enteredAt: sampledEveryPoll,
          observedAt: failingAt,
          enter() {
            if (recovery === 'replaced-by-file') unlinkSync(dir);
            if (recovery !== 'readable') renameSync(aside, dir);
            chmodSync(dir, 0o000);
          },
          holds: failsWith('EACCES'),
        },
      ],
      ([firstEpisode = [], onceRecovered = [], secondEpisode = []]) => {
        putDirectoryBack(dir, mode, aside);
        report({
          kind: 'error-reports-across-recovery',
          firstEpisode,
          afterRecovery: secondEpisode.slice(onceRecovered.length),
        });
      },
    );
    process.on('exit', () => {
      stop();
      putDirectoryBack(dir, mode, aside);
    });
  };

  const errorCodeChangesWhileFailing = ({
    dir,
    failingAt,
    aside,
  }: CommandOf<'error-code-changes-while-failing'>): void => {
    const mode = statSync(dir).mode & 0o7777;
    const stop = stepThroughStages(
      [
        {
          enteredAt: failingAt,
          observedAt: failingAt,
          enter: () => chmodSync(dir, 0o000),
          holds: failsWith('EACCES'),
        },
        {
          enteredAt: failingAt,
          observedAt: failingAt,
          enter() {
            chmodSync(dir, mode);
            renameSync(dir, aside);
            symlinkSync(dir, dir);
          },
          holds: failsWith('ELOOP'),
        },
        { enteredAt: failingAt, observedAt: failingAt, holds: failsWith('ELOOP') },
      ],
      ([beforeChange = [], onceChanged = [], afterFurtherPolls = []]) => {
        putDirectoryBack(dir, mode, aside);
        report({
          kind: 'error-reports-across-code-change',
          beforeChange,
          afterChange: onceChanged.slice(beforeChange.length),
          whileItPersists: afterFurtherPolls.slice(onceChanged.length),
        });
      },
    );
    process.on('exit', () => {
      stop();
      putDirectoryBack(dir, mode, aside);
    });
  };

  const closeBetweenPolls = (path: string): void => {
    let closing = false;
    let samplesAfterClose = 0;
    samples.watch(path, {
      before() {
        if (closing) samplesAfterClose += 1;
      },
      after(outcome) {
        if (closing || !('size' in outcome)) return;
        closing = true;
        setImmediate(() => {
          void (async () => {
            await stopWatcher?.();
            closed = true;
            report({ kind: 'closed' });
            process.once('beforeExit', () => {
              report({ kind: 'idle-after-close', samplesAfterClose });
            });
            process.channel?.unref();
          })();
        });
      },
    });
  };

  const closeWhileSampleHeld = ({
    path,
    dir,
    barrier,
  }: CommandOf<'close-while-sample-held'>): void => {
    assertFifo(barrier);
    const mode = statSync(dir).mode & 0o7777;
    samples.watch(path, {
      before(form) {
        if (form === 'sync') return;
        samples.unwatch(path);
        releaseBarrier = blockTheOnlyWorker(barrier);
        let closeResolved = false;
        let loggedBeforeClose = 0;
        void stopWatcher?.().then(() => {
          closeResolved = true;
          closed = true;
          loggedBeforeClose = loggedErrors().length;
        });
        setImmediate(() => {
          const resolvedWhileHeld = closeResolved;
          chmodSync(dir, 0o000);
          releaseBarrier();
          process.once('beforeExit', () => {
            chmodSync(dir, mode);
            report({
              kind: 'idle-after-held-close',
              resolvedWhileHeld,
              eventsAfterClose,
              loggedAfterClose: loggedErrors().slice(loggedBeforeClose),
            });
          });
          process.channel?.unref();
        });
      },
    });
  };

  const twoStepWriteAcrossInterruption = ({
    path,
    dir,
    partial,
    complete,
    interruption,
  }: CommandOf<'two-step-write-across-interruption'>): void => {
    const mode = statSync(dir).mode & 0o7777;
    const partialSize = Buffer.byteLength(partial);
    let stage:
      | 'written'
      | 'partial-sampled'
      | 'interrupting'
      | 'interrupted'
      | 'restoring'
      | 'partial-resampled'
      | 'done' = 'written';
    const restore = (): void => {
      if (interruption === 'unreadable') chmodSync(dir, mode);
      else if (!existsSync(path)) writeFileSync(path, partial, 'utf-8');
    };
    samples.watch(path, {
      before() {
        if (stage === 'partial-sampled') {
          if (interruption === 'unreadable') chmodSync(dir, 0o000);
          else unlinkSync(path);
          stage = 'interrupting';
        } else if (stage === 'interrupted') {
          restore();
          stage = 'restoring';
          report({ kind: 'restored' });
        } else if (stage === 'partial-resampled') {
          samples.unwatch(path);
          stage = 'done';
          writeFileSync(path, complete, 'utf-8');
          report({ kind: 'completed' });
        }
      },
      after(outcome) {
        if (stage === 'written' && 'size' in outcome && outcome.size === partialSize) {
          stage = 'partial-sampled';
          report({ kind: 'partial-sampled' });
        } else if (
          stage === 'interrupting' &&
          'code' in outcome &&
          outcome.code === (interruption === 'unreadable' ? 'EACCES' : 'ENOENT')
        ) {
          stage = 'interrupted';
          report({ kind: 'interrupted' });
        } else if (stage === 'restoring' && 'size' in outcome && outcome.size === partialSize) {
          stage = 'partial-resampled';
        }
      },
    });
    process.on('exit', restore);
    writeFileSync(path, partial, 'utf-8');
  };

  const rewriteInPlace = (path: string, content: string): void => {
    const before = statSync(path, { bigint: true });
    writeFileSync(path, content, 'utf-8');
    const after = statSync(path, { bigint: true });
    report({
      kind: 'rewritten-in-place',
      statUnchanged:
        before.dev === after.dev &&
        before.ino === after.ino &&
        before.size === after.size &&
        before.mtimeNs === after.mtimeNs &&
        before.ctimeNs === after.ctimeNs,
    });
  };

  const [firstWatched] = spec.watch;
  if (firstWatched === undefined) throw new Error('watcher process: nothing to watch');
  const start = await loadWatcher(spec.entry);
  stopWatcher = await startupTimers.whileStarting(() => start(spec.watch, deliver));
  await stat(spec.entry === 'managed' ? firstWatched : dirname(firstWatched));
  process.on('message', (message) => {
    const command = parseCommand(message);
    if (command.op === 'write-in-two-steps') {
      writeInTwoSteps(command.path, command.partial, command.complete);
    } else if (command.op === 'unreadable-until-sampled') {
      unreadableUntilSampled(command.dir, command.leaf);
    } else if (command.op === 'hold-next-sample') {
      holdNextSample(command.path, command.content, command.barrier);
    } else if (command.op === 'unreadable-across-polls') {
      unreadableAcrossPolls(command.dir, command.path);
    } else if (command.op === 'unreadable-again-after-recovery') {
      unreadableAgainAfterRecovery(command);
    } else if (command.op === 'error-code-changes-while-failing') {
      errorCodeChangesWhileFailing(command);
    } else if (command.op === 'close-between-polls') {
      closeBetweenPolls(command.path);
    } else if (command.op === 'close-while-sample-held') {
      closeWhileSampleHeld(command);
    } else if (command.op === 'two-step-write-across-interruption') {
      twoStepWriteAcrossInterruption(command);
    } else if (command.op === 'rewrite-in-place') {
      rewriteInPlace(command.path, command.content);
    } else {
      closeWhileSampling(command.path, command.content);
    }
  });
  report({ kind: 'settled', startupTimers: startupTimers.running() });
}

const spec = parseSpec(process.argv[2]);
if (process.env.UV_THREADPOOL_SIZE !== '1') {
  throw new Error(
    `watcher process: needs UV_THREADPOOL_SIZE=1 so ordering on the only libuv worker is first in, first out, got ${String(process.env.UV_THREADPOOL_SIZE)}`,
  );
}
process.once('disconnect', () => {
  void shutDown();
});
if (!process.connected) await shutDown();

if (spec.mode === 'readiness') await runReadiness(spec);
else await runContract(spec);
