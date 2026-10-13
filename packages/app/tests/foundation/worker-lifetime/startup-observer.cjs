const cp = require('node:child_process');
const fs = require('node:fs');
const { syncBuiltinESMExports } = require('node:module');
const { identifyAll } = require('./process-identity.cjs');

function install({ eventsPath, runId }) {
  const append = fs.appendFileSync;
  const record = (value) =>
    append(
      eventsPath,
      `${JSON.stringify({ at: Date.now(), pid: process.pid, runId, ...value })}\n`,
    );
  const identity = (pid) => identifyAll([pid], eventsPath, runId)[0];
  const selectedEnvironment = (pairs) =>
    Object.fromEntries(
      pairs
        .filter((pair) => pair.startsWith('OK_TEST_') || pair.startsWith('VITE_PORT='))
        .map((pair) => {
          const separator = pair.indexOf('=');
          return [pair.slice(0, separator), pair.slice(separator + 1)];
        }),
    );
  record({
    event: 'runtime',
    identity: identity(process.pid),
    ppid: process.ppid,
    argv: process.argv,
    cwd: process.cwd(),
    node: process.version,
    environment: selectedEnvironment(
      Object.entries(process.env).map(([key, value]) => `${key}=${value}`),
    ),
  });
  const spawn = cp.ChildProcess.prototype.spawn;
  cp.ChildProcess.prototype.spawn = function (options) {
    const result = spawn.call(this, options);
    if (Number.isInteger(this.pid) && this.pid > 1) {
      record({
        event: 'spawn',
        identity: identity(this.pid),
        command: options.file,
        args: options.args,
        cwd: options.cwd,
        detached: options.detached,
        environment: selectedEnvironment(options.envPairs ?? []),
      });
      this.once('exit', (code, signal) =>
        record({ event: 'child-exit', child: this.pid, code, signal }),
      );
    }
    return result;
  };
  const kill = process.kill;
  process.kill = (pid, signal) => {
    record({ event: 'subject-signal', target: pid, signal });
    return kill.call(process, pid, signal);
  };
  const mkdtemp = fs.mkdtempSync;
  fs.mkdtempSync = (prefix, options) => {
    const path = mkdtemp.call(fs, prefix, options);
    record({ event: 'resource-created', kind: 'directory', path: String(path) });
    return path;
  };
  const open = fs.openSync;
  fs.openSync = (path, flags, mode) => {
    const fd = open.call(fs, path, flags, mode);
    if (String(path).includes('/ok-e2e-') && String(flags).includes('w')) {
      record({ event: 'resource-created', kind: 'file', path: String(path), fd });
    }
    return fd;
  };
  process.on('exit', (code) => record({ event: 'runtime-exit', code }));
  syncBuiltinESMExports();
}

module.exports = { install };
