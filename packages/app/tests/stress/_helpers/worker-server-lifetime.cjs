const { removeAllDuringTeardown, runTeardownPhases } = require('./teardown-fs.ts');
const { killGracefully } = require('./server-process.ts');
const { spawnWorkerServerCommand } = require('./worker-server-command.ts');

const launch = JSON.parse(process.argv[2]);
let proc;
let releasing;
let finishing;
let ownerLost = !process.connected;
let terminal;

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
    void finish();
  });
}

if (ownerLost) void finish();
else {
  try {
    proc = spawnWorkerServerCommand(launch);
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
