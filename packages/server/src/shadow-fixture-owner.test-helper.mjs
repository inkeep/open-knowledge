import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  watch,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const preload = fileURLToPath(new URL('./shadow-fixture-preload.test-helper.cjs', import.meta.url));
const children = new Map();
const consumed = new Set();
const events = [];
const environments = new Map();
let config;
let workDir;
let transport;
let subscription;
let scanTimer;
let deadline;
let cleanupPromise;
let runner;
let runnerExit;
let workerLossRequested = false;
let stopping = false;

function bindCompilerOwner(owner, child, terminate) {
  let spawned = false;
  let disconnected = !owner.connected;
  const disconnect = () => {
    disconnected = true;
    if (spawned) terminate();
  };
  owner.once('disconnect', disconnect);
  child.once('spawn', () => {
    spawned = true;
    if (disconnected) terminate();
  });
  child.once('exit', () => {
    spawned = false;
    owner.off('disconnect', disconnect);
  });
  child.once('close', () => owner.off('disconnect', disconnect));
}

function write(path, value) {
  writeFileSync(`${path}.pending`, `${JSON.stringify(value)}\n`);
  renameSync(`${path}.pending`, path);
}

function notify(message) {
  if (process.connected) process.send(message, () => {});
}

function record(event) {
  const row = { at: Date.now(), ownerPid: process.pid, ...event };
  events.push(row);
  if (config) appendFileSync(join(config.resultDir, 'ownership.jsonl'), `${JSON.stringify(row)}\n`);
  notify({ type: 'event', row });
}

function signal(entry, value) {
  if (entry.child.exitCode !== null || entry.child.signalCode !== null) return;
  record({ type: 'signal', id: entry.id, pid: entry.child.pid, signal: value });
  entry.child.kill(value);
}

function environmentFor(value) {
  const base = environments.get(value.basePid);
  if (!base) throw new Error('fixture environment was not registered');
  const env = { ...base, ...value.set };
  for (const name of value.unset) delete env[name];
  return env;
}

function pendingFences() {
  return readdirSync(workDir, { withFileTypes: true }).flatMap((entry) => {
    if (!entry.isDirectory() || !entry.name.startsWith('ok-shadow-settle-fence-')) return [];
    const dir = join(workDir, entry.name, '.ok');
    return existsSync(dir)
      ? readdirSync(dir)
          .filter((name) => name.startsWith('watcher-settle-fence-'))
          .map((name) => join(dir, name))
      : [];
  });
}

function acquire(id, executable, args, options, onEvent) {
  if (stopping) throw new Error('fixture owner is closing');
  const child = spawn(executable, args, options);
  const closed = Promise.withResolvers();
  const entry = { id, child, closed: closed.promise, close: undefined };
  children.set(id, entry);
  child.on('message', (message) => {
    if (message.type === 'runtime-environment') {
      environments.set(child.pid, message.env);
      record({ type: 'runtime-environment-registered', id, pid: child.pid });
      write(join(transport, `environment-${child.pid}.ready`), { ready: true });
    }
  });
  child.once('spawn', () => {
    record({ type: 'spawn', id, pid: child.pid, executable, args, cwd: options.cwd });
    onEvent({ type: 'spawn', pid: child.pid });
  });
  child.on('error', (error) =>
    onEvent({ type: 'error', code: error.code, message: error.message }),
  );
  child.once('exit', (code, value) => {
    record({ type: 'exit', id, pid: child.pid, code, signal: value });
    onEvent({ type: 'exit', code, signal: value });
  });
  child.once('close', (code, value) => {
    entry.close = { code, signal: value };
    record({ type: 'close', id, pid: child.pid, code, signal: value });
    onEvent({ type: 'close', code, signal: value });
    closed.resolve();
  });
  if (config.autoCleanup) bindCompilerOwner(process, child, () => signal(entry, 'SIGTERM'));
  return entry;
}

function request(job) {
  if (basename(job.executable) === 'node' && !job.args.includes(preload)) {
    record({ type: 'scope-gap', id: job.id, executable: job.executable, args: job.args });
    throw new Error('fixture transport has no envelope for this node acquisition');
  }
  let sequence = 0;
  const outputPath = join(transport, `${job.id}.events`);
  const stdout = [];
  const stderr = [];
  let bytes = 0;
  let error;
  let timeout;
  const held = job.kind === 'async' && config.holdCapture && pendingFences().length > 0;
  if (held) record({ type: 'capture-held', id: job.id });
  const emit = (event) => {
    if (!existsSync(transport)) return;
    if (!held)
      appendFileSync(outputPath, `${JSON.stringify({ sequence: sequence++, ...event })}\n`);
    if (event.type === 'error') error = { code: event.code, message: event.message };
    if (event.type !== 'close') return;
    clearTimeout(timeout);
    if (job.kind === 'sync') {
      write(join(transport, `${job.id}.result`), {
        pid: entry.child.pid,
        status: event.code,
        signal: event.signal,
        stdout: Buffer.concat(stdout).toString('base64'),
        stderr: Buffer.concat(stderr).toString('base64'),
        error,
      });
    }
  };
  const entry = acquire(
    job.id,
    job.executable,
    job.args,
    {
      cwd: job.options.cwd,
      env: environmentFor(job.options.env),
      windowsHide: job.options.windowsHide,
      stdio: ['pipe', 'pipe', 'pipe'],
    },
    emit,
  );
  for (const [name, stream, chunks] of [
    ['stdout', entry.child.stdout, stdout],
    ['stderr', entry.child.stderr, stderr],
  ]) {
    stream.on('data', (data) => {
      bytes += data.length;
      if (job.kind === 'sync') chunks.push(data);
      emit({ type: name, data: data.toString('base64') });
      if (job.kind === 'sync' && bytes > job.options.maxBuffer) {
        error = { code: 'ENOBUFS', message: `spawnSync ${job.executable} ENOBUFS` };
        signal(entry, job.options.killSignal ?? 'SIGTERM');
      }
    });
  }
  entry.child.stdin.on('error', (failure) => {
    record({ type: 'stdin-error', id: job.id, code: failure.code });
  });
  if (job.kind === 'sync' && !config.holdSyncInput) {
    entry.child.stdin.end(Buffer.from(job.input ?? '', 'base64'));
  }
  if (job.options.timeout > 0) {
    timeout = setTimeout(() => {
      error = { code: 'ETIMEDOUT', message: `spawnSync ${job.executable} ETIMEDOUT` };
      signal(entry, job.options.killSignal ?? 'SIGTERM');
    }, job.options.timeout);
  }
}

function scan() {
  if (stopping) return;
  for (const name of readdirSync(transport).sort()) {
    if (!name.endsWith('.request') && !name.endsWith('.action')) continue;
    if (consumed.has(name)) continue;
    const job = JSON.parse(readFileSync(join(transport, name), 'utf8'));
    if (job.runId !== config.runId) throw new Error('fixture request has another run identity');
    if (name.endsWith('.request')) {
      consumed.add(name);
      record({ type: 'request', id: job.id, kind: job.kind, executable: job.executable });
      request(job);
    } else {
      const entry = children.get(job.id);
      if (!entry) continue;
      consumed.add(name);
      if (entry.close) continue;
      if (job.type === 'stdin') entry.child.stdin.write(Buffer.from(job.data, 'base64'));
      else if (job.type === 'end') entry.child.stdin.end();
      else if (job.type === 'kill') signal(entry, job.signal);
      else throw new Error('unknown fixture transport action');
    }
  }
}

async function cleanup(reason) {
  if (cleanupPromise) return cleanupPromise;
  cleanupPromise = (async () => {
    stopping = true;
    clearTimeout(deadline);
    clearInterval(scanTimer);
    subscription?.close();
    const before = [...children.values()].filter((entry) => !entry.close).map((entry) => entry.id);
    for (const entry of children.values()) signal(entry, 'SIGTERM');
    const escalation = setTimeout(() => {
      for (const entry of children.values()) signal(entry, 'SIGKILL');
    }, 1_000);
    await Promise.all([...children.values()].map((entry) => entry.closed));
    clearTimeout(escalation);
    const normalResidue =
      reason === 'runner closed'
        ? readdirSync(workDir).filter((name) => name !== 'transport')
        : null;
    const runtimePath = join(transport, 'runtimes.jsonl');
    const runtimes = existsSync(runtimePath)
      ? readFileSync(runtimePath, 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line))
      : [];
    const workerLossObserved =
      runtimes.some((row) => row.workerExit !== undefined && row.code !== 0) &&
      runtimes.some((row) => row.terminateRequested !== undefined);
    rmSync(workDir, { recursive: true, force: true });
    const receipt = {
      reason:
        reason === 'runner closed' && (workerLossRequested || workerLossObserved)
          ? 'test worker lost'
          : reason,
      trigger: reason,
      before,
      runnerExit,
      normalResidue,
      children: [...children.values()].map((entry) => ({
        id: entry.id,
        pid: entry.child.pid,
        close: entry.close,
      })),
      workDir,
      workDirAbsent: !existsSync(workDir),
      events,
      runtimes,
      finishedAt: Date.now(),
    };
    write(join(config.resultDir, 'cleanup.json'), receipt);
    notify({ type: 'cleaned', receipt });
    if (process.connected) process.disconnect();
    process.exitCode = 0;
  })();
  return cleanupPromise;
}

function start(value) {
  if (config) throw new Error('fixture owner already started');
  config = { runId: randomUUID(), autoCleanup: true, maxLifetimeMs: 540_000, ...value };
  workerLossRequested = false;
  mkdirSync(config.resultDir, { recursive: true });
  workDir = realpathSync(mkdtempSync(join(config.scratchRoot ?? tmpdir(), 'ok-shadow-owned-')));
  transport = join(workDir, 'transport');
  mkdirSync(transport);
  write(join(config.resultDir, 'started.json'), {
    ownerPid: process.pid,
    workDir,
    runId: config.runId,
  });
  subscription = watch(transport, () => scan());
  scanTimer = setInterval(scan, 20);
  deadline = setTimeout(() => void cleanup('maximum lifetime reached'), config.maxLifetimeMs);
  const log = config.logFile ?? join(config.resultDir, 'runner.log');
  const entry = acquire(
    'runner',
    process.execPath,
    ['--require', preload, ...config.args],
    {
      cwd: config.cwd,
      env: {
        ...process.env,
        ...config.env,
        TMPDIR: workDir,
        TMP: workDir,
        TEMP: workDir,
        OK_SHADOW_OWNER_TRANSPORT: transport,
        OK_SHADOW_OWNER_RUN_ID: config.runId,
        ...(config.readinessGate ? { OK_SHADOW_READINESS_GATE: '1' } : {}),
      },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    },
    (event) => {
      if (event.type === 'close') {
        runnerExit = { code: event.code, signal: event.signal };
        void cleanup('runner closed');
      }
    },
  );
  runner = entry;
  entry.child.stdout.on('data', (data) => appendFileSync(log, data));
  entry.child.stderr.on('data', (data) => appendFileSync(log, data));
  entry.child.on('message', (message) => {
    if (message.type === 'runtime-environment') return;
    record(message);
    if (message.type === 'worker-loss') {
      if (stopping) return;
      const activeGit = [...children.values()].some(
        (child) => child.id !== 'runner' && !child.close,
      );
      const scratch = readdirSync(workDir).some((name) => name !== 'transport');
      if (activeGit || scratch) void cleanup('test worker lost');
    }
  });
  notify({ type: 'started', workDir, runId: config.runId });
}

process.on('message', (message) => {
  if (message.type === 'start') start(message.config);
  else if (message.type === 'release') void cleanup('normal release');
  else if (message.type === 'lose-runner') signal(runner, 'SIGKILL');
  else if (message.type === 'release-readiness') runner.child.send({ type: 'release-readiness' });
  else if (message.type === 'lose-worker') {
    workerLossRequested = true;
    if (config.dropWorkerLossRequest) {
      record({ type: 'worker-loss-requested', target: 'runner', delivered: false });
    } else {
      runner.child.send({ type: 'lose-worker' });
    }
  } else if (message.type === 'hold-git')
    acquire(
      'held-native-git',
      'git',
      ['hash-object', '--stdin'],
      {
        cwd: workDir,
        env: Object.fromEntries(
          Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')),
        ),
        stdio: ['pipe', 'pipe', 'pipe'],
      },
      () => {},
    );
  else if (message.type === 'end-input') {
    for (const entry of children.values()) if (entry.id !== 'runner') entry.child.stdin.end();
  } else throw new Error('unknown fixture owner action');
});
process.once('disconnect', () => {
  if (config?.autoCleanup) void cleanup('caller disconnected');
});
process.once('uncaughtException', (error) => {
  if (!config) {
    process.exitCode = 1;
    if (process.connected) process.disconnect();
    return;
  }
  record({ type: 'owner-error', name: error.name });
  void cleanup('owner error').then(() => {
    process.exitCode = 1;
  });
});
