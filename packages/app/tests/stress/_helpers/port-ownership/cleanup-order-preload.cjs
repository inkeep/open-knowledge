const fs = require('node:fs');
const net = require('node:net');
const { basename } = require('node:path');
const { meet } = require('./cleanup-order-gate.cjs');
const { syncBuiltinESMExports } = require('node:module');

const library = process.env.OK_PORT_OWNERSHIP_SCHEDULE_LIBRARY;
if (library) {
  process.env[process.platform === 'darwin' ? 'DYLD_INSERT_LIBRARIES' : 'LD_PRELOAD'] = library;
}

if (process.env.OK_PORT_OWNERSHIP_CALLER === 'lifetime-owner-loss') {
  const port = Number(process.env.OK_PORT_OWNERSHIP_SCHEDULE_PORT);
  const role = process.argv.some((value) => basename(value) === 'lifetime-server.cjs')
    ? 'server'
    : 'runner';
  const lifetime = net.connect({ port, host: '127.0.0.1' }, () => {
    lifetime.write(`${role}\t${process.pid}\n`);
  });
  lifetime.unref();
  const connect = net.connect;
  net.connect = function (...args) {
    const socket = connect.apply(this, args);
    if (args[0]?.port === Number(process.env.OK_PORT_OWNERSHIP_CONTROL_PORT)) {
      let observed = false;
      const yielding = () => {
        if (observed) return;
        observed = true;
        setImmediate(() => meet('yield'));
      };
      socket.once('end', yielding);
      socket.once('error', yielding);
      socket.once('close', yielding);
    }
    return socket;
  };
  const append = fs.appendFileSync;
  fs.appendFileSync = function (...args) {
    const data = String(args[1]);
    const phase =
      role === 'server' && data.includes('"event":"owner-control-closed"')
        ? 'record'
        : data.includes('"event":"owner-cleanup-error"')
          ? 'error'
          : undefined;
    if (phase) meet(`before-${phase}`);
    try {
      return append.apply(this, args);
    } finally {
      if (phase) meet(`after-${phase}`);
    }
  };
  syncBuiltinESMExports();
}
