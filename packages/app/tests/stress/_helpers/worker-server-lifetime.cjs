const { readFileSync } = require('node:fs');
const { productionShellLockPath } = require('./production-shell-readiness.ts');
const { removeAllDuringTeardown, runTeardownPhases } = require('./teardown-fs.ts');
const { killGracefully } = require('./server-process.ts');
const { spawnWorkerServerCommand } = require('./worker-server-command.ts');

const launch = JSON.parse(process.argv[2]);
let proc;
let releasing;
let finishing;
let ownerLost = !process.connected;
let terminal;
const lifetimeStartedAt = Date.now();
const ownerPid = process.ppid;
let commandSpawnedAt;
let ownerLossRecorded = false;

function ownerAlive() {
  const pid = ownerPid;
  if (!Number.isSafeInteger(pid) || pid <= 1) return null;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function readinessState() {
  try {
    const lock = JSON.parse(readFileSync(productionShellLockPath(launch.contentDir), 'utf8'));
    if (lock.draining === true) return 'lock-draining';
    if (typeof lock.port === 'number' && lock.port > 0) return 'lock-bound';
    return 'lock-pending';
  } catch (error) {
    return error?.code === 'ENOENT' ? 'lock-missing' : 'lock-unreadable';
  }
}

function recordOwnerLoss(trigger) {
  if (ownerLossRecorded || finishing !== undefined) return;
  ownerLossRecorded = true;
  const elapsedMs = Date.now() - (commandSpawnedAt ?? lifetimeStartedAt);
  const serverPid = proc?.pid ?? null;
  const line = `[worker-server-lifetime] owner-loss trigger=${trigger} ownerPid=${ownerPid} ownerAlive=${String(ownerAlive())} serverPid=${String(serverPid)} elapsedMs=${elapsedMs} readiness=${readinessState()}\n`;
  try {
    process.stdout.write(line);
  } catch {}
}

function send(message) {
  if (process.connected) process.send(message, () => {});
}

function describe(error) {
  return error instanceof Error ? error.message : String(error);
}

function commandStatus() {
  return { code: proc.exitCode, signal: proc.signalCode };
}

function commandError(error) {
  return {
    name: error.name,
    message: error.message,
    stack: error.stack,
    errno: error.errno,
    code: error.code,
    syscall: error.syscall,
    path: error.path,
    spawnargs: error.spawnargs,
  };
}

async function stop() {
  releasing ??= (async () => {
    try {
      if (proc) await killGracefully(proc, launch.reapMs);
      send({ type: 'stopped', terminal, error: null });
    } catch (error) {
      send({ type: 'stopped', terminal, error: describe(error) });
      throw error;
    }
  })();
  return releasing;
}

function finish() {
  finishing ??= (async () => {
    try {
      await runTeardownPhases(
        () => stop(),
        () =>
          removeAllDuringTeardown(
            launch.contentDir,
            launch.viteCacheDir,
            launch.request.receiptDir,
            launch.serverLog.path,
          ),
      );
      send({ type: 'released', error: null });
      process.exitCode = 0;
    } catch (error) {
      process.stderr.write(`worker server lifetime release failed: ${describe(error)}\n`);
      send({ type: 'released', error: describe(error) });
      process.exitCode = 1;
    } finally {
      if (process.connected) process.disconnect();
    }
  })();
  return finishing;
}

process.once('disconnect', () => {
  ownerLost = true;
  recordOwnerLoss('ipc-disconnect');
  void finish();
});
process.on('message', (message) => {
  if (message?.type === 'stop') void stop().catch(() => finish());
  else if (message?.type === 'release') void finish();
  else {
    process.stderr.write('worker server lifetime received an invalid control message\n');
    void finish();
  }
});
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.once(signal, () => {
    ownerLost = true;
    recordOwnerLoss(`signal-${signal}`);
    void finish();
  });
}

if (ownerLost) {
  recordOwnerLoss('owner-not-connected-at-start');
  void finish();
} else {
  try {
    proc = spawnWorkerServerCommand(launch);
    commandSpawnedAt = Date.now();
    proc.once('error', (error) => {
      terminal = commandStatus();
      send({ type: 'command-error', status: terminal, error: commandError(error) });
      void stop().catch(() => finish());
    });
    proc.once('exit', (code, signal) => {
      terminal = { code, signal };
      send({ type: 'command-exit', code, signal });
      void stop().catch(() => finish());
    });
    proc.once('close', (code, signal) => {
      terminal = { code, signal };
      send({ type: 'command-close', code, signal });
    });
    send({ type: 'started', pid: proc.pid ?? null });
  } catch (error) {
    send({ type: 'launch-error', message: describe(error) });
    void stop().catch(() => finish());
  }
}
