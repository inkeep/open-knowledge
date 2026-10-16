const cp = require('node:child_process');
const { randomUUID } = require('node:crypto');
const {
  appendFileSync,
  existsSync,
  readFileSync,
  renameSync,
  watch,
  writeFileSync,
} = require('node:fs');
const { syncBuiltinESMExports } = require('node:module');
const { join } = require('node:path');
const { PassThrough, Writable } = require('node:stream');
const threads = require('node:worker_threads');

const transport = process.env.OK_SHADOW_OWNER_TRANSPORT;
const runId = process.env.OK_SHADOW_OWNER_RUN_ID;
const clock = new Int32Array(new SharedArrayBuffer(4));
const NativeChildProcess = cp.ChildProcess;
const environmentKey = 'ok-shadow-fixture-environment';
const readinessGate = process.env.OK_SHADOW_READINESS_GATE === '1';
const baseline = threads.isMainThread
  ? { ...process.env }
  : threads.getEnvironmentData(environmentKey);
const readinessSignal =
  readinessGate && threads.isMainThread ? new Int32Array(new SharedArrayBuffer(4)) : undefined;
if (readinessGate && !threads.isMainThread) {
  const shared = threads.workerData?.__okShadowReadinessSignal;
  if (shared) Atomics.wait(new Int32Array(shared), 0, 0);
}

function environmentFor(env) {
  return {
    basePid: process.pid,
    set: Object.fromEntries(
      Object.entries(env).filter(([name, value]) => baseline[name] !== value),
    ),
    unset: Object.keys(baseline).filter((name) => !(name in env)),
  };
}

function submit(name, value) {
  const path = join(transport, name);
  writeFileSync(`${path}.pending`, JSON.stringify({ runId, ...value }));
  renameSync(`${path}.pending`, path);
}

function optionsFor(options) {
  if (options.shell || options.detached)
    throw new Error('fixture transport does not support this launch shape');
  return {
    cwd: options.cwd ?? process.cwd(),
    env: environmentFor(options.env ?? process.env),
    windowsHide: options.windowsHide,
    timeout: options.timeout ?? 0,
    maxBuffer: options.maxBuffer ?? 1_048_576,
    killSignal: options.killSignal ?? 'SIGTERM',
  };
}

function sync(executable, args = [], options = {}) {
  const id = randomUUID();
  const selected = optionsFor(options);
  submit(`${id}.request`, {
    id,
    kind: 'sync',
    executable,
    args,
    options: selected,
    input: options.input === undefined ? undefined : Buffer.from(options.input).toString('base64'),
  });
  const resultPath = join(transport, `${id}.result`);
  const end = Date.now() + Math.max(selected.timeout + 10_000, 540_000);
  while (!existsSync(resultPath)) {
    if (!existsSync(transport) || Date.now() > end)
      throw new Error('fixture transport ended before synchronous native result');
    Atomics.wait(clock, 0, 0, 10);
  }
  const result = JSON.parse(readFileSync(resultPath, 'utf8'));
  const decode = (data) => {
    const buffer = Buffer.from(data, 'base64');
    return options.encoding ? buffer.toString(options.encoding) : buffer;
  };
  result.stdout = decode(result.stdout);
  result.stderr = decode(result.stderr);
  result.output = [null, result.stdout, result.stderr];
  result.error &&= Object.assign(new Error(result.error.message), result.error);
  return result;
}

class FixtureChild extends NativeChildProcess {
  constructor(executable, args, options) {
    super();
    const id = randomUUID();
    let counter = 0;
    let consumed = 0;
    let complete = false;
    const eventPath = join(transport, `${id}.events`);
    const action = (value) =>
      submit(`${id}-${String(counter++).padStart(8, '0')}.action`, { id, ...value });
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.stdin = new Writable({
      write(data, _encoding, done) {
        action({ type: 'stdin', data: Buffer.from(data).toString('base64') });
        done();
      },
      final(done) {
        action({ type: 'end' });
        done();
      },
    });
    this.stdio = [this.stdin, this.stdout, this.stderr];
    this.spawnfile = executable;
    this.spawnargs = [executable, ...args];
    this.kill = (value = 'SIGTERM') => {
      if (complete || this.exitCode !== null || this.signalCode !== null) return false;
      this.killed = true;
      action({ type: 'kill', signal: value });
      return true;
    };
    const read = () => {
      if (complete || !existsSync(eventPath)) return;
      const rows = readFileSync(eventPath, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      for (const row of rows.slice(consumed)) {
        consumed++;
        if (row.type === 'spawn') {
          this.pid = row.pid;
          this.emit('spawn');
        } else if (row.type === 'stdout' || row.type === 'stderr') {
          this[row.type].write(Buffer.from(row.data, 'base64'));
        } else if (row.type === 'error') {
          this.emit('error', Object.assign(new Error(row.message), { code: row.code }));
        } else if (row.type === 'exit') {
          this.exitCode = row.code;
          this.signalCode = row.signal;
          this.emit('exit', row.code, row.signal);
        } else if (row.type === 'close') {
          appendFileSync(
            join(transport, 'runtimes.jsonl'),
            `${JSON.stringify({ at: Date.now(), pid: process.pid, threadId: threads.threadId, facadeClosed: id, code: row.code, signal: row.signal })}\n`,
          );
          complete = true;
          clearInterval(timer);
          subscription.close();
          this.stdin.destroy();
          this.stdout.end();
          this.stderr.end();
          this.emit('close', row.code, row.signal);
        }
      }
    };
    const subscription = watch(transport, read);
    const timer = setInterval(read, 20);
    submit(`${id}.request`, { id, kind: 'async', executable, args, options: optionsFor(options) });
  }
}

if (transport) {
  appendFileSync(
    join(transport, 'runtimes.jsonl'),
    `${JSON.stringify({ at: Date.now(), pid: process.pid, threadId: threads.threadId, execArgv: process.execArgv, node: process.version })}\n`,
  );
  cp.spawnSync = sync;
  cp.execFileSync = (executable, args, options = {}) => {
    const result = sync(executable, args, options);
    if (result.error || result.status !== 0) {
      const error =
        result.error ??
        new Error(`Command failed: ${executable} ${args.join(' ')}\n${result.stderr}`);
      throw Object.assign(error, result);
    }
    return result.stdout;
  };
  cp.spawn = (executable, args = [], options = {}) => new FixtureChild(executable, args, options);
  if (threads.isMainThread) {
    threads.setEnvironmentData(environmentKey, baseline);
    if (process.connected) process.send({ type: 'runtime-environment', env: baseline });
    const environmentReady = join(transport, `environment-${process.pid}.ready`);
    const acknowledgementDeadline = Date.now() + 10_000;
    while (!existsSync(environmentReady)) {
      if (!existsSync(transport) || Date.now() > acknowledgementDeadline)
        throw new Error('fixture environment acknowledgement did not arrive');
      Atomics.wait(clock, 0, 0, 10);
    }
    const NativeWorker = threads.Worker;
    const workers = new Set();
    threads.Worker = class extends NativeWorker {
      constructor(filename, options) {
        const execArgv = options?.execArgv ?? process.execArgv;
        const workerData = readinessSignal
          ? { ...options?.workerData, __okShadowReadinessSignal: readinessSignal.buffer }
          : options?.workerData;
        super(filename, {
          ...options,
          ...(readinessSignal ? { workerData } : {}),
          execArgv: execArgv.includes(__filename)
            ? execArgv
            : ['--require', __filename, ...execArgv],
        });
        workers.add(this);
        const id = this.threadId;
        if (process.connected) process.send({ type: 'worker-start', threadId: id });
        this.once('exit', (code) => {
          workers.delete(this);
          appendFileSync(
            join(transport, 'runtimes.jsonl'),
            `${JSON.stringify({ at: Date.now(), workerExit: id, code })}\n`,
          );
          if (code !== 0 && process.connected) process.send({ type: 'worker-loss', code });
        });
      }
    };
    process.on('message', (message) => {
      if (message.type === 'release-readiness' && readinessSignal) {
        Atomics.store(readinessSignal, 0, 1);
        Atomics.notify(readinessSignal, 0);
        return;
      }
      if (message.type !== 'lose-worker') return;
      for (const worker of workers) {
        appendFileSync(
          join(transport, 'runtimes.jsonl'),
          `${JSON.stringify({ at: Date.now(), terminateRequested: worker.threadId })}\n`,
        );
        void worker.terminate();
      }
    });
    process.channel?.unref();
  }
  syncBuiltinESMExports();
}
